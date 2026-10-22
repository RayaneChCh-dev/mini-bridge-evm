const { Contract, Wallet } = require("ethers");
const { abi } = require("../artifacts/contracts/BridgeToken.sol/BridgeToken.json");

/**
 * Mint & burn relayer.
 *
 * On every tick, for every chain:
 *  1. scan    : reads BridgedOut events between the cursor and (head - confirmations) with getLogs,
 *               stores them and moves the cursor forward in the same SQLite transaction.
 *  2. process : for every open operation, checks isProcessed on the destination chain,
 *               then calls bridgeIn if needed.
 *
 * The same code handles live tracking and catch-up after downtime: the relayer always
 * resumes from the last recorded block.
 */
class Relayer {
  /**
   * @param {object} opts
   * @param {Array<{name: string, chainId: number, provider: import("ethers").Provider, address: string, startBlock: number}>} opts.chains
   * @param {string} opts.relayerKey   relayer private key
   * @param {ReturnType<import("./db").openDb>} opts.db
   * @param {number} [opts.confirmations]
   * @param {number} [opts.maxBlockRange]  max size of a getLogs request (sepolia.base.org caps it at 200 blocks)
   * @param {number} [opts.maxAttempts]
   * @param {number} [opts.pollIntervalMs]
   * @param {{info: Function, warn: Function, error: Function}} [opts.logger]
   */
  constructor({ chains, relayerKey, db, confirmations = 5, maxBlockRange = 200, maxAttempts = 5, pollIntervalMs = 12_000, logger = console }) {
    this.db = db;
    this.confirmations = confirmations;
    this.maxBlockRange = maxBlockRange;
    this.maxAttempts = maxAttempts;
    this.pollIntervalMs = pollIntervalMs;
    this.log = logger;
    this.chains = new Map();
    for (const c of chains) {
      const signer = new Wallet(relayerKey, c.provider);
      this.chains.set(Number(c.chainId), {
        ...c,
        chainId: Number(c.chainId),
        reader: new Contract(c.address, abi, c.provider),
        writer: new Contract(c.address, abi, signer),
      });
    }
    this.running = false;
  }

  async start() {
    this.running = true;
    this.log.info(`Relayer started: ${[...this.chains.values()].map((c) => `${c.name} (${c.chainId})`).join(", ")}`);
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        this.log.error(`Error during tick: ${describe(err)}`);
      }
      if (this.running) await new Promise((r) => (this.timer = setTimeout(r, this.pollIntervalMs)));
    }
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }

  async tick() {
    for (const chain of this.chains.values()) await this.scan(chain);
    await this.processOpen();
  }

  /** Records the confirmed BridgedOut events of `chain` since the last processed block. */
  async scan(chain) {
    const head = await chain.provider.getBlockNumber();
    const safeBlock = head - this.confirmations;
    let from = (this.db.getCursor(chain.chainId) ?? chain.startBlock - 1) + 1;

    while (from <= safeBlock) {
      const to = Math.min(from + this.maxBlockRange - 1, safeBlock);
      const events = await chain.reader.queryFilter(chain.reader.filters.BridgedOut(), from, to);
      const ops = events.map((e) => ({
        sourceChainId: chain.chainId,
        nonce: e.args.nonce.toString(),
        destChainId: Number(e.args.destChainId),
        sender: e.args.sender,
        recipient: e.args.recipient,
        amount: e.args.amount.toString(),
        sourceTxHash: e.transactionHash,
        sourceBlock: e.blockNumber,
      }));
      this.db.recordRange(chain.chainId, to, ops);
      for (const op of ops) {
        this.log.info(`[${chain.name}] BridgedOut nonce=${op.nonce} ${op.amount} → ${op.recipient} (chain ${op.destChainId})`);
      }
      from = to + 1;
    }
  }

  /** Tries to finalize every pending or submitted operation. */
  async processOpen() {
    for (const op of this.db.openOps()) await this.processOne(op);
  }

  async processOne(op) {
    const tag = `op ${op.source_chain_id}/${op.nonce}`;
    const dest = this.chains.get(op.dest_chain_id);
    if (!dest) {
      this.db.updateOp(op, { status: "failed", lastError: `destination chain ${op.dest_chain_id} not configured` });
      this.log.error(`${tag}: destination chain ${op.dest_chain_id} not configured`);
      return;
    }

    try {
      // Crash recovery: the mint may already have happened without the database being updated.
      if (await dest.reader.isProcessed(op.source_chain_id, op.nonce)) {
        this.db.updateOp(op, { status: "confirmed" });
        this.log.info(`${tag}: already minted on ${dest.name}, marked confirmed`);
        return;
      }

      const tx = await dest.writer.bridgeIn(op.recipient, op.amount, op.source_chain_id, op.nonce);
      this.db.updateOp(op, { status: "submitted", mintTxHash: tx.hash, attempts: op.attempts + 1 });
      this.log.info(`${tag}: bridgeIn sent on ${dest.name} (${tx.hash})`);

      const receipt = await tx.wait();
      if (receipt.status !== 1) throw new Error(`transaction ${tx.hash} reverted`);
      this.db.updateOp(op, { status: "confirmed", mintTxHash: tx.hash, attempts: op.attempts + 1 });
      this.log.info(`${tag}: mint confirmed on ${dest.name} (block ${receipt.blockNumber})`);
    } catch (err) {
      if (isAlreadyProcessed(err, dest.reader)) {
        this.db.updateOp(op, { status: "confirmed" });
        this.log.info(`${tag}: AlreadyProcessed, already minted — marked confirmed`);
        return;
      }
      const attempts = op.attempts + 1;
      const status = attempts >= this.maxAttempts ? "failed" : "pending";
      const message = describe(err);
      this.db.updateOp(op, { status, attempts, lastError: message });
      this.log.warn(`${tag}: failed (attempt ${attempts}/${this.maxAttempts}): ${message}`);
    }
  }
}

/** Readable error message: RPCs often hide the real cause in the response body. */
function describe(err) {
  const body = err?.info?.responseBody;
  if (body) {
    try {
      const rpcMessage = JSON.parse(body).error?.message;
      if (rpcMessage) return `${err.shortMessage} (${rpcMessage})`;
    } catch {
      /* non-JSON body */
    }
  }
  return err?.shortMessage || err?.message || String(err);
}

function isAlreadyProcessed(err, contract) {
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  if (typeof data === "string" && data.length >= 10) {
    try {
      return contract.interface.parseError(data)?.name === "AlreadyProcessed";
    } catch {
      /* undecodable revert data */
    }
  }
  return err?.revert?.name === "AlreadyProcessed";
}

module.exports = { Relayer };

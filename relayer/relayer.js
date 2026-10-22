const { Contract, Wallet } = require("ethers");
const { abi } = require("../artifacts/contracts/BridgeToken.sol/BridgeToken.json");

/**
 * Relayer mint & burn.
 *
 * À chaque tick, pour chaque chaîne :
 *  1. scan    : lit les events BridgedOut entre le curseur et (tête - confirmations) avec getLogs,
 *               les enregistre en base et avance le curseur dans la même transaction SQLite.
 *  2. process : pour chaque opération ouverte, vérifie isProcessed sur la chaîne destination
 *               puis appelle bridgeIn si nécessaire.
 *
 * Le même code sert au suivi en direct et au rattrapage après un arrêt : le relayer reprend
 * toujours depuis le dernier bloc enregistré.
 */
class Relayer {
  /**
   * @param {object} opts
   * @param {Array<{name: string, chainId: number, provider: import("ethers").Provider, address: string, startBlock: number}>} opts.chains
   * @param {string} opts.relayerKey   clé privée du relayer
   * @param {ReturnType<import("./db").openDb>} opts.db
   * @param {number} [opts.confirmations]
   * @param {number} [opts.maxBlockRange]  taille max d'une requête getLogs (sepolia.base.org la limite à 200 blocs)
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
    this.log.info(`Relayer démarré : ${[...this.chains.values()].map((c) => `${c.name} (${c.chainId})`).join(", ")}`);
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        this.log.error(`Erreur pendant le tick : ${describe(err)}`);
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

  /** Enregistre les BridgedOut confirmés de `chain` depuis le dernier bloc traité. */
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
        this.log.info(`[${chain.name}] BridgedOut nonce=${op.nonce} ${op.amount} → ${op.recipient} (chaîne ${op.destChainId})`);
      }
      from = to + 1;
    }
  }

  /** Tente de finaliser toutes les opérations en attente ou soumises. */
  async processOpen() {
    for (const op of this.db.openOps()) await this.processOne(op);
  }

  async processOne(op) {
    const tag = `op ${op.source_chain_id}/${op.nonce}`;
    const dest = this.chains.get(op.dest_chain_id);
    if (!dest) {
      this.db.updateOp(op, { status: "failed", lastError: `chaîne destination ${op.dest_chain_id} non configurée` });
      this.log.error(`${tag} : chaîne destination ${op.dest_chain_id} non configurée`);
      return;
    }

    try {
      // Reprise après crash : le mint a peut-être déjà eu lieu sans que la base ait été mise à jour.
      if (await dest.reader.isProcessed(op.source_chain_id, op.nonce)) {
        this.db.updateOp(op, { status: "confirmed" });
        this.log.info(`${tag} : déjà mintée sur ${dest.name}, marquée confirmée`);
        return;
      }

      const tx = await dest.writer.bridgeIn(op.recipient, op.amount, op.source_chain_id, op.nonce);
      this.db.updateOp(op, { status: "submitted", mintTxHash: tx.hash, attempts: op.attempts + 1 });
      this.log.info(`${tag} : bridgeIn envoyé sur ${dest.name} (${tx.hash})`);

      const receipt = await tx.wait();
      if (receipt.status !== 1) throw new Error(`transaction ${tx.hash} revert`);
      this.db.updateOp(op, { status: "confirmed", mintTxHash: tx.hash, attempts: op.attempts + 1 });
      this.log.info(`${tag} : mint confirmé sur ${dest.name} (bloc ${receipt.blockNumber})`);
    } catch (err) {
      if (isAlreadyProcessed(err, dest.reader)) {
        this.db.updateOp(op, { status: "confirmed" });
        this.log.info(`${tag} : AlreadyProcessed, déjà mintée — marquée confirmée`);
        return;
      }
      const attempts = op.attempts + 1;
      const status = attempts >= this.maxAttempts ? "failed" : "pending";
      const message = describe(err);
      this.db.updateOp(op, { status, attempts, lastError: message });
      this.log.warn(`${tag} : échec (tentative ${attempts}/${this.maxAttempts}) : ${message}`);
    }
  }
}

/** Message d'erreur lisible : les RPC cachent souvent la vraie cause dans le corps de la réponse. */
function describe(err) {
  const body = err?.info?.responseBody;
  if (body) {
    try {
      const rpcMessage = JSON.parse(body).error?.message;
      if (rpcMessage) return `${err.shortMessage} (${rpcMessage})`;
    } catch {
      /* corps non JSON */
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
      /* données de revert non décodables */
    }
  }
  return err?.revert?.name === "AlreadyProcessed";
}

module.exports = { Relayer };

// Relayer integration test: two local Hardhat nodes simulate two chains
// (chainIds 31337 and 31338); the relayer runs against a temporary SQLite database.
// Run with: npm run test:relayer
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ContractFactory, HDNodeWallet, JsonRpcProvider, Mnemonic, Network, parseEther } = require("ethers");
const { abi, bytecode } = require("../../artifacts/contracts/BridgeToken.sol/BridgeToken.json");
const { openDb } = require("../db");
const { Relayer } = require("../relayer");

const ROOT = path.join(__dirname, "..", "..");
const CONFIRMATIONS = 3;
const MNEMONIC = Mnemonic.fromPhrase("test test test test test test test test test test test junk");
const account = (i) => HDNodeWallet.fromMnemonic(MNEMONIC, `m/44'/60'/0'/0/${i}`);
const owner = account(0);
const relayerWallet = account(1);
const alice = account(2);
const bob = account(3);
const silent = { info() {}, warn() {}, error() {} };

const nodes = [];
let chainA, chainB, dbDir;

function startNode(port, chainId) {
  return new Promise((resolve, reject) => {
    // detached: the node gets its own process group, killed as a whole in after()
    const proc = spawn(path.join(ROOT, "node_modules", ".bin", "hardhat"), ["node", "--port", String(port)], {
      cwd: ROOT,
      detached: true,
      env: { ...process.env, HARDHAT_CHAIN_ID: String(chainId) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    nodes.push(proc);
    const timeout = setTimeout(() => reject(new Error(`node ${port}: startup took too long`)), 60_000);
    proc.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("Started HTTP")) {
        clearTimeout(timeout);
        resolve(new JsonRpcProvider(`http://127.0.0.1:${port}`, Network.from(chainId), { staticNetwork: true, pollingInterval: 50, cacheTimeout: -1 }));
      }
    });
    proc.on("exit", (code) => code && reject(new Error(`node ${port} exited (code ${code})`)));
  });
}

async function deploy(provider, chainId, peerChainId, supply) {
  const signer = owner.connect(provider);
  const token = await new ContractFactory(abi, bytecode, signer).deploy(relayerWallet.address, supply);
  const receipt = await token.deploymentTransaction().wait();
  await (await token.setSupportedChain(peerChainId, true)).wait();
  return { name: `local-${chainId}`, chainId, provider, address: await token.getAddress(), startBlock: receipt.blockNumber, token };
}

const mine = (chain, n) => chain.provider.send("hardhat_mine", [`0x${n.toString(16)}`]);
const tokenAs = (chain, wallet) => chain.token.connect(wallet.connect(chain.provider));

function newRelayer(dbFile) {
  const db = openDb(dbFile);
  const relayer = new Relayer({
    chains: [chainA, chainB],
    db,
    relayerKey: relayerWallet.privateKey,
    confirmations: CONFIRMATIONS,
    maxBlockRange: 4, // small ranges to exercise getLogs chunking
    logger: silent,
  });
  return { db, relayer };
}

async function bridgeOut(chain, from, amount, dest, to) {
  const tx = await tokenAs(chain, from).bridgeOut(amount, dest.chainId, to.address);
  await tx.wait();
}

before(async () => {
  const [pA, pB] = await Promise.all([startNode(8645, 31337), startNode(8646, 31338)]);
  chainA = await deploy(pA, 31337, 31338, parseEther("1000"));
  chainB = await deploy(pB, 31338, 31337, 0n);
  await (await tokenAs(chainA, owner).transfer(alice.address, parseEther("100"))).wait();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayer-test-"));
});

after(() => {
  for (const chain of [chainA, chainB]) chain?.provider.destroy();
  for (const p of nodes) {
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {
      /* already stopped */
    }
  }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

test("A → B: waits for N confirmations, then mints the burned amount", async () => {
  const { db, relayer } = newRelayer(path.join(dbDir, "t1.sqlite"));
  await bridgeOut(chainA, alice, parseEther("10"), chainB, bob);

  await relayer.tick();
  assert.equal(await chainB.token.balanceOf(bob.address), 0n, "must not mint before the confirmations");

  await mine(chainA, CONFIRMATIONS);
  await relayer.tick();
  assert.equal(await chainB.token.balanceOf(bob.address), parseEther("10"));
  assert.equal(await chainA.token.balanceOf(alice.address), parseEther("90"));

  const op = db.getOp(31337, 0);
  assert.equal(op.status, "confirmed");
  assert.match(op.mint_tx_hash, /^0x[0-9a-f]{64}$/);

  // one more tick mints nothing again
  await relayer.tick();
  assert.equal(await chainB.token.balanceOf(bob.address), parseEther("10"));
  db.close();
});

test("B → A: the way back works and the total supply is preserved", async () => {
  const { db, relayer } = newRelayer(path.join(dbDir, "t1.sqlite"));
  await bridgeOut(chainB, bob, parseEther("4"), chainA, alice);
  await mine(chainB, CONFIRMATIONS);
  await relayer.tick();

  assert.equal(await chainA.token.balanceOf(alice.address), parseEther("94"));
  assert.equal(await chainB.token.balanceOf(bob.address), parseEther("6"));
  const total = (await chainA.token.totalSupply()) + (await chainB.token.totalSupply());
  assert.equal(total, parseEther("1000"));
  assert.equal(db.getOp(31338, 0).status, "confirmed");
  db.close();
});

test("restart: catches up on burns made during downtime, without double minting", async () => {
  const dbFile = path.join(dbDir, "t1.sqlite");
  const before = await chainB.token.balanceOf(bob.address);

  // relayer stopped: three burns across several blocks
  for (let i = 0; i < 3; i++) {
    await bridgeOut(chainA, alice, parseEther("1"), chainB, bob);
    await mine(chainA, 5);
  }
  await mine(chainA, CONFIRMATIONS);

  const { db, relayer } = newRelayer(dbFile);
  await relayer.tick();
  assert.equal(await chainB.token.balanceOf(bob.address), before + parseEther("3"));
  for (const nonce of [1, 2, 3]) assert.equal(db.getOp(31337, nonce).status, "confirmed");

  await relayer.tick();
  assert.equal(await chainB.token.balanceOf(bob.address), before + parseEther("3"));
  db.close();
});

test("crash after sending the mint but before updating the database: no double mint", async () => {
  const { db, relayer } = newRelayer(path.join(dbDir, "t1.sqlite"));
  await bridgeOut(chainA, alice, parseEther("2"), chainB, bob);
  await mine(chainA, CONFIRMATIONS);

  // the operation is seen (pending in the database)…
  await relayer.scan(relayer.chains.get(31337));
  const op = db.getOp(31337, 4);
  assert.equal(op.status, "pending");

  // …then the mint is sent, but the relayer "crashes" before recording the result
  const balance = await chainB.token.balanceOf(bob.address);
  await (await tokenAs(chainB, relayerWallet).bridgeIn(op.recipient, op.amount, op.source_chain_id, op.nonce)).wait();

  await relayer.processOpen();
  assert.equal(db.getOp(31337, 4).status, "confirmed");
  assert.equal(await chainB.token.balanceOf(bob.address), balance + parseEther("2"));
  db.close();
});

test("an AlreadyProcessed revert is treated as a success", async () => {
  const { db, relayer } = newRelayer(path.join(dbDir, "t1.sqlite"));
  await bridgeOut(chainA, alice, parseEther("1"), chainB, bob);
  await mine(chainA, CONFIRMATIONS);
  await relayer.scan(relayer.chains.get(31337));
  const op = db.getOp(31337, 5);

  // the mint happens between the isProcessed check and the send: we bypass isProcessed
  const dest = relayer.chains.get(31338);
  await (await tokenAs(chainB, relayerWallet).bridgeIn(op.recipient, op.amount, op.source_chain_id, op.nonce)).wait();
  const realReader = dest.reader;
  dest.reader = new Proxy(realReader, { get: (t, k) => (k === "isProcessed" ? async () => false : t[k]) });
  try {
    await relayer.processOne(op);
  } finally {
    dest.reader = realReader;
  }
  const after = db.getOp(31337, 5);
  assert.equal(after.status, "confirmed");
  assert.equal(after.last_error, null);
  db.close();
});

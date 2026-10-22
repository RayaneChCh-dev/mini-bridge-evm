// Entry point: runs the relayer between the deployed chains (deployments/*.json).
// Usage: npm run relayer                   (all deployed chains)
//        node relayer/index.js --status    (prints the operation history)
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Network } = require("ethers");
const { openDb } = require("./db");
const { Relayer } = require("./relayer");

const RPC_URLS = {
  sepolia: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
  baseSepolia: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
};

const dbPath = process.env.RELAYER_DB || path.join(__dirname, "relayer.sqlite");
const db = openDb(dbPath);

if (process.argv.includes("--status")) {
  console.table(
    db.allOps().map((o) => ({
      source: o.source_chain_id,
      nonce: o.nonce,
      dest: o.dest_chain_id,
      recipient: o.recipient,
      amount: o.amount,
      status: o.status,
      attempts: o.attempts,
      mint_tx: o.mint_tx_hash,
      error: o.last_error,
    }))
  );
  process.exit(0);
}

if (!process.env.RELAYER_PRIVATE_KEY) throw new Error("RELAYER_PRIVATE_KEY missing from .env");

const deploymentsDir = path.join(__dirname, "..", "deployments");
const chains = fs
  .readdirSync(deploymentsDir)
  .filter((f) => f.endsWith(".json") && !f.endsWith(".local.json"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(deploymentsDir, f), "utf8")))
  .map((d) => {
    const url = RPC_URLS[d.network];
    if (!url) throw new Error(`No RPC URL for network ${d.network}`);
    return {
      name: d.network,
      chainId: d.chainId,
      address: d.address,
      startBlock: d.deployBlock,
      // cacheTimeout: -1 disables ethers' request cache (250 ms by default), which can
      // return a stale account nonce when two bridgeIn calls follow each other.
      provider: new JsonRpcProvider(url, Network.from(d.chainId), { staticNetwork: true, cacheTimeout: -1 }),
    };
  });
if (chains.length < 2) throw new Error("At least two deployments are needed in deployments/ (run the deploy:* scripts)");

const relayer = new Relayer({
  chains,
  db,
  relayerKey: process.env.RELAYER_PRIVATE_KEY,
  confirmations: Number(process.env.CONFIRMATIONS || 5),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 12_000),
  maxBlockRange: Number(process.env.MAX_BLOCK_RANGE || 200),
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log("Stopping relayer…");
    relayer.stop();
  });
}
relayer.start().finally(() => db.close());

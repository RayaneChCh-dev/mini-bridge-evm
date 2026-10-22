// Point d'entrée : lance le relayer entre les chaînes déployées (deployments/*.json).
// Usage : npm run relayer            (toutes les chaînes déployées)
//         node relayer/index.js --status   (affiche l'historique des opérations)
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
      destinataire: o.recipient,
      montant: o.amount,
      statut: o.status,
      essais: o.attempts,
      mint_tx: o.mint_tx_hash,
      erreur: o.last_error,
    }))
  );
  process.exit(0);
}

if (!process.env.RELAYER_PRIVATE_KEY) throw new Error("RELAYER_PRIVATE_KEY manquant dans .env");

const deploymentsDir = path.join(__dirname, "..", "deployments");
const chains = fs
  .readdirSync(deploymentsDir)
  .filter((f) => f.endsWith(".json") && !f.endsWith(".local.json"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(deploymentsDir, f), "utf8")))
  .map((d) => {
    const url = RPC_URLS[d.network];
    if (!url) throw new Error(`Pas d'URL RPC pour le réseau ${d.network}`);
    return {
      name: d.network,
      chainId: d.chainId,
      address: d.address,
      startBlock: d.deployBlock,
      // cacheTimeout: -1 désactive le cache de requêtes d'ethers (250 ms par défaut), qui peut
      // renvoyer un nonce de compte périmé quand deux bridgeIn s'enchaînent.
      provider: new JsonRpcProvider(url, Network.from(d.chainId), { staticNetwork: true, cacheTimeout: -1 }),
    };
  });
if (chains.length < 2) throw new Error("Il faut au moins deux déploiements dans deployments/ (lance les scripts deploy:*)");

const relayer = new Relayer({
  chains,
  db,
  relayerKey: process.env.RELAYER_PRIVATE_KEY,
  confirmations: Number(process.env.CONFIRMATIONS || 5),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 12_000),
  maxBlockRange: Number(process.env.MAX_BLOCK_RANGE || 500),
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log("Arrêt du relayer…");
    relayer.stop();
  });
}
relayer.start().finally(() => db.close());

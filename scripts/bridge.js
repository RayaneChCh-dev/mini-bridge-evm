// Lance un transfert de BRT d'une chaîne à l'autre (appel de bridgeOut depuis le wallet deployer).
// Usage : node scripts/bridge.js <sepolia|baseSepolia> <montant> [destinataire]
//   node scripts/bridge.js sepolia 10            → 10 BRT de Sepolia vers Base Sepolia, au deployer
//   node scripts/bridge.js baseSepolia 4 0xabc…  → 4 BRT de Base Sepolia vers Sepolia, à 0xabc…
//   node scripts/bridge.js                       → soldes BRT sur les deux chaînes
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Wallet, Contract, parseEther, formatEther, isAddress } = require("ethers");
const { abi } = require("../artifacts/contracts/BridgeToken.sol/BridgeToken.json");

const NETWORKS = {
  sepolia: {
    rpc: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
  },
  baseSepolia: {
    rpc: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
  },
};

function load(network) {
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`${network} non déployé (deployments/${network}.json manquant)`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const provider = new JsonRpcProvider(NETWORKS[network].rpc, d.chainId, { staticNetwork: true, cacheTimeout: -1 });
  const wallet = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  return { ...d, ...NETWORKS[network], provider, wallet, token: new Contract(d.address, abi, wallet) };
}

let chains = [];

async function main() {
  const [from, amount, recipientArg] = process.argv.slice(2);
  chains = Object.keys(NETWORKS).map(load);
  const holder = recipientArg || chains[0].wallet.address;

  if (from) {
    if (!NETWORKS[from]) throw new Error(`chaîne inconnue : ${from} (sepolia | baseSepolia)`);
    if (!amount) throw new Error("montant manquant");
    if (recipientArg && !isAddress(recipientArg)) throw new Error(`adresse invalide : ${recipientArg}`);
    const src = chains.find((c) => c.network === from);
    const dest = chains.find((c) => c.network !== from);

    const tx = await src.token.bridgeOut(parseEther(amount), dest.chainId, holder);
    console.log(`bridgeOut ${amount} BRT ${src.network} → ${dest.network} pour ${holder}`);
    console.log(`  ${src.explorer}/tx/${tx.hash}`);
    const receipt = await tx.wait();
    const event = receipt.logs.map((l) => src.token.interface.parseLog(l)).find((e) => e?.name === "BridgedOut");
    console.log(`  confirmé au bloc ${receipt.blockNumber}, nonce ${event.args.nonce} — le relayer mintera après ses confirmations`);
  }

  for (const c of chains) {
    console.log(`${c.network.padEnd(12)} ${formatEther(await c.token.balanceOf(holder)).padStart(12)} BRT  (supply ${formatEther(await c.token.totalSupply())})`);
  }
}

main()
  .catch((e) => {
    console.error(e.shortMessage || e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const c of chains) c.provider.destroy();
  });

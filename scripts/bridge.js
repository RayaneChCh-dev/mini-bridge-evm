// Starts a BRT transfer from one chain to the other (calls bridgeOut from the deployer wallet).
// Usage: node scripts/bridge.js <sepolia|baseSepolia> <amount> [recipient]
//   node scripts/bridge.js sepolia 10            → 10 BRT from Sepolia to Base Sepolia, to the deployer
//   node scripts/bridge.js baseSepolia 4 0xabc…  → 4 BRT from Base Sepolia to Sepolia, to 0xabc…
//   node scripts/bridge.js                       → BRT balances on both chains
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
  if (!fs.existsSync(file)) throw new Error(`${network} not deployed (deployments/${network}.json missing)`);
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
    if (!NETWORKS[from]) throw new Error(`unknown chain: ${from} (sepolia | baseSepolia)`);
    if (!amount) throw new Error("missing amount");
    if (recipientArg && !isAddress(recipientArg)) throw new Error(`invalid address: ${recipientArg}`);
    const src = chains.find((c) => c.network === from);
    const dest = chains.find((c) => c.network !== from);

    const tx = await src.token.bridgeOut(parseEther(amount), dest.chainId, holder);
    console.log(`bridgeOut ${amount} BRT ${src.network} → ${dest.network} for ${holder}`);
    console.log(`  ${src.explorer}/tx/${tx.hash}`);
    const receipt = await tx.wait();
    const event = receipt.logs.map((l) => src.token.interface.parseLog(l)).find((e) => e?.name === "BridgedOut");
    console.log(`  confirmed in block ${receipt.blockNumber}, nonce ${event.args.nonce} — the relayer will mint after its confirmations`);
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

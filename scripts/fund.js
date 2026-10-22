// Répartit l'ETH de test du deployer. N'affiche jamais les clés.
//   node scripts/fund.js sepolia : 0.01 ETH → relayer sur Sepolia, puis dépôt de 0.02 ETH vers Base Sepolia
//                                  via le bridge officiel de Base (arrive sur la même adresse en quelques minutes)
//   node scripts/fund.js base    : 0.008 ETH → relayer sur Base Sepolia
//   node scripts/fund.js         : affiche seulement les soldes
require("dotenv").config();
const { JsonRpcProvider, Wallet, Contract, parseEther, formatEther } = require("ethers");

// L1StandardBridge de Base Sepolia, déployé sur Sepolia. Vérifié on-chain :
// OTHER_BRIDGE() du L2StandardBridge (0x4200…0010) sur Base Sepolia renvoie cette adresse, et inversement.
const BASE_L1_BRIDGE = "0xfd0Bf71F60660E2f608ed56e1659C450eB113120";

const opts = { cacheTimeout: -1 };
const sepolia = new JsonRpcProvider(process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com", 11155111, opts);
const base = new JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org", 84532, opts);
const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
const relayerAddress = new Wallet(process.env.RELAYER_PRIVATE_KEY).address;

async function balances() {
  const deployerAddress = new Wallet(deployerKey).address;
  for (const [name, p] of [["Sepolia", sepolia], ["Base Sepolia", base]]) {
    const [d, r] = await Promise.all([p.getBalance(deployerAddress), p.getBalance(relayerAddress)]);
    console.log(`${name.padEnd(13)} deployer ${formatEther(d).padEnd(22)} relayer ${formatEther(r)}`);
  }
}

async function send(provider, label, value) {
  const wallet = new Wallet(deployerKey, provider);
  if ((await provider.getBalance(wallet.address)) < parseEther(value)) {
    throw new Error(`${label} : solde du deployer insuffisant pour envoyer ${value} ETH (dépôt pas encore arrivé ?)`);
  }
  const tx = await wallet.sendTransaction({ to: relayerAddress, value: parseEther(value) });
  console.log(`${label} : ${value} ETH → relayer (${tx.hash})`);
  await tx.wait();
}

async function main() {
  const mode = process.argv[2];
  if (mode === "sepolia") {
    await send(sepolia, "Sepolia", "0.01");
    const bridge = new Contract(BASE_L1_BRIDGE, ["function depositETH(uint32, bytes) payable"], new Wallet(deployerKey, sepolia));
    const tx = await bridge.depositETH(200_000, "0x", { value: parseEther("0.02") });
    console.log(`Sepolia → Base Sepolia : dépôt de 0.02 ETH (${tx.hash})`);
    await tx.wait();
    console.log("Dépôt confirmé sur Sepolia ; arrivée sur Base Sepolia dans 1 à 5 minutes.");
  } else if (mode === "base") {
    await send(base, "Base Sepolia", "0.008");
  } else if (mode) {
    throw new Error(`mode inconnu : ${mode} (sepolia | base)`);
  }
  await balances();
}

main()
  .catch((e) => {
    console.error(e.shortMessage || e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    sepolia.destroy();
    base.destroy();
  });

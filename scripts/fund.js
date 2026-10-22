// Splits the deployer's test ETH. Never prints keys.
//   node scripts/fund.js sepolia : 0.01 ETH → relayer on Sepolia, then a 0.02 ETH deposit to Base Sepolia
//                                  through Base's official bridge (arrives at the same address within minutes)
//   node scripts/fund.js base    : 0.008 ETH → relayer on Base Sepolia
//   node scripts/fund.js         : prints balances only
require("dotenv").config();
const { JsonRpcProvider, Wallet, Contract, parseEther, formatEther } = require("ethers");

// Base Sepolia's L1StandardBridge, deployed on Sepolia. Verified on-chain:
// OTHER_BRIDGE() of the L2StandardBridge (0x4200…0010) on Base Sepolia returns this address, and vice versa.
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
    throw new Error(`${label}: deployer balance too low to send ${value} ETH (deposit not arrived yet?)`);
  }
  const tx = await wallet.sendTransaction({ to: relayerAddress, value: parseEther(value) });
  console.log(`${label}: ${value} ETH → relayer (${tx.hash})`);
  await tx.wait();
}

async function main() {
  const mode = process.argv[2];
  if (mode === "sepolia") {
    await send(sepolia, "Sepolia", "0.01");
    const bridge = new Contract(BASE_L1_BRIDGE, ["function depositETH(uint32, bytes) payable"], new Wallet(deployerKey, sepolia));
    const tx = await bridge.depositETH(200_000, "0x", { value: parseEther("0.02") });
    console.log(`Sepolia → Base Sepolia: 0.02 ETH deposit (${tx.hash})`);
    await tx.wait();
    console.log("Deposit confirmed on Sepolia; it lands on Base Sepolia within 1 to 5 minutes.");
  } else if (mode === "base") {
    await send(base, "Base Sepolia", "0.008");
  } else if (mode) {
    throw new Error(`unknown mode: ${mode} (sepolia | base)`);
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

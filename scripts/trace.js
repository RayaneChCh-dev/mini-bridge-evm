// Traces a bridge transfer on both chains from a single transaction hash: the burn or the mint.
// Read-only: no private key needed.
// Usage: node scripts/trace.js <txHash>
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Network, Contract, formatEther } = require("ethers");
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
// sepolia.base.org rejects getLogs requests over 200 blocks
const MAX_BLOCK_RANGE = Number(process.env.MAX_BLOCK_RANGE || 200);

function load(network) {
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`${network} not deployed (deployments/${network}.json missing)`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const provider = new JsonRpcProvider(NETWORKS[network].rpc, Network.from(d.chainId), { staticNetwork: true });
  return { ...d, ...NETWORKS[network], provider, token: new Contract(d.address, abi, provider) };
}

let chains = [];

/** First block of `chain` whose timestamp is >= `timestamp` (binary search from the deployment block). */
async function blockAt(chain, timestamp) {
  let lo = chain.deployBlock;
  let hi = await chain.provider.getBlockNumber();
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await chain.provider.getBlock(mid)).timestamp < timestamp) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Walks `chain` from `start` (forward or backward) in MAX_BLOCK_RANGE windows until an event passes `match`. */
async function findEvent(chain, filter, start, forward, match) {
  const head = await chain.provider.getBlockNumber();
  let from = start;
  while (forward ? from <= head : from >= chain.deployBlock) {
    const lo = forward ? from : Math.max(from - MAX_BLOCK_RANGE + 1, chain.deployBlock);
    const hi = forward ? Math.min(from + MAX_BLOCK_RANGE - 1, head) : from;
    const found = (await chain.token.queryFilter(filter, lo, hi)).find(match);
    if (found) return found;
    from = forward ? hi + 1 : lo - 1;
  }
  return null;
}

/** BridgedOut / BridgedIn events emitted by the BridgeToken of `chain` in a receipt. */
function bridgeEvents(chain, receipt) {
  return receipt.logs
    .filter((l) => l.address.toLowerCase() === chain.address.toLowerCase())
    .map((l) => chain.token.interface.parseLog(l))
    .filter((e) => e?.name === "BridgedOut" || e?.name === "BridgedIn");
}

async function printStep(label, chain, txHash, blockNumber) {
  const { timestamp } = await chain.provider.getBlock(blockNumber);
  console.log(`${label.padEnd(5)} ${chain.network.padEnd(12)} block ${blockNumber}  ${new Date(timestamp * 1000).toISOString()}`);
  console.log(`      ${chain.explorer}/tx/${txHash}`);
  return timestamp;
}

async function main() {
  const hash = process.argv[2];
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash || "")) throw new Error("usage: node scripts/trace.js <txHash>");
  chains = Object.keys(NETWORKS).map(load);

  let chain, receipt;
  for (const c of chains) {
    receipt = await c.provider.getTransactionReceipt(hash);
    if (receipt) {
      chain = c;
      break;
    }
  }
  if (!receipt) throw new Error(`transaction ${hash} not found on ${chains.map((c) => c.network).join(" or ")}`);

  const event = bridgeEvents(chain, receipt)[0];
  if (!event) throw new Error(`transaction ${hash} on ${chain.network} is neither a bridgeOut nor a bridgeIn of BridgeToken`);
  const { timestamp } = await chain.provider.getBlock(receipt.blockNumber);

  // Normalize to (source, burn) and (dest, mint), whichever side the hash belongs to.
  let src, dest, burn, mint;
  if (event.name === "BridgedOut") {
    src = chain;
    burn = { hash, blockNumber: receipt.blockNumber, args: event.args };
    dest = chains.find((c) => c.chainId === Number(event.args.destChainId));
    if (!dest) throw new Error(`destination chain ${event.args.destChainId} has no deployment in deployments/`);
    if (await dest.token.isProcessed(src.chainId, event.args.nonce)) {
      const filter = dest.token.filters.BridgedIn(event.args.recipient, null, null, event.args.nonce);
      const start = await blockAt(dest, timestamp);
      const found = await findEvent(dest, filter, start, true, (e) => Number(e.args.sourceChainId) === src.chainId);
      if (found) mint = { hash: found.transactionHash, blockNumber: found.blockNumber };
    }
  } else {
    dest = chain;
    mint = { hash, blockNumber: receipt.blockNumber };
    src = chains.find((c) => c.chainId === Number(event.args.sourceChainId));
    if (!src) throw new Error(`source chain ${event.args.sourceChainId} has no deployment in deployments/`);
    const filter = src.token.filters.BridgedOut(null, event.args.recipient, null, null, null, event.args.nonce);
    const start = await blockAt(src, timestamp);
    const found = await findEvent(src, filter, start, false, (e) => Number(e.args.destChainId) === dest.chainId);
    if (found) burn = { hash: found.transactionHash, blockNumber: found.blockNumber, args: found.args };
  }

  if (burn) {
    const { sender, recipient, amount, nonce } = burn.args;
    console.log(`op ${src.chainId}/${nonce}: ${formatEther(amount)} BRT ${src.network} → ${dest.network}`);
    console.log(`      ${sender} → ${recipient}`);
  }
  const burnTime = burn ? await printStep("Burn", src, burn.hash, burn.blockNumber) : null;
  if (!burn) console.log(`Burn  ${src.network.padEnd(12)} not found: a mint without a matching burn (investigate the relayer)`);
  if (mint) {
    const mintTime = await printStep("Mint", dest, mint.hash, mint.blockNumber);
    if (burnTime) console.log(`      ${mintTime - burnTime} s after the burn`);
  } else {
    console.log(`Mint  ${dest.network.padEnd(12)} not done yet: the relayer waits for its confirmations, or is stopped`);
    console.log(`      check with: npm run relayer:status`);
  }

  const supplies = await Promise.all(chains.map((c) => c.token.totalSupply()));
  const total = supplies.reduce((a, b) => a + b, 0n);
  console.log(`Supply ${chains.map((c, i) => `${c.network} ${formatEther(supplies[i])}`).join(" + ")} = ${formatEther(total)} BRT`);
}

main()
  .catch((e) => {
    console.error(e.shortMessage || e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const c of chains) c.provider.destroy();
  });

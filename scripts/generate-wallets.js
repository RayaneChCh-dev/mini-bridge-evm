// Generates the project's two dedicated wallets (deployer/owner and relayer) into .env.
// Never prints private keys, only the addresses to fund from faucets.
const fs = require("fs");
const path = require("path");
const { Wallet } = require("ethers");

const envPath = path.join(__dirname, "..", ".env");
let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : fs.readFileSync(envPath + ".example", "utf8");

function ensureKey(name) {
  const match = env.match(new RegExp(`^${name}=(0x[0-9a-fA-F]{64})\\s*$`, "m"));
  if (match) return new Wallet(match[1]);
  const wallet = Wallet.createRandom();
  const line = `${name}=${wallet.privateKey}`;
  env = new RegExp(`^${name}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${name}=.*$`, "m"), line) : `${env.trimEnd()}\n${line}\n`;
  return wallet;
}

const deployer = ensureKey("DEPLOYER_PRIVATE_KEY");
const relayer = ensureKey("RELAYER_PRIVATE_KEY");
fs.writeFileSync(envPath, env, { mode: 0o600 });

console.log("Deployer / owner :", deployer.address);
console.log("Relayer          :", relayer.address);
console.log("\nFund these two addresses with test ETH on Sepolia and Base Sepolia.");

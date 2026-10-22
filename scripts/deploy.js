// Déploie BridgeToken sur le réseau courant et enregistre l'adresse dans deployments/<network>.json.
// Usage : npx hardhat run scripts/deploy.js --network sepolia
//   INITIAL_SUPPLY (en tokens, défaut 0) : à renseigner uniquement sur la chaîne d'origine.
//   PEER_CHAIN_IDS : chainIds acceptés pour bridgeOut/bridgeIn, séparés par des virgules.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const relayerKey = process.env.RELAYER_PRIVATE_KEY;
  if (!relayerKey) throw new Error("RELAYER_PRIVATE_KEY manquant dans .env (lance `npm run wallets`)");
  const relayerAddress = new ethers.Wallet(relayerKey).address;

  const initialSupply = ethers.parseEther(process.env.INITIAL_SUPPLY || "0");
  const peers = (process.env.PEER_CHAIN_IDS || "").split(",").filter(Boolean).map(BigInt);

  const [deployer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  console.log(`Déploiement sur ${network.name} (${chainId}) depuis ${deployer.address}`);

  const token = await ethers.deployContract("BridgeToken", [relayerAddress, initialSupply]);
  await token.waitForDeployment();
  const deployTx = token.deploymentTransaction();
  const receipt = await deployTx.wait();

  for (const peer of peers) {
    await (await token.setSupportedChain(peer, true)).wait();
    console.log(`Chaîne ${peer} autorisée`);
  }

  const out = {
    network: network.name,
    chainId: Number(chainId),
    address: await token.getAddress(),
    relayer: relayerAddress,
    owner: deployer.address,
    initialSupply: initialSupply.toString(),
    peers: peers.map(Number),
    deployBlock: receipt.blockNumber,
    txHash: deployTx.hash,
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(out, null, 2) + "\n");
  console.log("BridgeToken déployé :", out.address);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

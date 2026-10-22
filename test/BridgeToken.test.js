const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const SUPPLY = ethers.parseEther("1000000");
const OTHER_CHAIN = 84532n; // Base Sepolia

describe("BridgeToken", function () {
  async function deployFixture() {
    const [owner, relayer, alice, bob, attacker] = await ethers.getSigners();
    const token = await ethers.deployContract("BridgeToken", [relayer.address, SUPPLY]);
    await token.setSupportedChain(OTHER_CHAIN, true);
    await token.transfer(alice.address, ethers.parseEther("100"));
    const { chainId } = await ethers.provider.getNetwork();
    return { token, owner, relayer, alice, bob, attacker, chainId };
  }

  describe("deployment", function () {
    it("mints the initial supply to the owner and records the relayer", async function () {
      const { token, owner, relayer } = await loadFixture(deployFixture);
      expect(await token.totalSupply()).to.equal(SUPPLY);
      expect(await token.owner()).to.equal(owner.address);
      expect(await token.relayer()).to.equal(relayer.address);
    });

    it("rejects a zero-address relayer", async function () {
      const factory = await ethers.getContractFactory("BridgeToken");
      await expect(factory.deploy(ethers.ZeroAddress, 0)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });
  });

  describe("bridgeOut", function () {
    it("burns the tokens and emits BridgedOut with an increasing nonce", async function () {
      const { token, alice, bob, chainId } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("10");

      await expect(token.connect(alice).bridgeOut(amount, OTHER_CHAIN, bob.address))
        .to.emit(token, "BridgedOut")
        .withArgs(alice.address, bob.address, amount, chainId, OTHER_CHAIN, 0n);
      await expect(token.connect(alice).bridgeOut(amount, OTHER_CHAIN, bob.address))
        .to.emit(token, "BridgedOut")
        .withArgs(alice.address, bob.address, amount, chainId, OTHER_CHAIN, 1n);

      expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("80"));
      expect(await token.totalSupply()).to.equal(SUPPLY - 2n * amount);
      expect(await token.outboundNonce()).to.equal(2n);
    });

    it("rejects an unsupported destination chain", async function () {
      const { token, alice, bob } = await loadFixture(deployFixture);
      await expect(token.connect(alice).bridgeOut(1n, 999n, bob.address))
        .to.be.revertedWithCustomError(token, "UnsupportedChain")
        .withArgs(999n);
    });

    it("rejects a zero amount or a zero recipient", async function () {
      const { token, alice, bob } = await loadFixture(deployFixture);
      await expect(token.connect(alice).bridgeOut(0n, OTHER_CHAIN, bob.address)).to.be.revertedWithCustomError(
        token,
        "ZeroAmount"
      );
      await expect(token.connect(alice).bridgeOut(1n, OTHER_CHAIN, ethers.ZeroAddress)).to.be.revertedWithCustomError(
        token,
        "ZeroAddress"
      );
    });

    it("refuses to burn more than the balance", async function () {
      const { token, bob, alice } = await loadFixture(deployFixture);
      await expect(token.connect(bob).bridgeOut(1n, OTHER_CHAIN, alice.address)).to.be.revertedWithCustomError(
        token,
        "ERC20InsufficientBalance"
      );
    });
  });

  describe("bridgeIn", function () {
    it("mints to the recipient and marks the operation as processed", async function () {
      const { token, relayer, bob } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("5");

      await expect(token.connect(relayer).bridgeIn(bob.address, amount, OTHER_CHAIN, 0n))
        .to.emit(token, "BridgedIn")
        .withArgs(bob.address, amount, OTHER_CHAIN, 0n);

      expect(await token.balanceOf(bob.address)).to.equal(amount);
      expect(await token.isProcessed(OTHER_CHAIN, 0n)).to.equal(true);
    });

    it("rejects replaying the same (source chain, nonce)", async function () {
      const { token, relayer, bob } = await loadFixture(deployFixture);
      await token.connect(relayer).bridgeIn(bob.address, 1n, OTHER_CHAIN, 7n);
      await expect(token.connect(relayer).bridgeIn(bob.address, 1n, OTHER_CHAIN, 7n))
        .to.be.revertedWithCustomError(token, "AlreadyProcessed")
        .withArgs(OTHER_CHAIN, 7n);
    });

    it("handles the same nonce from two different chains independently", async function () {
      const { token, relayer, bob } = await loadFixture(deployFixture);
      const thirdChain = 421614n; // Arbitrum Sepolia
      await token.setSupportedChain(thirdChain, true);

      await token.connect(relayer).bridgeIn(bob.address, 1n, OTHER_CHAIN, 0n);
      await token.connect(relayer).bridgeIn(bob.address, 1n, thirdChain, 0n);
      expect(await token.balanceOf(bob.address)).to.equal(2n);
    });

    it("rejects calls from any address other than the relayer (owner included)", async function () {
      const { token, owner, attacker } = await loadFixture(deployFixture);
      for (const signer of [attacker, owner]) {
        await expect(
          token.connect(signer).bridgeIn(signer.address, 1n, OTHER_CHAIN, 0n)
        ).to.be.revertedWithCustomError(token, "NotRelayer");
      }
    });

    it("rejects an unsupported source chain", async function () {
      const { token, relayer, bob } = await loadFixture(deployFixture);
      await expect(token.connect(relayer).bridgeIn(bob.address, 1n, 999n, 0n))
        .to.be.revertedWithCustomError(token, "UnsupportedChain")
        .withArgs(999n);
    });
  });

  describe("administration", function () {
    it("the owner can change the relayer; the old one loses mint rights", async function () {
      const { token, relayer, bob } = await loadFixture(deployFixture);
      await expect(token.setRelayer(bob.address))
        .to.emit(token, "RelayerUpdated")
        .withArgs(relayer.address, bob.address);
      await expect(token.connect(relayer).bridgeIn(bob.address, 1n, OTHER_CHAIN, 0n)).to.be.revertedWithCustomError(
        token,
        "NotRelayer"
      );
      await token.connect(bob).bridgeIn(bob.address, 1n, OTHER_CHAIN, 0n);
    });

    it("only the owner can call setRelayer and setSupportedChain", async function () {
      const { token, relayer, attacker } = await loadFixture(deployFixture);
      await expect(token.connect(relayer).setRelayer(attacker.address)).to.be.revertedWithCustomError(
        token,
        "OwnableUnauthorizedAccount"
      );
      await expect(token.connect(attacker).setSupportedChain(1n, true)).to.be.revertedWithCustomError(
        token,
        "OwnableUnauthorizedAccount"
      );
    });
  });
});

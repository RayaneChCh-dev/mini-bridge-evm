// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title BridgeToken
/// @notice ERC20 deployed identically on every chain of the bridge.
///         bridgeOut burns on the source chain; the relayer then calls bridgeIn
///         on the destination chain to mint the same amount.
contract BridgeToken is ERC20, Ownable {
    /// @notice The only address allowed to call bridgeIn.
    address public relayer;

    /// @notice Counter of outbound operations from this chain.
    uint256 public outboundNonce;

    /// @notice Chains this contract accepts to bridge with.
    mapping(uint256 chainId => bool) public supportedChains;

    /// @notice Inbound operations already processed, keyed by (sourceChainId, nonce).
    mapping(bytes32 opId => bool) public processed;

    event BridgedOut(
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        uint256 sourceChainId,
        uint256 destChainId,
        uint256 indexed nonce
    );
    event BridgedIn(address indexed recipient, uint256 amount, uint256 sourceChainId, uint256 indexed nonce);
    event RelayerUpdated(address indexed previousRelayer, address indexed newRelayer);
    event SupportedChainUpdated(uint256 indexed chainId, bool supported);

    error NotRelayer();
    error ZeroAmount();
    error ZeroAddress();
    error UnsupportedChain(uint256 chainId);
    error AlreadyProcessed(uint256 sourceChainId, uint256 nonce);

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert NotRelayer();
        _;
    }

    /// @param initialRelayer relayer address (distinct from the owner)
    /// @param initialSupply  supply minted to the owner at deployment (0 on secondary chains)
    constructor(address initialRelayer, uint256 initialSupply)
        ERC20("Bridge Token", "BRT")
        Ownable(msg.sender)
    {
        _setRelayer(initialRelayer);
        if (initialSupply > 0) _mint(msg.sender, initialSupply);
    }

    /// @notice Burns `amount` of the caller's tokens to send them to `recipient` on `destChainId`.
    function bridgeOut(uint256 amount, uint256 destChainId, address recipient) external returns (uint256 nonce) {
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        if (!supportedChains[destChainId]) revert UnsupportedChain(destChainId);

        nonce = outboundNonce++;
        _burn(msg.sender, amount);
        emit BridgedOut(msg.sender, recipient, amount, block.chainid, destChainId, nonce);
    }

    /// @notice Mints the tokens matching a BridgedOut observed on `sourceChainId`.
    function bridgeIn(address recipient, uint256 amount, uint256 sourceChainId, uint256 nonce) external onlyRelayer {
        if (!supportedChains[sourceChainId]) revert UnsupportedChain(sourceChainId);
        bytes32 id = operationId(sourceChainId, nonce);
        if (processed[id]) revert AlreadyProcessed(sourceChainId, nonce);

        processed[id] = true;
        _mint(recipient, amount);
        emit BridgedIn(recipient, amount, sourceChainId, nonce);
    }

    function isProcessed(uint256 sourceChainId, uint256 nonce) external view returns (bool) {
        return processed[operationId(sourceChainId, nonce)];
    }

    function operationId(uint256 sourceChainId, uint256 nonce) public pure returns (bytes32) {
        return keccak256(abi.encode(sourceChainId, nonce));
    }

    function setRelayer(address newRelayer) external onlyOwner {
        _setRelayer(newRelayer);
    }

    function setSupportedChain(uint256 chainId, bool supported) external onlyOwner {
        supportedChains[chainId] = supported;
        emit SupportedChainUpdated(chainId, supported);
    }

    function _setRelayer(address newRelayer) private {
        if (newRelayer == address(0)) revert ZeroAddress();
        emit RelayerUpdated(relayer, newRelayer);
        relayer = newRelayer;
    }
}

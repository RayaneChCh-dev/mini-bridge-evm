// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title BridgeToken
/// @notice ERC20 déployé à l'identique sur chaque chaîne du bridge.
///         bridgeOut brûle sur la chaîne source, le relayer appelle bridgeIn
///         sur la chaîne destination pour minter le même montant.
contract BridgeToken is ERC20, Ownable {
    /// @notice Seule adresse autorisée à appeler bridgeIn.
    address public relayer;

    /// @notice Compteur des opérations sortantes de cette chaîne.
    uint256 public outboundNonce;

    /// @notice Chaînes avec lesquelles ce contrat accepte d'échanger.
    mapping(uint256 chainId => bool) public supportedChains;

    /// @notice Opérations entrantes déjà traitées, indexées par (sourceChainId, nonce).
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

    /// @param initialRelayer adresse du relayer (distincte de l'owner)
    /// @param initialSupply  supply mintée à l'owner au déploiement (0 sur les chaînes secondaires)
    constructor(address initialRelayer, uint256 initialSupply)
        ERC20("Bridge Token", "BRT")
        Ownable(msg.sender)
    {
        _setRelayer(initialRelayer);
        if (initialSupply > 0) _mint(msg.sender, initialSupply);
    }

    /// @notice Brûle `amount` tokens de l'appelant pour les envoyer à `recipient` sur `destChainId`.
    function bridgeOut(uint256 amount, uint256 destChainId, address recipient) external returns (uint256 nonce) {
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        if (!supportedChains[destChainId]) revert UnsupportedChain(destChainId);

        nonce = outboundNonce++;
        _burn(msg.sender, amount);
        emit BridgedOut(msg.sender, recipient, amount, block.chainid, destChainId, nonce);
    }

    /// @notice Minte les tokens correspondant à un BridgedOut observé sur `sourceChainId`.
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

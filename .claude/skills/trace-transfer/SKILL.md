---
name: trace-transfer
description: Trace a BRT bridge transfer between Sepolia and Base Sepolia from a burn or mint transaction hash, a nonce, or a "my tokens never arrived" report. Gives the matching transaction on the other chain, explorer links, the delay, and checks that no double mint happened and the total supply is still 1,000,000 BRT.
---

# Trace a bridge transfer

Everything here is read-only. Never send a transaction (`npm run bridge`, `scripts/fund.js`, deploy scripts) as part of tracing.

## 1. Get a transaction hash

- **The user gave a hash** (0x + 64 hex characters): go to step 2.
- **The user gave a nonce, an address or a time**: run `npm run relayer:status`. Each row has the source chain, the nonce, the status and `mint_tx`. The burn hash is in the `source_tx_hash` column of `relayer/relayer.sqlite`:
  ```bash
  node -e 'const db=require("better-sqlite3")("relayer/relayer.sqlite",{readonly:true});console.table(db.prepare("SELECT source_chain_id, nonce, source_tx_hash, mint_tx_hash, status FROM bridge_operations").all())'
  ```
  If the database is missing (another machine, fresh clone), ask the user for the burn hash: it is printed by `npm run bridge` and shown in their wallet.

## 2. Trace it

```bash
npm run trace -- <txHash>
```

The script finds which chain the hash is on, decodes the `BridgedOut` or `BridgedIn` event, and finds the other side on-chain:
- burn → checks `isProcessed` on the destination, then looks for the matching `BridgedIn` from the burn's timestamp onwards;
- mint → looks for the matching `BridgedOut` on the source chain from the mint's timestamp backwards.

The operation is identified by `(sourceChainId, nonce)`, printed as `op <sourceChainId>/<nonce>`. If `artifacts/` is missing, run `npx hardhat compile` first.

## 3. Read the result

| Output | Meaning | Next step |
| --- | --- | --- |
| Burn + Mint + supply = 1,000,000 | Transfer complete | Give the user both explorer links and the delay |
| `Mint … not done yet` | Burn confirmed, no mint on the destination | See below |
| `Burn … not found` | Mint without a matching burn | Serious: report it, check the relayer key and `BridgedIn` events on the contract |
| Supply ≠ 1,000,000 | Burn not yet minted (normal during a transfer) or a double mint | Re-run after a minute; if still off with no pending operation, report it |
| `not found on sepolia or baseSepolia` | Wrong hash, wrong network, or a typo | Ask the user to check the hash |
| `neither a bridgeOut nor a bridgeIn` | The transaction is real but is not a bridge operation (deploy, transfer, funding) | Ask for the burn transaction |

**Mint not done yet**:
1. Less than about a minute after the burn: normal. The relayer waits for 5 confirmations (about 60 s on Sepolia, 10 s on Base Sepolia) and polls every 12 s.
2. `npm run relayer:status`: `pending` or `submitted` means the relayer has seen it and is working on it; `failed` shows the error in `last_error` (often an empty relayer gas balance: check with `npm run balances`); no row means the relayer was not running or has not scanned that block yet.
3. A stopped relayer catches up by itself when restarted (`npm run relayer`). Do not mint by hand: replay protection makes it safe, but the relayer already handles it.

## 4. Answer

Lead with the outcome (arrived, in progress, or a problem), then:
- the burn and mint explorer links, as printed by the script;
- the amount, the direction and the delay;
- the supply check.

To check a link by hand: `https://sepolia.etherscan.io/tx/<hash>` or `https://sepolia.basescan.org/tx/<hash>`; the **Logs** tab of a transaction shows the event with its `nonce` and `sourceChainId`.

# Mini-Bridge EVM

Mint & burn bridge for the `BRT` ERC20 between Sepolia (11155111) and Base Sepolia (84532). One contract (`contracts/BridgeToken.sol`) deployed identically on both chains, one Node.js relayer (`relayer/`) that watches `BridgedOut` and calls `bridgeIn`. Design document: `docs/SPEC.md`.

## Commands

```bash
npm test                          # contract unit tests (Hardhat)
npm run test:relayer              # relayer integration test: starts two local Hardhat nodes (chainIds 31337, 31338)
npm run relayer                   # relayer against the testnets (needs RELAYER_PRIVATE_KEY in .env)
npm run relayer:status            # operation history from relayer/relayer.sqlite
npm run bridge -- sepolia 10      # bridgeOut from the deployer wallet; no args = balances
npm run trace -- <txHash>         # read-only: burn ↔ mint on both chains, explorer links, total supply
```

Scripts under `scripts/` and the relayer `require` the ABI from `artifacts/`: run `npx hardhat compile` after a fresh clone or a contract change. CI (`.github/workflows/ci.yml`) runs both test suites on every push.

## Invariants: do not break

- **One mint per `(sourceChainId, nonce)`**. Enforced on-chain by `processed` in `bridgeIn`. The nonce alone is not unique across chains.
- **The chain is the source of truth, SQLite is only working state.** `processOne` calls `isProcessed` before every `bridgeIn`, and an `AlreadyProcessed` revert counts as success. Never remove either: they are what makes a crash between sending the mint and writing to the database safe.
- **Events and cursor are written in the same SQLite transaction** (`db.recordRange`). Splitting them lets a crash move the cursor past unrecorded burns.
- **Only blocks at `head - CONFIRMATIONS` or older are scanned** (reorg protection).
- **Sum of `totalSupply` on both chains = 1,000,000 BRT.** Supply only exists on Sepolia at deploy time; Base Sepolia starts at 0.
- **The relayer key can only mint; the owner key manages roles.** Keep them separate; `bridgeIn` must reject the owner too.

Any change to the contract or to `relayer/relayer.js` needs both test suites green. The integration test covers the crash and downtime scenarios; add a scenario there rather than testing by hand on the testnets.

## Known pitfalls

- **ethers v6 caches identical RPC responses for 250 ms**: two back-to-back `bridgeIn` calls got the same account nonce. Every provider that sends transactions uses `cacheTimeout: -1`. Keep it.
- **`sepolia.base.org` rejects `eth_getLogs` over 200 blocks** with a 413; the real cause is only in the response body (`describe()` in `relayer.js` extracts it). Keep `MAX_BLOCK_RANGE` ≤ 200 for Base.
- ethers v6 event filters take one argument per event input, in order, with `null` for non-indexed ones: `filters.BridgedIn(recipient, null, null, nonce)`.
- Public RPCs are rate-limited; set `SEPOLIA_RPC_URL` / `BASE_SEPOLIA_RPC_URL` in `.env` if calls fail.

## Testnets and secrets

- `.env` holds `DEPLOYER_PRIVATE_KEY` and `RELAYER_PRIVATE_KEY`. Never print, log or commit it. `npm run wallets` overwrites it: ask before running it.
- Live deployments are in `deployments/sepolia.json` and `deployments/baseSepolia.json`. Redeploying replaces the addresses linked from the README and breaks the on-chain proof: ask first.
- `npm run bridge -- <chain> <amount>`, `scripts/fund.js` and the deploy scripts send real testnet transactions: ask before running them. `npm run trace` and `npm run relayer:status` are read-only.

## Conventions

- CommonJS, Node.js 22, ethers v6, Solidity 0.8.24 with OpenZeppelin 5.
- All code, comments and docs are in English.
- Comments explain *why* (a risk, an RPC quirk), not what the next line does.

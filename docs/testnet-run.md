# Testnet run

Everything here is NEAR testnet. Look up any transaction at `https://testnet.nearblocks.io/txns/<hash>`, or with `near transaction view-status <hash> network-config testnet`.

## Accounts

| account | purpose | keys |
|---|---|---|
| `lantern-row.testnet` | the game contract | **none**, the account is locked |
| `lantern-row-gas.testnet` | pays gas for `act` and `advance_night` | one full-access key (to add keys and refills), 8 function-call keys |
| `lantern-row-stress3.testnet` | throwaway copy of the same wasm, used only for measuring | one full-access key |

`lantern-row-stress.testnet` and `lantern-row-stress2.testnet` are older throwaway instances from before the last tuning. They could not be deleted: the protocol refuses to delete an account with this much state. Ignore them.

## The contract cannot be patched

- Deployed and initialised in one transaction: [`3jTXU3gPd3JQ6MzPwkZmwbrbK7TH2ygy4P1yctoJRyN3`](https://testnet.nearblocks.io/txns/3jTXU3gPd3JQ6MzPwkZmwbrbK7TH2ygy4P1yctoJRyN3).
- Its only key deleted: [`GZmZY6asVN9EdKzn5sHRrasBj8HVw5unYvUHErppYTfC`](https://testnet.nearblocks.io/txns/GZmZY6asVN9EdKzn5sHRrasBj8HVw5unYvUHErppYTfC).
- `near account view-account-summary lantern-row.testnet network-config testnet now` prints `Account is locked (no access keys)` and the code hash `1be4c4d2b9f97af91ebb94d32817c8d572f7064a2d5aafe730c8ab1d7d2b4e9b`. That is `contract/WASM_SHA256`. `contract/build.sh --check` reproduced it on the build machine; a build elsewhere may differ, because the build is not containerised.

## Gas keys

Each of the 14 function-call keys on `lantern-row-gas.testnet` has an allowance of 1 NEAR and may only call `act` and `advance_night` on `lantern-row.testnet`. To see them:

```sh
near account list-keys lantern-row-gas.testnet network-config testnet now
```

The keys are public on purpose: they are in [`web/js/gas-keys.js`](../web/js/gas-keys.js), with the reasoning. A transaction burns about 0.0003 NEAR, so 1 NEAR lasts about 3,000 transactions per key. The pool started with 8 keys; 6 more were added for the web client with `scripts/setup-gas-pool.mjs`.

## Real nights played

`scripts/testnet-play.mjs` is a wallet-free player: a local ed25519 key signs and a pool key relays. It plays the same way as the simulation's Trader. It needs pool keys in the git-ignored `.secrets/gas-pool.json`, written by `scripts/setup-gas-pool.mjs`.

| what | gas | transaction |
|---|---|---|
| found a stall | 2.96 Tgas | `716TMbzrvetKkj1nDEP4soxXnrNXjTSc9SXpSLk9nJvR` |
| night 1: buy and price, 10 actions | 2.85 Tgas | `G6YhBc29Bz5smycHvXTUSpM6ZjVWcY7BEKizoh5gCkrr` |
| `advance_night`, 3 nights | 4.51 Tgas | `Bcw8YskpLRzhz38Y9VhYTX6uNNKU4EKvnHxY5Li74bnS` |
| night 4: 9 actions | 2.83 Tgas | `EjcHi46LuQB1hsQPCxEj5xB3yZARt6WoLRRzMMxytNXN` |
| `advance_night`, 22 sales, 10 at the stall | 3.79 Tgas | `7GqsDmeXNqoonAdF4vDPqbdHbmHJ87J7WEhDShCip3Rx` |
| night 5, a festival: 5 actions | 2.77 Tgas | `6HzaSFkNhx8SaTQjFfto8jZExLvxHhwwctyDwm9mxAZ5` |
| `advance_night`, 30 sales, 10 at the stall | 3.82 Tgas | `EwhPJvzqFgLFCu75PGRV8TGCKbaESboQ7LQvMQRDTJZr` |
| `advance_night` with 14 stalls on the row, 1 night | 5.46 Tgas | `GBMGnMUnQj3L6QdWtAXtHp8uKm144kUarrH5CkZfyoff` |
| `advance_night` catch-up, 11 nights | 8.93 Tgas | `tHXayApVSHkBnmgjkaB5hNx7KHqmimBBBkbeEzRf2k8` |

The stall went from net worth 3,006 to 6,537 in 40 nights, some of them idle. It stayed behind the merchants, who hold 16,000 to 24,000. `audit()` returned `total` equal to `founding` throughout. Some nights the stall sold nothing: after a long absence the villagers' memory had faded, and pricing 3% under a merchant they know was not enough at the back of the row.

## The token as an account

`scripts/testnet-nft-demo.mjs`, three wallet-free players (A, B, C), stall 11 founded by B:

| what | gas | transaction |
|---|---|---|
| B founds stall 11 | 2.97 Tgas | `7ZNUWNgK7CC1L2noZQsUepfGybN9tE1uZK3Q5hWbpspV` |
| B lists it for 300 | 2.70 Tgas | `GvtdvBcRz9VmEhGQdGKEUtYvviTUghHxmGgWH9cKuNCi` |
| A buys it with coin its own stall earned; 3,000 coin inside move along | 3.52 Tgas | `8D61BRB2j9sQypWny2JZu4hVoSTiiopGumwNKkN4SDYQ` |
| C sells another stall to A, then collects the proceeds into a new stall | 2.70 Tgas | `3QsCo7oDVEbPx1rYUA9JYzMMqsAsxrC4yCm6HwzPjHEH` |
| A resells stall 11 to C for 100; B, not part of the sale, gets the 5% royalty | 3.75 Tgas | `9xucAocvsd49AAPnmJpXeuttffXTZSzxZf9prVL6ZnCy` |
| C, funded with NEAR, sends stall 11 to B by plain `nft_transfer`; money, reputation and spot unchanged | 2.95 Tgas | `282YKTVyqVE4FhNht5wQ6Fq7JsXa6NQkrLJYJsraZX4b` |
| B plays the stall again by signature | 2.72 Tgas | `6bnSGiBHRdCjUynr8Wpotni4QvvkHq2hJaKyRTf9648` |

A wallet account also played through `play`, as in the README: found `GF44Q7fqoKN58DmcC3my7uLnkLiNhpCnufFz2XeR5Ftq`, buy and price `66YeMigtiY9hXWcjX5mojYpJwQG1oYRXLdrx2hAAgaZ9`, end the night `7bCFMhNGP9wwN6pSraL6vm8NzNDag13B41UYsp7mYSeF`.

Not exercised on chain: `nft_transfer_call`, `nft_approve` and `nft_transfer_payout` with a real marketplace contract. Those have unit tests only. `nft_payout` was called as a view.

## Measured gas

Gas means the sum burnt across the transaction and all its receipts, as reported by the RPC. All of it was measured on the deployed wasm.

| call | gas |
|---|---|
| `act`, 1 to 10 actions | 2.7 to 3.0 Tgas |
| `act` with `buy_stall` | 3.5 to 3.8 Tgas |
| `nft_transfer` | 2.95 Tgas |

Worst case, on `lantern-row-stress3.testnet`: all 24 spots taken, 18 by player stalls that hold stock and low prices.

| `advance_night` | gas | transaction |
|---|---|---|
| 6 stalls + 4 new, 1 night | 4.52 Tgas | `2mtU14jy8ebjKjb8mU1VyFRCKZo1KhkPuWCNYTD49syH` |
| full row, 1 night | 7.76 Tgas | `2GSbhdabc4T3Q9wENzXwg13HT6Z7QcSyE71rBXmVfwXs` |
| full row, full catch-up of 30 nights | 15.43 Tgas | `29RPUHyQSf7ej9BUCHywARLsJsyFJC4M8zCqB3M7chu7` |
| full row, 34 nights due: 30 simulated, 4 slept through, no backlog | 15.66 Tgas | `EDgKXhKB35yTPBZkct54VVDPvycJGK4g6RMPH4HtTYb5` |

So a full catch-up costs about 5% of the 300 Tgas limit. The row is loaded and saved once per call, so each extra night adds only about 0.3 Tgas. The stress stalls hold little stock, because the Dock's supply is limited and is shared across 24 stalls. A busier night writes a longer log and adds little.

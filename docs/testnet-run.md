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

## Played through the web client

`scripts/e2e-browser.mjs` drove the real page in two headless Chrome profiles at once (a 1366×820 laptop and a 390×844 phone with touch), each with its own browser-made key, against `lantern-row.testnet` on testnet. Both stalls already existed from an earlier run of the same script, so the keys in the profiles resumed them. Every step went through the page's own buttons; the script only read the page's state to check the result. Final run, nights 117 to 127:

| step | laptop ("Alice Teahouse", stall 16) | phone ("Bobs Dumplings", stall 15) |
|---|---|---|
| resumed the stall from the stored key | 5,038 coin | 3,980 coin |
| restock with one tap, then smart prices | stock 5/1/3/1/3 | stock 6/0/3/2/0 |
| raised the tea price with + | 72 → 76 | 72 → 76 |
| nights watched, summaries shown | 10, yes | 10, yes |
| listed the deed at 4,321, then withdrew it, both confirmed by `world().listings` | yes | yes |
| saw the other player on the leaderboard | yes | yes |
| transactions, failures | 17, 0 | 21, 0 |
| coin after 10 nights | 5,768 (+730) | 6,714 (+2,734) |

20 of 20 checks passed. A Dock purchase was refused three times with "the Dock does not have that many tonight" because the other browser had bought first; the client clipped the quantity and sent the rest of the order again, which is what the refusal log shows. Two `advance_night` attempts lost a nonce race with the other tab and gave up quietly, because the other tab had already ended the night.

`act`, 1 to 8 actions, 2.50 to 2.82 Tgas, for example `66XZrmrK76oq6bRL2yc68xJi3VRXdLNqdoUjf2tRMTvg`, `7Q2swy6tiE6vgsaiyUtiTeyBq4t2sGw3343YjBujmZyr`, `Djcxpgc6GHfLyhV1AQdsjfNrTwY9o3CAyEnJYak1FHFr`, `E9Ujwnt7zv7QPK4bryxnSQq7Vzbg7AtfRgcCTi2QQFPx`, `AF76SoSxToy1jXP74UG6DdzaLPPYshskr96E4qjcjsmC`, `6S34vxzcgivTep8hcSs9ShYwckVHm4g2Lg1sRoWqmaFt`, `CWRRnPpDECFcghc6bb9eBwkRmG98d6Yp7HM8QeYUSjD2` (laptop) and `6CcJQ3PZRvq8WsFTGSr5zqdbfZZ38wKc3TjhHtMCwWZk`, `DvFBKFYfCHhDgKTVDhNhGB6whXuD96LjR7ZFVuoQzVkB`, `8yqbsYwKbgvezqXYY5NksYRTowZ3ENorEkzssspaSeN9`, `Apj17DpnMFdkg9pujwV7oJRzCzkMZwChYgxxXbYexZyD`, `39rs4kajiruxeEQqSYYRUTXmhqJhnzEwxgsrJXbQCALn`, `BtDxEvXsACE8ujQpic6N4DwfoNGzWY61vRbS3ZN9bVLo`, `BSaVxTrRbGh1hMgn9MrNa8qqXjFhH5THq8J9fpLsPyY1`, `B5pcoRYwtjWB6zuBvrPv76VxHQwugVUkiPzkW83WvosV`, `8AZ6MiVsMfeqYtSB1M19u6gewiMhSpUNYytQF1Apbd7P`, `EvZUCiFTMrmRC8NTFR2HHrhVzNRtiEjgGGTcpfLMwgax`, `FKpgezH5gAm17GJskaSmBK8t1jFbT4SNqnhm1xyS1o5i` (phone).

`advance_night` from the browsers, 1.83 Tgas when the night was not due yet or was already ended, 4.6 to 4.9 Tgas for one night, 7.67 Tgas for a catch-up: `E8MCY5wwHD7JoBMPjRUjyfEzWnedAW828VeZ8EtYajDw`, `FocCKhmWU27XHxnTSWBPxkvEdy29DACpu9RGF4y59fCm`, `FkKtfyT3H59Hb8zK5mRi8qhTY5cSDaZL2WLWY2b9WkwB`, `5u3neetQHT6w5WsGUqoNG2nVyaAFyEeDQhFKi6y3ym2N`, `9pquyCjpaypV2upagUTJzRPdDgXAb4kZ9Eh9b4PqQWs6`, `AKD74xgUpdQkc6FD5N5ZYm71NDjrcmUWa4oZSYegrPp8`, `DygqnHYcp3FoeUbo6MBa3xdSZ9pnyYvSDVPQECoBpEHY`, `AqwpzZixLVRj2ayFM74Y34BbTGeQx2V3x8AohpmdVQUD`, `3wWEKzgHSKCqVbXfVgseohitCQoFWEhGtzzW7kNxU3vA`, `BgkSKW9NdgUCfrjgPc3TfHnucLLm4oxct3yVYgcWpgUu`, `G9vP3hYomD5et7HyJLVpUppFFaYXQfvaUWDSrVUDzV1S`, `5E8HD8XKVFMZCL5j7a2QuFCN2FDwiXwdhDeyyuv6t33C`, `8fYiJ8ju7NBJT27WVgbEiHwgmFvP88b5mroyfHVjBE13`, `opafEXJtUAKPFGpSg185fYGKUQRYFBCsnRBEqGHN2bd`, `2sC1CR1KcJbH1ojgoqW8Lj1RgFw7xBp9ScQCEDFqjhVj`, `A54PugTgaYh8ypfwGBXJJ8WiNsY57jedZo64mbsJiRLd`, `C6hLktjXa7vL37j7D9n2JNcqmFqHGBMEXka8FDQTYwFU`, `B4944YWQMY3JAGovdX7PgM299QDfvpBUsvJ2jSsp13RJ`, `ATatqYVv9hYCXWZGVci2FbJLheupWgdb9Q9W1UNCLctR`, `G782jM1ZdRE3amCH8vzjH1gKpDLz4g85fCixJYf4SYCt`.

Earlier runs of the same script founded the two stalls (`found` through the title screen's button) and played 2 and 10 nights each; they are what surfaced the bugs the client now handles (a lagging view rolling back an optimistic purchase, and a refused buy aborting the rest of an order).

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

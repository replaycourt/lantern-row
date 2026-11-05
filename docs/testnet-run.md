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

`scripts/e2e-browser.mjs` drove the real page in two headless Chrome profiles at once (a 1366×820 laptop and a 390×844 phone with touch), each with its own browser-made key, against `lantern-row.testnet` on testnet. Both stalls existed from an earlier run of the same script, so the keys in the profiles resumed them. Every step went through the page's own buttons; the script only read the page's state to check the result. Final run, nights 439 to 449:

| step | laptop ("Alice Teahouse", stall 23) | phone ("Bobs Dumplings", stall 24) |
|---|---|---|
| resumed the stall from the stored key | 4,347 coin, spot 17 | 3,430 coin, spot 19 |
| restock with one tap, then smart prices | stock 3/2/8/2/2 | stock 3/0/0/0/0 (the laptop had emptied the Dock of the rest) |
| raised the tea price with + | 62 → 65 | 62 → 65 |
| nights watched, reports shown | 10, yes | 10, yes |
| tonight's call offered, answered (every other one accepted) | 9, 9 | 9, 9 |
| the call judged in the next report | yes, 13 sightings | yes, 18 sightings |
| listed the deed at 4,321, then withdrew it, both confirmed by `world().listings` | yes | yes |
| saw the other player on the leaderboard | yes | yes |
| transactions, failures | 26, 0 | 21, 0 |

24 of 24 checks passed. The calls the two players got, from the rules alone: "12 want dumplings tonight: stock 6 at 43", "Bumper lamp oil next night: wait for cheap lamp oil", "You sold out of dumplings: stock 10", "Festival of dumplings starts next night: stock 20", "Festival of dumplings tonight: raise dumplings to 47". Judged the next night, for example "Your call paid off: 4 dumplings sold for 196" and "Your call: none of the dumplings sold tonight". Dock purchases were refused a few times with "the Dock does not have that many tonight" because the other browser had bought first; the client clipped the quantity and sent the rest of the order again. A few `advance_night` attempts lost a nonce race with the other tab and gave up quietly, because the other tab had already ended the night.

Two earlier runs the same night stalled for 15 and 17 minutes in both browsers at once; the build machine's power log shows it was asleep for exactly those minutes. In the final run the ten nights fell between two such sleeps (the deed steps ran after the next wake, and passed). The client now also treats a world view whose clock falls more than 25 seconds behind the browser's as stale, switches to the other RPC host and ends the night itself; `advance_night` before its time is harmless.

`act`, 1 to 8 actions, 2.55 to 2.83 Tgas: `CmedqGsGFdmP46E8LqAMW3aKCWXwWXdC5qXxJx9U9uDQ`, `5cSo4Gnr77DAnJWfVHApc1pAUH8eisoS45gpxp1yZ2cT`, `GTwptCm45EtP6X9kxvXqos8sDonLjk1SVxfRCKEzVDBc`, `BacrsHVxaRdXZCR6Ff4vXuKaPFshnskfYkJJqXUVVyoj`, `7chpQkeLzHrSSdA4YhqjLge3vyxW1FkA1JBp595UysSH`, `2c5eXzVGE5iXavsb5qS8b5bjCxdVh9JrU2teQVEgFtab`, `HVfwhkrJUqxrWuATKqJ1LVvZh2gDjtxRjLR1r1qYD8oa`, `BwyUjkjMrsXAFKcLU3zsLSnA56NX6ymDJvXbEN88grZC`, `GeHqJXHai3QxAQ8GQVRCAyUpzaSk2WWBKAmXToZ73FnD`, `3JN4XyJb4C3vuX541dcFVAppMQbzhGhrQbwUVqEZnivd`, `7Cb8mKu88WLRX6qCXMuanV9U8MUz2fEzpAF7dQc4Zg81`, `FknMuZxfLFsADSPW7fp4KLHtEx6Me3Wv9ptqFigQsVFE`, `4CYtYN7uPBJU974nVxqqep2J74cB6TYtMXdMaY83Dz4Y`, `3obvdjtT9geuotQXh7jmR69HkGCQSbyhaAkECkEkt6QG` (laptop) and `4eMZkgWdA6Q2hFYJMjzSmytCTQ3Hdg6xWuys8eBoj6ND`, `324tME9wAjiuhwvMpDzCqunHiZjYeeS4KsZGHP1Pm1Wi`, `A9x1U4LcfK3ibcPSjC1MRZtbxPnHA4nuCLbsrTCXxkt2`, `14qKgs7EEWbX2caN69g3Kr9oVqVhiHx6o7LzrSKBZFbg`, `DAESHfe9vzMoczkEwE5VbCdAPK4qc1B9sCaLAPigqL2D`, `8hyjmHuHBDkSwkojwhYXk5T3tnRRSDpFwabHjFZCucQ1`, `5KmGsiv5m3Sfs3gNGCRM3YviKrqTm84JNz7fYQ7H9X5R`, `EDd3RgYJFY7abzsmRYoXrLGvx7A7PLvHzibE9NumNj2N`, `7kH69eYNzwcibWQimtcVTqiiFxswib2VkZskJZeMMnf9`, `9iTLriLkcuQobV1tuHDP2qx6BiaYiWLG3JAogvWZQyaA`, `EAJZX9qmDays62qBBAsWSzmA9tGKHeqLzWcTgcBTmAii` (phone).

`advance_night` from the browsers, about 1.85 Tgas when the night was not due yet or was already ended, 4.5 to 5.0 Tgas for one night, 7.25 and 11.45 Tgas for catch-ups: `nuEowXHPzQU5KL48ejCzpd5Fptt9FP8KjEWXr1ffMRY`, `6qVw6ASxWnBX28PWDBEkJGmJ8F2nyF1JnfjCHxHCxmE5`, `EpRYGJ644MKYYqNW2r7FpoTwgkLdu2pejFqmAfX8m36V`, `FkLwNtjz7AP6v3Q4UUbw3yW58KeCcQ2FntmAN6XpZafv`, `E8vSvsupqHBQv3FXP9MmVJboNf4Zr4fQFP9cJH18G2a7`, `8evM5nyyNyNtxcJHwh2KSsm66LH8LDAwVYpxQCFGwTSa`, `2xUk4a5Mq7p21RWXAPz585jYkMQWYoW9us2wxhnDry2r`, `CwZnAmZEhYQzrmfDf4EZkn7iUPrtBAcbqTrBHHDDisXz`, `G1RfVV5dHWgo2DtYutQSMPHRkFyDaUX2zuqfhrGCvn2u`, `7HfAGfTsCqCwfhHQkoNrz4BAExw6ypGXeubxrpuh5k3C`, `6zdXFbUvbUkCf6EBsXwpzXPDrCrrWHSzRfwwNTAMUXFK`, `GTrsFXUdFgghqa4E45hP1dNmtprUMY17yS9T4JdXDYes` (laptop) and `3ibQdArgJMh8uEvy5boShhcjf2U2CEp6iPLWdMqqb9DJ`, `EogQHcTXFSXpfb7Dnct1aStLbWKLA7DBK2nGprZ1EYUW`, `9LM5JWbeJ8EDwNsZJCxvY6TQFMKR2hM9jkJGK9T66CAy`, `EMcjSBRiB9YP4fYJnLvrbfTwVbEFhSSQt5otDA3yqeJy`, `A6F1pW8iS6wEsaV3zdrMwcHx8w5pgF8Uo8sUxiS8gLpG`, `HNG8FX67Yy5S6tfN1bMLrTKJGNWz1M3yscAJgoh53QBM`, `AMGpkYL4JuXewhT3Nm2FTfz3WMYFJCfMGV5WwZoCTN8L`, `CeNq2o2at67M726wS11wdthQwehxYVvxUb3GG3bZzTor`, `7fG2dGYhLWveZn36jN8uhx9o5HYy8HETMbZUQtNktjtM`, `Bmy67tkPjuwH6Vduskqbgm6YpNfVz5MWAssDz9V6wwMt` (phone).

Earlier runs of the same script founded the two stalls (`found` through the title screen's button) and played 2 to 10 nights each; they are what surfaced the bugs the client now handles (a lagging view rolling back an optimistic purchase, a refused buy aborting the rest of an order, a timed-out send resent with a fresh nonce).

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

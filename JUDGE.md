# Judging Lantern Row in five minutes

Everything runs on NEAR testnet against `lantern-row.testnet`. You need a browser for the game, and `curl` and `python3` for the checks. No account, wallet or install.

## 1. One-command checks (one minute, read-only)

Each command is a view call to the public testnet RPC. None sends a transaction. python3 only decodes the result, which the RPC returns as bytes. To run all five at once and get PASS or FAIL for each (bash, curl and python3; macOS or Linux):

```sh
scripts/judge-checks.sh
```

Or one by one:

```sh
# The game contract has no access keys, so nobody can redeploy it or act as it.
# Expect: "keys":[]
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"lantern-row.testnet"}}'; echo

# Coin is never created or destroyed.
# Expect: {"founding":1000000,"total":1000000,...} (the other fields say where the coin sits now)
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"lantern-row.testnet","method_name":"audit","args_base64":"e30="}}' | python3 -c 'import json,sys; print(bytes(json.load(sys.stdin)["result"]["result"]).decode())'

# The deployed code is the build in this repository.
# Expect: two equal lines (the chain's code hash in hex, then contract/WASM_SHA256). Run from the repository root.
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"lantern-row.testnet"}}' | python3 -c 'import json,sys,functools; s=json.load(sys.stdin)["result"]["code_hash"]; a="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; print(functools.reduce(lambda n,c: n*58+a.index(c), s, 0).to_bytes(32,"big").hex())'; cat contract/WASM_SHA256

# A stall is an NFT that holds its own coin and goods (token 1 is the merchant The Quiet Kettle).
# Expect: "Stall 1: The Quiet Kettle", then a line with its spot, money, goods and reputation.
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"lantern-row.testnet","method_name":"nft_token","args_base64":"eyJ0b2tlbl9pZCI6IjEifQ=="}}' | python3 -c 'import json,sys; m=json.loads(bytes(json.load(sys.stdin)["result"]["result"]))["metadata"]; print(m["title"]); print(m["description"])'

# The relay keys that pay players' gas can only call act and advance_night on the game.
# Expect: {'lantern-row.testnet act,advance_night': <n>, 'full access': 1}
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"lantern-row-gas.testnet"}}' | python3 -c 'import json,sys,collections; f=lambda p: "full access" if p=="FullAccess" else p["FunctionCall"]["receiver_id"]+" "+",".join(p["FunctionCall"]["method_names"]); print(dict(collections.Counter(f(k["access_key"]["permission"]) for k in json.load(sys.stdin)["result"]["keys"])))'
```

The one full-access key is on the gas account, not on the game: it adds relay keys and refills the pool, and it is not in the repository. `contract/build.sh --check` rebuilds the wasm and compares it with `contract/WASM_SHA256`; it needs cargo-near 0.22 and the toolchain pinned in `contract/rust-toolchain.toml`, and a cold build takes 20 minutes or more. [CI](.github/workflows/ci.yml) runs it on Linux and reports the hash it got in the job summary.

## 2. Play it (three minutes)

Open https://replaycourt.github.io/lantern-row/web/ in Chrome 137+, Safari 17+ or Firefox 130+. Playing sends real testnet transactions, paid by the public gas pool.

1. **Look at the title screen.** See the street replaying the latest nights from the contract's night logs, a ticker of real sales and refusals along the bottom, and a line such as "Night N · 12 villagers shopping · 6 merchants · 1 player stall", read from the contract's live view. Nothing on the title screen sends a transaction. If nobody has played or kept the town for more than a few minutes, the title says how long the street has been asleep: the contract only moves when someone calls `advance_night`, and the first player action (opening or returning to a stall) catches up the missed nights, up to 30 at once, so your first night may start with a catch-up. *Watch the row first* clears the screen; tap any stall to see its prices and why.
2. **Tap *Open your stall*.** See your stall appear on the row with 3,000 coin. There was no wallet prompt: your browser made a key, and that key owns the stall. If the clerk has no licences left tonight, the page waits for the next night by itself (nights last 20 seconds).
3. **Tap *Restock*.** See goods land on your counter. Each card says how many villagers want that good tonight and how many may buy at your price; tap − or + and watch that number move.
4. **Wait for the clock.** See the villagers walk the row and buy, coins fly, "Too dear!" with the reason under it, and a night report: what sold, who found what too dear and what they would have paid, the rent. The top bar shows your worth against the next milestone and your place among the players.
5. **Answer tonight's call** under the report with *Do it* or *Skip*. The next report says how it went.
6. **Tap *Proof*.** See the contract, your account, your stall's token id, and the transactions this tab sent, each linked to the testnet explorer. The drawer reads the contract's access keys and code hash from the chain when it opens and compares the hash with `contract/WASM_SHA256`.
7. **Tap *Deed*.** See your stall as the NFT it is: a deed card drawn by the page, and under it the picture the contract draws from the live coin, goods, reputation and spot. List it for sale and see the "FOR SALE" sign go up.
8. **Tap *Ranks*.** See the players on the row first, then the six merchants, then the stalls that lost their spot, folded (tap to open). Open the page in a second browser and your first stall is already on the street.

The [README](README.md#how-to-play) walks through the same steps with more detail. To run the client locally instead, see [Run it yourself](README.md#run-it-yourself).

## 3. Where each claim lives

| Claim | Code | Tests |
|---|---|---|
| No owner, no admin method | `contract/src/lib.rs`: `new` is `#[init] #[private]` and ran once at deployment; the only other write methods are `act`, `play`, `advance_night` and the NFT standard methods in `contract/src/nft.rs` | |
| Coin is conserved | `audit` in `contract/src/views.rs` | `contract/tests/invariant.rs` |
| Villagers with wallets, wages and tastes | `pay_wages`, `walk_one` in `contract/src/night.rs`; `VILLAGER_TABLE` in `contract/src/config.rs` | `contract/tests/rules.rs` |
| Merchants trade by readable rules | `run_merchants` in `contract/src/night.rs`; `MERCHANT_TABLE` in `contract/src/config.rs` | `contract/tests/rules.rs` |
| Player-owned stalls | `do_found`, `do_buy`, `do_price`, `do_move`, `do_upgrade`, `do_list`, `do_buy_stall` in `contract/src/actions.rs` | `contract/tests/rules.rs`, `contract/tests/listing.rs` |
| The economy moves without a developer | `advance_night` in `contract/src/lib.rs`; `run_nights`, `turn_the_night` in `contract/src/night.rs`; `roll_event`, `wage_pct`, `dock_marginal` in `contract/src/market.rs` | `contract/tests/catchup.rs`, `contract/tests/economy_sim.rs` |
| The stall is the account | `Stall` in `contract/src/types.rs`, stored under the token id; `move_token`, `token_view`, `stall_svg` in `contract/src/nft.rs` | `contract/tests/nft.rs` |
| Founder royalty, 5% | `royalty` in `contract/src/market.rs`; `do_buy_stall` in `contract/src/actions.rs`; `nft_payout` in `contract/src/nft.rs` | `contract/tests/listing.rs`, `contract/tests/nft.rs` |
| No-wallet play | browser key: `loadOrCreateIdentity` in `web/js/chain.js`; signing: `Client.act` in `web/js/chain.js`; relay: `GasPool.relay` in `web/js/chain.js`; signature check: `act` in `contract/src/lib.rs` | `contract/tests/signature.rs`, `web/test/near.test.mjs` |
| The client reads villagers as the contract does | `villagerWants`, `forecast`, `titleLine`, `refusalReason` in `web/js/logic.js` | `web/test/logic.test.mjs`, `web/test/goals.test.mjs` |
| Watching the row sends nothing | `startReplay`, `pollTitle` in `web/js/main.js`: views and `night_log` only | |

Every rule and number is in [SPEC.md](SPEC.md); the economy simulation is in [docs/ECONOMY.md](docs/ECONOMY.md); the last end-to-end run on testnet, with its transaction hashes, is in [docs/testnet-run.md](docs/testnet-run.md).

## 4. Run the tests

```sh
node --test 'web/test/*.test.mjs'   # client logic and the NEAR layer; Node 22+, no install; about 5 seconds
cd contract && cargo test           # the contract, its invariants and the economy simulation; toolchain from rust-toolchain.toml
                                    # a cold build takes 15 minutes or more on a laptop; the 167 tests then run in about 30 seconds
```

## 5. What is real and what is not

Testnet only, play money, public gas keys, bot-driven economy evidence, a town that only moves when someone plays, NPCs that are rules and not AI, AI-written code that no human reviewed line by line, no audit. The details are in the README: [What is real and what is not](README.md#what-is-real-and-what-is-not).

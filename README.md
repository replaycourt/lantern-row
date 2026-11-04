# Lantern Row

A night-market trading game whose whole economy runs on one NEAR contract, with no owner and no way to patch it. Built at NEAR HACKATHON for the `games` and `nfts` tracks.

You run a stall on a lantern-lit street. Every 20 seconds a night ends: twelve villagers with their own wallets, tastes and memories walk the row and buy. You buy stock at the Dock, set prices, and try to out-trade the NPC merchants and the other players.

**Status: phase 1.** The contract, tests, economy simulation and testnet deployment exist. **The web client does not exist yet**, so today you try it through the commands below.

## The problem it addresses

Games with on-chain economies are usually a token with a game attached, and they need a wallet before the first click. Here the economy is the game, and it keeps running by its own rules without a developer:

- **NPCs with wallets**: villagers earn wages and spend them, and their willingness to pay rises when a good is scarce. Merchants have their own money and reprice by a readable rule.
- **Player-owned market**: scarcity and gluts come from what people buy. No admin sets a price.
- **No wallet needed**: the browser makes a key, the key's implicit account owns the stall, and a pool of public gas keys pays. Players never see a transaction.
- **NFTs as accounts**: a stall is a NEP-171 token that holds its own money, stock, reputation and spot. Sell the token and all of it goes along. The founder earns a royalty on every resale.

## Try it

Deployment details, transactions and gas figures are in [docs/testnet-run.md](docs/testnet-run.md). Needs [near-cli-rs](https://github.com/near/near-cli-rs) for the read commands, Node 20+ for the script, and Rust with [cargo-near](https://github.com/near/cargo-near) for the tests.

**See the living world.** Do this:

```sh
near contract call-function as-read-only lantern-row.testnet world json-args '{}' network-config testnet now
```

You see the current night, tonight's event and the next one, Dock prices, 12 villagers with wallets and wants, and the merchants' stock and prices.

**Check that nobody can patch it.** Do this:

```sh
near account list-keys lantern-row.testnet network-config testnet now
```

You see no access keys, so nobody can sign for the contract account or replace its code.

**Check that no coin ever appeared.** Do this:

```sh
near contract call-function as-read-only lantern-row.testnet audit json-args '{}' network-config testnet now
```

You see `total` equal to `founding`: 1,000,000.

**See the leaderboard and what a stall token looks like.** Do this:

```sh
near contract call-function as-read-only lantern-row.testnet leaderboard json-args '{"limit":10}' network-config testnet now
near contract call-function as-read-only lantern-row.testnet nft_token json-args '{"token_id":"1"}' network-config testnet now
```

You see NPC merchants and players ranked by net worth, and a token whose metadata is computed from the stall's live state.

**Play a real night from the command line**, with any testnet account of your own. Do this, replacing `you.testnet`:

```sh
near contract call-function as-transaction lantern-row.testnet play json-args '{"action":"[{\"found\":{\"name\":\"My Stall\"}}]"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as you.testnet network-config testnet sign-with-keychain send
near contract call-function as-read-only lantern-row.testnet player json-args '{"account":"you.testnet"}' network-config testnet now
```

You see `minted` with your stall id, then your stall with 3,000 coin. Next, buy stock and set a price, replacing `7` with your stall id:

```sh
near contract call-function as-transaction lantern-row.testnet play json-args '{"action":"[{\"buy\":{\"stall\":7,\"good\":0,\"qty\":5,\"max_cost\":1000}},{\"price\":{\"stall\":7,\"good\":0,\"price\":58}}]"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as you.testnet network-config testnet sign-with-keychain send
```

Then end the night, once 20 seconds have passed since the last one ended. Anyone may do this:

```sh
near contract call-function as-transaction lantern-row.testnet advance_night json-args '{}' prepaid-gas '150 Tgas' attached-deposit '0 NEAR' sign-as you.testnet network-config testnet sign-with-keychain send
near contract call-function as-read-only lantern-row.testnet night_log json-args '{}' network-config testnet now
```

You see every sale of the night that just ended, as `[villager, stall, good, price]`, perhaps some of them at your stall.

**Run the tests and the simulation.** Do this:

```sh
cd contract
cargo test
cargo test --test economy_sim -- --nocapture --test-threads=1
```

You see all tests pass, then tables of hundreds of simulated nights: money, sales, prices, and how ten bot strategies end up. Results are in [docs/ECONOMY.md](docs/ECONOMY.md).

**Build the contract.** `contract/build.sh` builds the wasm, checks it for local paths and prints its sha256, which is also in `contract/WASM_SHA256`.

## Rules and API

[SPEC.md](SPEC.md) holds the rules, the numbers and the full API for clients.

## What is real and what is not

- **Real, on NEAR testnet only:** the contract, the economy, the villagers' and merchants' wallets, the NFTs and every game action. Nothing here runs on mainnet.
- **Not real money:** coin is an integer inside the contract. It has no value and is not a token. Testnet NEAR only pays for gas and storage.
- **NPCs are rules, not AI.** Villagers and merchants follow the deterministic rules in [`contract/src/night.rs`](contract/src/night.rs). No model or AI service is involved at runtime.
- **Simulated:** the economy evidence comes from bots driving the real contract code in the SDK's mock VM, not from people playing. Gas figures come from real testnet transactions.
- **Not done:** the web client, and any play with real humans. The contract has not been audited.
- **Public gas keys:** the client's function-call keys are deliberately public. Anyone can spend their allowance, which stops free play until someone refills it. They cannot touch game state, because every action needs the player's own signature. Details and other limits are in [SPEC.md section 14](SPEC.md#14-honest-limits).

## How this was made

All code and documentation in this repository were written by an AI coding agent (Claude) working from a human's game brief, and were not reviewed line by line by a human. The tests, the simulation and the testnet run are the evidence that it works. Everything was written fresh for this project during the hackathon window.

Libraries: [near-sdk](https://github.com/near/near-sdk-rs) and near-contract-standards (contract), ed25519-dalek and near-parameters (tests only). Node's standard library in the scripts.

## License

MIT, see [LICENSE](LICENSE).

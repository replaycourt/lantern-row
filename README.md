<p align="center"><img src="web/og.png" alt="Lantern Row: a lantern-lit market street at night" width="720"></p>

# Lantern Row

**A night market that never closes.** Run a stall on a shared, lantern-lit street where twelve villagers with their own wallets, tastes and memories walk the row every 20 seconds and buy what they need. Price your tea right, out-trade The Quiet Kettle, grow your stall, and sell it whole when you are done. The entire economy is one NEAR contract with no owner and no way to patch it. Built at NEAR HACKATHON for the `games` and `nfts` tracks.

**Play now:** https://replaycourt.github.io/lantern-row/web/ (testnet, play money, no sign-up)

<p align="center"><img src="docs/shots/mid-night.png" alt="Villagers walking the row at night, coins flying" width="720"></p>

## How to play

1. **Tap *Open your stall*.** See a stall with your name on it appear on the street, with 3,000 coin inside. No wallet, no sign-up: your browser made a key, and that key owns the stall.
2. **Tap *Restock*.** See tea, oil and dumplings land on your counter, bought from the Dock at tonight's prices.
3. **Tap *Smart prices*, or nudge a price with − and +.** See the price appear on your counter, just under the cheapest merchant.
4. **Wait for the clock.** See Bao, Cora and the others walk the row, stop at stalls, and buy, with coins flying to your stall and little remarks: "At last, tea!" or "Too dear!"
5. **Read the night summary.** See what sold, who walked away and why, and what it cost you in rent.
6. **Watch the banner.** See a festival or a storm announced a night ahead, with bunting and fireworks or rain and dim lanterns when it comes. Stock up before a festival; price up in a storm.
7. **Open *Deed*.** See your stall as the token it is: its coin, goods, reputation and spot. Grow it, move it nearer the gate, or list it for sale and watch the "FOR SALE" sign go up.
8. **Open *Ranks*.** See yourself among the six merchants and every other player who ever opened a stall here. Open the page in a second browser and you will find your first stall already on the street.

Two minutes is enough to learn it. The merchants are the thing to beat: they reprice by readable rules (tap any stall to see their prices and why), so a watchful player undercuts them.

## Why NEAR

- **An unpatchable shared world.** The contract account has no access keys. Nobody, including its author, can change a rule, mint coin or move a stall. 1,000,000 coin existed at founding and `audit()` shows the same total every night since. The economy keeps running without a developer: villagers earn wages, merchants restock from their own money, rent and tax flow back to the Treasury.
- **NFTs that hold money and stock.** A stall is a NEP-171 token (metadata, approvals, enumeration, payouts), and the token *is* the account: coin, goods, prices, reputation and spot are stored under the token id. Transfer it, and all of it goes along. Its picture and description are computed from the live stall. The founder gets a 5% royalty on every resale, on the row in coin and through `nft_payout` in NEAR.
- **No-wallet play through scoped keys.** The browser's Ed25519 key signs `lantern-row:v1:<contract>:<nonce>:<actions>`; a pool of public function-call keys on a gas account relays it to `act`, which checks the signature. The relay keys can only call `act` and `advance_night`, so they cannot change anything a player did not sign. Players never see a transaction, a seed phrase or a gas fee, and a small *Proof* drawer shows judges the account, the token and every transaction hash.
- **Cheap enough for a 20-second night.** An `act` with ten actions burns under 3 Tgas; the worst-case `advance_night` with a full row and 30 nights of catch-up burns 15 Tgas. Clients call `advance_night` themselves when a night is due, so the town is as alive as its visitors.

## Run it yourself

The client is a static site with no build step and no dependencies: `web/index.html`, CSS, and ES modules. Serve the repository root with any static server and open `/web/`:

```sh
python3 -m http.server 8765 --bind 127.0.0.1
# then open http://127.0.0.1:8765/web/
```

It needs a browser with Ed25519 in WebCrypto: Chrome 137+, Safari 17+, Firefox 130+. The page has a strict Content-Security-Policy (`default-src 'self'`; connections only to the two testnet RPC hosts) and loads nothing from a CDN.

**Tests.** Unit tests for the client's logic and the NEAR layer (signing, borsh, key rotation, the action queue) run with Node 20+ and no install:

```sh
node --test 'web/test/*.test.mjs'
```

**End-to-end on testnet.** `scripts/e2e-browser.mjs` drives the real page in two headless Chrome profiles at once (one laptop, one phone) through the DevTools protocol: each founds or resumes a stall, restocks and reprices through the buttons, watches ten nights pass, reads the summary, opens the deed, lists the stall and withdraws it, and checks the other player on the leaderboard. It prints every transaction hash.

```sh
node scripts/e2e-browser.mjs --url http://127.0.0.1:8765/web/ --nights 10 --out e2e-out
```

The last run and its transactions are in [docs/testnet-run.md](docs/testnet-run.md).

**Contract.** `contract/` holds the Rust source, tests and economy simulation. `contract/build.sh` reproduces the deployed wasm hash. [SPEC.md](SPEC.md) has every rule, number and the full API; [docs/ECONOMY.md](docs/ECONOMY.md) has the simulation evidence.

## What is real and what is not

- **Testnet only.** The contract is `lantern-row.testnet`. Nothing runs on mainnet, and nothing here should.
- **Play money.** Coin is an integer inside the contract. It has no value and is not a token. Testnet NEAR only pays gas and storage.
- **The gas keys are public, on purpose.** They are in [`web/js/gas-keys.js`](web/js/gas-keys.js) with the reasoning. Anyone can spend their allowance, which stops free play until the pool is refilled. They cannot touch game state. The gas account's full-access key is not in the repository.
- **Economy evidence comes from bots, not humans.** The tables in `docs/ECONOMY.md` come from scripted strategies driving the real contract code. They show the rules hold together; they do not show that people find it fun. The nights played by humans so far are the author's own.
- **NPCs are rules, not AI.** Villagers and merchants follow deterministic rules in the contract. No model runs at play time.
- **AI-generated code.** All code and documentation in this repository were written by an AI coding agent (Claude) from a human's game brief, during the hackathon window, and were not reviewed line by line by a human. The tests, the simulation, the testnet run and the end-to-end check are the evidence that it works. The contract has not been audited.
- **Known limits** (randomness, griefing of licences, the account register, idle towns) are listed honestly in [SPEC.md section 14](SPEC.md#14-honest-limits).

The same author also entered the independent project ReplayCourt, https://github.com/replaycourt/replaycourt, in this hackathon.

## Credits

Original art, drawn in code (Canvas 2D and inline SVG). System fonts. Sounds synthesised in WebAudio. Libraries: near-sdk and near-contract-standards in the contract; ed25519-dalek and near-parameters in its tests only. The client and the scripts use nothing beyond the browser and Node's standard library.

## License

MIT, see [LICENSE](LICENSE).

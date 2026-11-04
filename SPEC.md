# Lantern Row: specification

Every number below is a constant in [`contract/src/config.rs`](contract/src/config.rs). The contract has no owner, no admin method and no upgrade method, so none of them can change after deployment. The view `config()` returns them to clients.

## 1. The game

Every player owns one stall on a lantern-lit street. A night lasts 20 seconds. During a night a player buys goods at the Dock and sets prices. When the night ends, 12 villagers walk the row and buy. Profit buys more stock, a better spot or a bigger stall. The leaderboard ranks stalls by net worth, against each other and against 6 NPC merchants who trade by the same rules.

All coin is an integer inside the contract. It has no market value and is not a token. It is not NEAR.

## 2. What happens when a night ends

`advance_night` processes these steps, in this order, for each night it simulates:

1. **Wages.** The Treasury pays each villager their wage (see section 5).
2. **The walk.** Villagers walk in a shuffled order and buy (section 5). Each sale pays 5% tax (rounded up) to the Treasury.
3. **Closing.** Each stall on the row loses goods to spoilage, pays rent to the Treasury, loses 3% reputation. A broke player who is still active gets relief. A player stall nobody acted on for 60 nights loses its spot.
4. **Dock dues.** The Dock hands 40% of its money above 20,000 to the Treasury.
5. **Merchants.** NPC merchants reprice and restock from whatever the Dock has left (section 8). They buy after players, so a player who gets there first has the pick of the Dock.
6. **Next night.** If the current event has run its nights, the announced one takes effect and a new one is announced. Dock heat decays 30% and Dock supply resets.

`advance_night` can be called by anyone once the night has elapsed. Called early it does nothing and returns `advanced: 0`, so racing clients do no harm. It simulates at most 30 nights per call. Nights beyond that are not simulated: the town slept through them, the clock restarts and no backlog remains. There is no separate loop over all stalls: the row is loaded once, processed in memory, saved once, and at most 4 stalls off the row get their rent settled.

## 3. Goods

| id | good | fair price | Dock base | Dock supply/night | heat that doubles the price | spoils/night | nights between needs |
|---|---|---|---|---|---|---|---|
| 0 | tea | 60 | 30 | 12 | 120 | 2% | 2 |
| 1 | lamp oil | 90 | 46 | 7 | 80 | 1% | 3 |
| 2 | dumplings | 40 | 20 | 18 | 180 | 15% | 1 |
| 3 | silk | 350 | 170 | 3 | 24 | 0 | 8 |
| 4 | charms | 180 | 90 | 5 | 45 | 0 | 5 |

## 4. Money: a closed loop

- 1,000,000 coin exist, split at founding: Dock 40,000, each villager 1,200, each merchant 12,000, the Town Treasury the remaining 873,600.
- Coin only moves between: the Treasury, the Dock, villager wallets, stalls, and purses (section 10). No code path creates or destroys it. The view `audit()` sums all of them, and the tests check that the sum never changes.
- A new stall gets a one-off starter grant of 3,000 from the Treasury: one grant per account, at most 100 player stalls, none while the Treasury is below 150,000. Further stalls of the same account start with nothing.
- The flow: Treasury → wages → villagers → stalls (minus tax) → Dock → dues → Treasury. Rent and upgrade fees also go to the Treasury.

**Rent per night**: `spot_rent + 0.5% of the money above 500`, but it never takes a stall below 500. `spot_rent` is 24 at the front of the row and 1 at the back. Stalls off the row pay only the percentage, settled a few at a time.

**Relief.** A merchant below 1,500 gets 1,500 from the Treasury, so the row never goes dark. A player stall on the row with money plus goods under 100, whose owner acted in the last 10 nights, gets 400, at most once per 30 nights. Starter grants and relief are not "earned" coin: they cannot pay for buying another stall.

## 5. Villagers

Twelve named villagers (the `villagers` array in `world()`), each with a wallet on chain, a wage from 190 to 360 per night and a taste per good, stored in the contract.

- **Wage**: fixed, paid in full while the Treasury holds at least 300,000 and proportionally less below (down to 25%). A wallet at 12 nights of wage gets no more until it spends.
- **Need**: a villager wants a good when `nights since last bought + spare ≥ need period`. The period is the good's base period × 100 / taste, at least 1. `spare` is the wealth bonus: one night per 25 points of wealth above 100.
- **Willingness to pay**: `fair × taste% × (100 + 15 × nights overdue, at most 8)% × wealth% × event%`. Wealth is `60 + 40 × wallet / (5 × wage)`, between 60 and 150. So a good nobody could buy gets dearer every night, by the villagers' own decision.
- **The walk**: looks at a stall on the row with chance `footfall(spot) = 100 − 3 × spot` percent, up to 10 stalls from the front. A remembered stall gets 25 points more chance and does not count against the 10.
- **The choice**: for each want, most overdue first, at most 4 goods a night, buy one unit where `willingness × (100 + rep/100 + memory)% − price` is largest, among stalls with stock, a price, spare service and a price within reach. A price of 0 means not for sale.
- **Memory**: each villager remembers 3 stalls. A sale adds 2% (at most 8%), and a remembered stall that did not serve them fades 1% per night. Memory lives with the villager, keyed by stall id, so it stays with the token through a sale.
- **Refusal**: when a stall had the good but asked more than the villager would pay, the cheapest such stall hears about it, even if the villager then buys elsewhere: −3 reputation and an entry in `refusals`.

## 6. The Dock

An NPC wholesaler. Its prices rise with what was bought and fall with time.

- Price of `q` units: `ceil(base × factor% × (q·s + h·q + q(q−1)/2) / s)`, where `h` is current heat and `s` is the heat that doubles the price. One big order costs the same as many small ones (rounding only ever favours the Dock).
- Buying adds `q` to heat and removes it from tonight's supply. Heat falls 30% per night.
- `sell_back` pays 40% of the current unit price, lowers heat and returns the goods to tonight's supply. It always loses money compared with buying at the same moment.

## 7. Stalls

| size | capacity (units) | customers/night | cost | counted in net worth |
|---|---|---|---|---|
| 0 | 40 | 10 | | 0 |
| 1 | 80 | 14 | 5,000 | 2,500 |
| 2 | 140 | 18 | 14,000 | 9,500 |
| 3 | 220 | 24 | 36,000 | 27,500 |

**Spots.** The row has 24 spots, 0 at the front. A new stall takes the worst free spot, or none if the row is full. `move` to a free spot further forward costs `12 × (24 − spot)²` (12 at the back, 6,912 at the front). Moving back to a free spot is free. Moving onto an occupied spot costs double and swaps the two stalls. A displaced stall takes the mover's old spot, or the worst free one, or leaves the row. A merchant cannot be pushed off a full row. Mover and displaced stall both have a 5-night cooldown.

**Reputation** runs from 0 to 1,000, starts at 200 for players and 250 for merchants, gains 4 per sale, loses 3 per refusal and 3% per night.

**Net worth** = money + goods at Dock base price + the size value above + half the spot's fee.

## 8. NPC merchants

Six stalls with their own money and their own rule, in `run_merchants` in [`contract/src/night.rs`](contract/src/night.rs). They are tokens 1 to 6 owned by the contract itself, which has no keys, so nobody can operate or take them. For each good they carry:

- Villagers refused it at least as often as they bought it: price −4%.
- Sold out: price +8%. Otherwise sold at least a third of what it had: price +3%.
- No interest at all: price −3%, one night in two.
- Never below 125% of the Dock's current unit price, never above 260% of fair.
- Skips restocking when the Dock costs more than its price. Otherwise it refills to its target, at most 30% of its money per good. It holds 60% more the night before a festival.

`notes[good]` in the stall view holds the reason behind each price, an index into `config().notes`, for a tooltip.

## 9. Events

Rolled from `env::random_seed()` hashed with the night number. The next event is rolled when the current one starts, so it is public at least one night ahead, as `event_next` in `world()`. `event_left` says how many nights the current one still lasts, counting tonight.

| event | odds | nights | effect |
|---|---|---|---|
| `{"festival":{"good":g}}` | 30% | 2 | everyone wants that good now and buys 2, willingness to pay ×1.3 |
| `{"storm":{"good":g}}` | 25% | 3 | Dock supply of it ×0.25 (at least 1), price ×1.5 |
| `{"bumper":{"good":g}}` | 15% | 2 | Dock supply of it ×2, price ×0.7 |
| `"payday"` | 10% | 1 | wages ×1.5, willingness to pay ×1.1 |
| `"quiet"` | 20% | 2 | nothing |

## 10. The stall is the NFT

A stall is a NEP-171 token: core, NEP-177 metadata, NEP-178 approvals, NEP-181 enumeration, NEP-199 payouts, and NEP-297 events. Its id is the stall id as a string.

- **The token is the account.** Money, stock, prices, reputation, spot and size are stored under the token id. `nft_transfer` changes the owner and nothing else, apart from clearing the approvals and any listing.
- **Dynamic metadata.** `nft_token` computes title, description, an SVG picture (a data URI with a matching `media_hash`, one lantern per size, brighter with reputation) and `extra` (the full stall view as JSON) from the live state.
- **Founder royalty, in NEAR.** `nft_payout` and `nft_transfer_payout` give whoever minted the stall 5% of a marketplace sale.
- **Sale on the row, in coin.** `list` puts a stall up at an asking price. `buy_stall` pays from one of the buyer's stalls and moves the token to the buyer's account: 5% tax to the Treasury, 5% royalty to the founder's purse, the rest to the seller's purse.
- **Purses** exist because the sold stall cannot hold its own sale price: it now belongs to the buyer. A purse belongs to an account, and `collect` moves it into any stall that account owns.
- **A listed stall is frozen.** It keeps selling to villagers, but its owner cannot buy, sell back, move or upgrade until `unlist`. `buy_stall` also takes `max_price` and `min_money`, in case the stall changed while the buyer was looking.
- **Grants cannot be laundered.** A stall can only pay for another stall out of `earned`: coin from villagers or collected from a purse. A throwaway stall cannot hand its grant to anyone.
- **No stall-to-stall money.** Buying a stall is the only way coin goes from one player to another. Displacement fees go to the Treasury.

## 11. Playing without a wallet

The browser generates an ed25519 key. The player's account is the NEAR implicit account of that key: the 64 lowercase hex characters of the public key. That account owns the stall NFT, whether or not it exists on chain yet.

Play goes through `act`, signed by the key and relayed by anyone. Gas comes from a pool of function-call keys on a separate gas account, limited to `act` and `advance_night` on this contract, each with a capped allowance. **These keys are public by design.** Anyone can take them and spend the allowance. On testnet that costs nothing but a refill, and it cannot touch any game state, because every `act` still needs the player's own signature.

A wallet that buys a stall plays through `play`, signing its own transactions. An implicit account that gets funded and holds its key can use `nft_transfer` directly.

## 12. API

Numbers in JSON are plain numbers. They all stay below 2^53: balances cannot exceed the founding money, and nonces stop at 2^53 − 1. The NEP views keep the strings their standards require (`nft_total_supply`, `nft_payout`).

### 12.1 Write methods

| method | who | gas to attach | returns |
|---|---|---|---|
| `act(player_pubkey, nonce, action, signature)` | anyone relaying | 20 Tgas (measured: 2.7 to 3.8) | `ActOutcome` |
| `play(action)` | an account signing for itself | 20 Tgas | `ActOutcome` |
| `advance_night()` | anyone | 60 Tgas (measured worst case: 15.4) | `AdvanceOutcome` |

**Signing `act`.** `player_pubkey` and `signature` are lowercase hex. `action` is a string holding a JSON array of actions, at most 16 actions and 2,048 bytes. Sign the UTF-8 bytes of

```
lantern-row:v1:<contract account id>:<nonce>:<action>
```

The view `signing_text(nonce, action)` returns this text for comparison. `nonce` must be greater than the player's last one, and gaps are fine. A new key starts from 1. Read the current one with `player(account).nonce`.

**Failure.** A bad signature, a used nonce or malformed JSON fails the transaction and spends nothing. A refused game action does not fail it: earlier actions in the batch stay applied, the nonce is spent, and `error` says why. A key that owns nothing and founds nothing leaves no record at all.

```jsonc
// ActOutcome
{ "applied": 2, "total": 3, "error": "not enough money", "night": 41, "nonce": 12, "minted": [] }
// AdvanceOutcome: advanced 0 means it was not due yet
{ "advanced": 1, "slept": 0, "night": 42, "ends_ms": 1800000040000 }
```

### 12.2 Actions

The contract computes every price itself. The `max_*` and `min_*` fields only say what the player agreed to, and a worse result refuses the action.

| action | effect |
|---|---|
| `{"found":{"name":"Silk Lantern"}}` | mints a stall for this account; `minted` holds the id. Names: 1 to 24 letters, digits, spaces, `-`, `'` |
| `{"buy":{"stall":7,"good":0,"qty":5,"max_cost":200}}` | buys from the Dock |
| `{"sell_back":{"stall":7,"good":2,"qty":3,"min_pay":10}}` | sells to the Dock at 40% |
| `{"price":{"stall":7,"good":0,"price":70}}` | sets the asking price; 0 takes it off sale; at most 10× fair |
| `{"move":{"stall":7,"spot":14,"max_fee":1500}}` | moves on the row |
| `{"upgrade":{"stall":7,"max_cost":5000}}` | next size |
| `{"rename":{"stall":7,"name":"New Sign"}}` | changes the name |
| `{"list":{"stall":7,"price":20000}}` | offers the stall for sale, or changes the asking price |
| `{"unlist":{"stall":7}}` | withdraws it |
| `{"buy_stall":{"with":3,"target":7,"max_price":20000,"min_money":5000}}` | buys a listed stall |
| `{"collect":{"stall":7}}` | empties this account's purse into the stall |
| `{"transfer":{"stall":7,"to":"bob.testnet"}}` | gives the token away, by signature instead of `nft_transfer` |

### 12.3 Views

| view | returns |
|---|---|
| `world()` | everything to draw the street (below) |
| `player({"account": "<hex or account>"})` | `{account, nonce, purse, founded, stalls: [StallView]}` |
| `stall({"id": 7})` | `StallView` or null |
| `stalls({"from": 1, "limit": 50})` | `[StallView]` by id, including stalls off the row |
| `leaderboard({"limit": 25})` | `[{rank, id, name, npc, owner, worth, money, spot, tier, rep}]` |
| `night_log({"night": 41})` | `NightLog` for one of the last 6 nights; without `night`, the latest |
| `dock_quote({"good": 0, "qty": 5})` | current cost of that purchase |
| `audit()` | `{founding, total, treasury, dock, villagers, stalls, purses, grants_paid}`; `total` always equals `founding` |
| `config()` | all rules: `goods`, `spots`, sizes, rates, the merchant `notes`, limits |
| `signing_text({"nonce": 1, "action": "[]"})` | the exact text to sign |
| NEP views | `nft_token`, `nft_metadata`, `nft_total_supply`, `nft_tokens`, `nft_supply_for_owner`, `nft_tokens_for_owner`, `nft_is_approved`, `nft_payout` |

```jsonc
// world()
{
  "night": 41, "now_ms": 1800000031000, "ends_ms": 1800000040000,
  "due": false,                    // true once advance_night would do something
  "event": "quiet",                // in force tonight
  "event_left": 1,                 // nights it still lasts, counting tonight
  "event_next": {"festival": {"good": 3}},
  "treasury": 870000, "dock_money": 24000,
  "dock": [{"price": 33, "left": 12, "heat": 9, "factor_pct": 100}],   // per good
  "row": [ /* StallView, front of the row first */ ],
  "villagers": [{"id": 0, "name": "Ansel", "trade": "dock hand", "wallet": 1200, "wage": 200,
                 "taste": [100,70,120,0,40], "unmet": [1,0,2,4,0],
                 "wants": [2,0],             // tonight, most overdue first
                 "memory": [[7,6]]}],        // stall id, percent bonus
  "listings": [[7, 20000]],        // stall id, asking price
  "stalls_total": 8, "licences_left": 98, "licences_tonight": 4, "nights_slept": 0,
  "last": { /* NightLog of the night that just ended */ }
}

// StallView
{
  "id": 7, "name": "Silk Lantern", "npc": false,
  "owner": "<64 hex>", "founder": "<64 hex>",
  "spot": 21,                      // null: off the row, no customers
  "footfall": 37, "money": 3120,
  "stock": [8,5,10,2,3], "price": [55,84,36,320,170],   // per good; price 0: not for sale
  "rep": 214, "tier": 0, "capacity": 40, "service": 10,
  "worth": 3990, "listed": null, "rent_next": 16,
  "sold_last": [2,1,4,0,1],        // per good, last night
  "notes": [0,0,0,0,0],            // merchants only: index into config().notes
  "revenue": 980, "earned": 931, "customers": 14, "rent_paid": 60,
  "last_action": 41, "moved_at": 0, "minted_night": 38,
  "holders": []                    // latest previous owners, oldest first
}

// NightLog: everything needed to animate a night
{
  "night": 40, "event": "quiet",
  "wages": 2930, "tax": 150, "rent": 380, "dues": 900, "relief": 0,
  "sales": [[3,7,2,36]],           // villager, stall, good, price, in walking order
  "refusals": [[5,2,3]],           // villager, stall, good: too dear here
  "missed": [[1,4]],               // villager, good: no stock anywhere on their walk
  "restocks": [[2,2,8,180]],       // merchant stall, good, units, cost
  "spoiled": [[2,2,2]],            // stall, good, units
  "evicted": []                    // stalls that lost their spot
}
```

### 12.4 Client loop

1. `config()` once. Load the local key, or make one. `player(account)` for the stall and nonce. If there is no stall, `act` a `found`.
2. Poll `world()` every second or two. Use `now_ms` and `ends_ms` for the timer, not the browser clock.
3. When `due` is true, call `advance_night` with a pool key. When `night` changes, animate `last`.
4. Between nights, batch the player's changes into one `act`. Keep a local nonce and increase it yourself. Transactions can overtake each other, and a view right after a transaction can lag behind it, so `player().nonce` may still show the old value. For the same reason, trust `ActOutcome` over the next view.
5. Rotate through the pool keys. If a key's allowance runs out, use another. The allowance is charged for the attached gas up front at a pessimistic price and refunded afterwards, so attach no more than the table above says.

## 13. Bounds

| limit | value | why |
|---|---|---|
| Nights simulated per `advance_night` | 30 | gas |
| Spots on the row, stalls a villager looks at | 24, 10 + 3 remembered | gas |
| Player stalls in total, new ones per night | 100, 4 | storage, grant budget |
| Accounts on the register | 400 | storage: the contract pays for it |
| Stalls per account, listings on the board, approvals per token | 8, 32, 4 | storage, gas |
| Night logs kept | 6 | storage |

Storage is paid by the contract's own balance, and players never attach any. Everything that grows is capped above, so the balance needed is bounded: about 3.5 NEAR for the code and at most about 1 NEAR of state.

## 14. Honest limits

- **Public gas keys.** Anyone can burn the pool's allowance. Play stops until someone refills it. Game state is not at risk.
- **Randomness.** `env::random_seed()` is known to the block producer. Events and the villagers' shuffle could be influenced by a validator. This is fine for a testnet game with worthless coin and would not be fine with real stakes.
- **Griefing.** Someone with many keys can take the licences: at most 4 a night and 100 in total, and then nobody can found a stall. Stalls idle for 60 nights give up their spot on the row, but the licence stays used. Someone can also fill an account's 8 stall slots by sending it stalls.
- **The account register** holds 400 accounts and nobody can be removed. After that, tokens can only move between accounts already on it.
- **Merchants depend on relief** when players out-trade them. See [docs/ECONOMY.md](docs/ECONOMY.md).
- **The town only moves when someone calls `advance_night`.** With nobody around it stands still, and the next call simulates up to 30 nights. Clients do this, so the world is as alive as its visitors.
- **The rules are final for this deployment.** A wrong number stays wrong. Fixing it means a new deployment under a new account, with a new world.

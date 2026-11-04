# Economy evidence

Bots drive the real contract code through the SDK's mock VM: same rules, same numbers, no separate model of the game. Reproduce every table below with:

```sh
cd contract
cargo test --test economy_sim -- --nocapture --test-threads=1
```

The runs are deterministic, because the mock's random seed comes from a fixed counter. They are bots, not people. They show the rules hold together and which simple strategies work. They do not show the game is fun.

## The bots

| bot | what it does each night |
|---|---|
| Passive | stocks up once at fair prices, then never touches the stall |
| Restocker | refills a fixed mix at fixed fair prices |
| Fixed(p) | the same, at p% of fair |
| Watcher | prices 3% under the cheapest rival, not below 95% of fair or 125% of the Dock, at most 140% of fair |
| **Trader** | Watcher, plus it reads the event forecast and reinvests in size and in a mid-row spot |
| Undercutter | always the cheapest, down to 2% over the Dock |
| Gouger | asks 250% of fair |
| Cornerer(g) | buys all of one good the Dock has, asks 200% of fair |
| Flooder(g) | buys all of one good, sells at 5% over the Dock |
| FrontRunner | spends on the best spot it can afford first, then refills at fair prices |
| Dumplings, SilkOnly | sell one good at a thin margin |

## Results

**Money is conserved.** `audit().total` equals 1,000,000 at every check, in every scenario, and in the random-play tests in `tests/invariant.rs`, which send random actions (many refused) for hundreds of nights.

**The town lives without players**, for 2,000 nights:

| night | treasury | merchants, total | sales/night | price vs fair | merchant money, low to high |
|---|---|---|---|---|---|
| 401 | 703,516 | 242,972 | 23.6 | 135% | 34,620 to 57,342 |
| 2001 | 674,142 | 271,610 | 23.8 | 136% | 35,759 to 65,352 |

No inflation and no collapse: the price index stays flat because coin is fixed and rent and dues return it to the Treasury. Without competition merchants settle about a third above fair.

**A judge alone for two minutes** (six nights, 8 seeds, one Trader against the merchants): profit of +410 to +1,334 on 3,006, about 14% to 44%. Sales start on the first night in every seed. In a town that has already run for 600 nights, a newcomer does better, because the merchants have drifted up and are easy to undercut: +1,004 to +2,393.

**Ten strategies on one row**, 1,000 nights, average net worth over 6 seeds. The Trader finished first in all 6:

| bot | net worth | |
|---|---|---|
| Trader | 43,172 | |
| Watcher | 17,381 | reinvesting and reading the forecast are worth more than double |
| Undercutter | 9,848 | |
| Cornerer(silk) | 9,540 | |
| FrontRunner | 9,106 | |
| Restocker | 6,270 | |
| Gouger | 2,520 | |
| SilkOnly | 2,433 | |
| Dumplings | 1,246 | |
| Passive | 537 | down to the rent floor, off the row after 60 nights |

Meanwhile: 32 to 33 sales a night, prices 92% to 95% of fair, Treasury about 850,000. The merchants are the weak side here: they fall to between about 2,000 and 7,500 coin, and Treasury relief of about 37 coin a night keeps them trading. They stay alive partly on relief when players out-trade them.

**Head to head**, Trader against Passive, 10 seeds, 300 nights: the Trader ends between 92,090 and 105,572, Passive at about 1,300.

**Fixed-price refilling is not a solved game.** Net worth after 500 nights:

| price vs fair | alone with the merchants | in the league |
|---|---|---|
| 70% | 6,847 | 4,138 |
| 80% | 20,951 | 15,044 |
| 90% | 35,323 | **21,772** |
| 100% | 49,319 | 4,823 |
| 110% | 59,263 | 1,363 |
| 120% | 68,846 | 866 |
| 130% | **73,633** | 1,728 |
| 140% | 61,803 | 1,254 |
| 170% | 9,419 | 1,575 |
| 200% | 9,078 | 1,754 |

The right price depends on who else is on the row, and a price that is good alone fails in a crowd. An attentive player beats the best fixed level alone (142,202 against 73,633 at 500 nights), and beats a field of refillers (49,760 against 14,644 on average).

**Spending profit pays, mostly on size.** Net worth after 500 nights, at 120% of fair alone and 90% in the league. Size 3 is not reached in the league within 500 nights:

| spot | size | alone | league |
|---|---|---|---|
| 23 (back) | 0 | 68,846 | 21,772 |
| 10 | 0 | 69,166 | 25,699 |
| 0 (front) | 0 | 67,102 | 26,390 |
| 23 | 2 | 101,831 | 30,555 |
| 10 | 2 | 122,753 | 39,890 |
| 0 | 2 | 123,841 | 38,229 |
| 23 | 3 | 113,082 | |
| 0 | 3 | 142,703 | |

A spot is worth little to a small stall and a lot to a big one, which has the capacity to serve the extra walkers. The front costs rent and a large fee, so the middle of the row is the better buy in a crowd.

**Scarcity and gluts come from play.** Average merchant asking price over 300 nights:

| good | no players | 6 cornerers | 1 flooder |
|---|---|---|---|
| tea | 97.0 | 112.6 | 82.3 |
| lamp oil | 105.6 | 109.8 | 94.1 |
| dumplings | 64.0 | 65.9 | 47.8 |
| silk | 356.0 | 383.2 | 325.8 |
| charms | 273.4 | 272.1 | 240.1 |

One flooder lowers the merchants' prices by 8% to 25%. Six cornerers raise them by 3% to 16% on four goods and not at all on charms. That is weak, probably because a small stall soon fills up and its capacity ends the corner. In a storm on dumplings, the Dock's unit price rises from 22.8 to 33.4 and villagers leaving without any nearly double, from 0.23 to 0.43 per night. Merchants' asking prices barely move in those nights, because their price is already well above cost. **Weak spot:** scarcity is real but mild; most nights everyone finds what they want.

**Cornering does not beat trading.** One Cornerer next to a Trader, for each good, 4 seeds, 500 nights. The Trader ends between 131,265 and 145,811 in all 20 runs. The Cornerer averages 327 (tea), 1,080 (lamp oil), 54 (dumplings), 9,423 (silk), 10,724 (charms). On perishable and cheap goods it goes broke.

**Abandoned stalls recycle.** All 100 licences founded, then abandoned: the grants take the Treasury to 573,159. Over 1,500 nights rent and dues bring it back to 627,114. Every idle stall has left the row, and the merchants hold most of the rest of the coin. Sales per night hold at 23.7. The stalls keep 500 each at the rent floor, about 50,000 coin in total, permanently parked.

**A crowded row** (24 Traders, 18 on the row, 6 off it, 600 nights): 32 sales a night, prices at 99% of fair, stalls worth between about 250 and 21,600. Those off the row sit at about 2,230, slowly paying rent. There is no collapse, but the spread is wide and several stalls barely survive. Merchants get relief of about 50 coin a night.

## Tuning: what the evidence changed

The first parameter set failed. These are the changes, in order, and why:

1. **Margins too thin.** Dock prices were about 57% of fair, rent was 1% of money per night, and merchants cut prices every night without a sale. One Trader lost money in its first six nights (3,006 to 2,391), merchants fell from 12,000 to about 1,500, and a Trader was worth only 5,668 after 300 nights. Dock prices went to about 50% of fair, wealth rent to 0.5%, spoilage down, and merchants now cut when villagers refuse, not whenever nothing sold.
2. **Money stuck in full wallets.** Villagers wanted a fixed amount, their wallets filled, and the Treasury collected over 90% of all coin. Now villagers with spare money want things sooner, so they spend what they earn: sales rose from about 20 to about 30 a night.
3. **A winner took everything on a crowded row.** Top-size stalls could serve more customers than existed. Service capacity flattened to 10, 14, 18, 24.
4. **Storms did nothing.** Villagers lacking dumplings were at 0.01 a night in storms. Dock supply was cut sharply, merchants hold less, and events now last 1 to 3 nights instead of one. Storms now show, but only mildly.
5. **Broke stalls stayed broke forever.** Some bots ended worth about 10 coin with no way back. Players who are still trying now get small relief.
6. **Reputation locked newcomers out.** Reputation and memory together were worth up to 30% in willingness to pay, so a late stall barely sold. Now they are worth up to 18%.
7. **Spot did nothing.** At the back and at the front stalls earned the same, because remembered stalls were always visited. Footfall is steeper now (100% to 31%), and regulars also have to make the walk.
8. **The simulation itself was unfair twice, and that misled me.** A shared storage bug made every seed after the first meaningless until fixed. Bots acted in a fixed order, so the first bot emptied the Dock each night and fixed-price refilling looked dominant: 50,000 against the Trader's 15,000. Rotating the order reversed that ranking. Earlier conclusions drawn in between were thrown away.

The bots had to be tuned too: the first Trader undercut everyone and lost its margin, a later one piled up stock that spoiled. The current one is decent, not optimal, so the table measures it against the alternatives rather than proving what the best play is.

## What this does not show

- **Nothing here tested people.** Whether it is fun is unproven.
- Parameters were tuned against these bots. A clever player may find a stronger line. Rules cannot be patched, so a real exploit would stay until a new deployment.
- Prices settling a third above fair without players means the "fair price" shown to players is only a rough guide.

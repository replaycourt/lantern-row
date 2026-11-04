//! The economy simulation: bots drive the real contract through the mock VM for hundreds of nights.
//!
//! Run with the tables printed: `cargo test --test economy_sim -- --nocapture --test-threads=1`
//! The evidence these tables produced, and the tuning it led to, is in docs/ECONOMY.md.
mod common;

use common::*;
use lantern_row::config::*;
use lantern_row::market::*;
use lantern_row::types::*;
use lantern_row::views::*;
use near_sdk::AccountId;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Strategy {
    /// Stocks up once at fair prices and never touches the stall again.
    Passive,
    /// Refills the same mix at fixed fair prices every night. No thought at all, but always there.
    Restocker,
    /// What an attentive player does: adjusts prices to what sold, reads the forecast, reinvests.
    Trader,
    /// Always the cheapest on the row, as low as the Dock allows.
    Undercutter,
    /// Stocks everything and asks two and a half times the fair price.
    Gouger,
    /// Buys all of one good the Dock has every night and asks double, trying to corner the market.
    Cornerer(usize),
    /// Spends everything on the best spot straight away, then restocks like the Restocker.
    FrontRunner,
    /// Sells only dumplings, the cheap everyday good, at a thin margin.
    Dumplings,
    /// Sells only silk, the luxury good.
    SilkOnly,
}

const ALL: [Strategy; 9] = [
    Strategy::Passive,
    Strategy::Restocker,
    Strategy::Trader,
    Strategy::Undercutter,
    Strategy::Gouger,
    Strategy::Cornerer(3),
    Strategy::FrontRunner,
    Strategy::Dumplings,
    Strategy::SilkOnly,
];

struct Bot {
    who: AccountId,
    stall: u32,
    strategy: Strategy,
    started: bool,
    ask: [u32; GOODS],
}

const MIX: [u32; GOODS] = [8, 5, 10, 2, 3];

fn rival_price(w: &WorldView, me: u32, g: usize) -> Option<u32> {
    w.row.iter().filter(|s| s.id != me && s.stock[g] > 0 && s.price[g] > 0).map(|s| s.price[g]).min()
}

/// How many units fit the room, the Dock and a budget.
fn qty_for(w: &WorldView, g: usize, want: u32, room: u32, budget: u64) -> u32 {
    let d = &w.dock[g];
    let factor = dock_price_factor(w.event, g);
    let mut q = want.min(room).min(d.left);
    while q > 0 && dock_cost(g, d.heat, q, factor) > budget {
        q -= 1;
    }
    q
}

fn held(s: &StallView) -> u32 {
    s.stock.iter().sum()
}

fn buy(id: u32, g: usize, qty: u32) -> String {
    format!(r#"{{"buy":{{"stall":{id},"good":{g},"qty":{qty},"max_cost":1000000}}}}"#)
}

fn price(id: u32, g: usize, p: u32) -> String {
    format!(r#"{{"price":{{"stall":{id},"good":{g},"price":{p}}}}}"#)
}

fn restock_at(w: &WorldView, s: &StallView, targets: [u32; GOODS], prices: [u32; GOODS], share_pct: u64) -> Vec<String> {
    let mut acts = Vec::new();
    let mut room = s.capacity.saturating_sub(held(s));
    let mut money = s.money;
    for g in 0..GOODS {
        if prices[g] != s.price[g] {
            acts.push(price(s.id, g, prices[g]));
        }
        if targets[g] > s.stock[g] {
            let budget = money * share_pct / 100;
            let q = qty_for(w, g, targets[g] - s.stock[g], room, budget);
            if q > 0 {
                acts.push(buy(s.id, g, q));
                room -= q;
                money -= dock_cost(g, w.dock[g].heat, q, dock_price_factor(w.event, g));
            }
        }
    }
    acts
}

/// What an attentive player does each night: looks at what sold, not just at the rivals. Sold a good
/// part of the stock: asks more. Sold nothing: asks less. Reads the forecast and buys ahead of it.
fn trader(w: &WorldView, s: &StallView, ask: &mut [u32; GOODS]) -> Vec<String> {
    let mut targets = [0; GOODS];
    let mut prices = [0; GOODS];
    let scale = s.tier as u32 + 1;
    for g in 0..GOODS {
        let unit = w.dock[g].price;
        let sold = s.sold_last[g] as u32;
        if ask[g] == 0 {
            // Opening price: enough under the merchants to win customers they know.
            let rival = rival_price(w, s.id, g).unwrap_or(FAIR[g]);
            ask[g] = rival * 92 / 100;
        } else if s.stock[g] == 0 || sold * 3 >= s.stock[g] + sold {
            ask[g] = ask[g] * 105 / 100 + 1;
        } else if sold == 0 {
            ask[g] = ask[g] * 95 / 100;
        }
        ask[g] = ask[g].clamp(unit * 120 / 100, FAIR[g] * 2);
        let festival_next = matches!(w.event_next, Event::Festival { good } if good as usize == g);
        let festival_now = matches!(w.event, Event::Festival { good } if good as usize == g);
        let storm_next = matches!(w.event_next, Event::Storm { good } if good as usize == g);
        let storm_now = matches!(w.event, Event::Storm { good } if good as usize == g);
        let mut p = ask[g];
        if festival_now {
            p = p * 125 / 100;
        }
        if storm_now {
            p = p * 115 / 100;
        }
        prices[g] = p;
        let mut target = MIX[g] * scale;
        if festival_next {
            target *= 2;
        } else if storm_next {
            target = target * 3 / 2;
        }
        if unit * 110 / 100 < p {
            targets[g] = target;
        }
    }
    let mut acts = restock_at(w, s, targets, prices, 40);
    // Reinvest when flush: first a better spot, then a bigger stall.
    if s.listed.is_none() {
        let here = s.spot.unwrap_or(ROW_SPOTS as u8);
        if here > 2 && w.night >= s.moved_at + MOVE_COOLDOWN_NIGHTS {
            let target = here.saturating_sub(4);
            let occupied = w.row.iter().any(|x| x.spot == Some(target));
            let fee = spot_fee(target) * if occupied { DISPLACE_FACTOR } else { 1 };
            if s.money > fee * 4 {
                acts.push(format!(r#"{{"move":{{"stall":{},"spot":{target},"max_fee":{fee}}}}}"#, s.id));
            }
        }
        if (s.tier as usize) + 1 < TIERS && s.money > TIER_COST[s.tier as usize + 1] * 2 {
            acts.push(format!(r#"{{"upgrade":{{"stall":{},"max_cost":1000000}}}}"#, s.id));
        }
    }
    acts
}

fn turn(g: &mut Game, b: &mut Bot, w: &WorldView) {
    let s = g.stall(b.stall);
    let id = b.stall;
    let acts: Vec<String> = match b.strategy {
        Strategy::Passive => {
            if b.started {
                vec![]
            } else {
                restock_at(w, &s, MIX, FAIR, 25)
            }
        }
        Strategy::Restocker => restock_at(w, &s, MIX, FAIR, 40),
        Strategy::Trader => trader(w, &s, &mut b.ask),
        Strategy::Undercutter => {
            let mut prices = [0; GOODS];
            for good in 0..GOODS {
                let unit = w.dock[good].price;
                let rival = rival_price(w, id, good).unwrap_or(FAIR[good]);
                prices[good] = (rival * 95 / 100).max(unit * 102 / 100);
            }
            restock_at(w, &s, MIX, prices, 40)
        }
        Strategy::Gouger => {
            let prices = core::array::from_fn(|good| FAIR[good] * 5 / 2);
            restock_at(w, &s, MIX, prices, 40)
        }
        Strategy::Cornerer(good) => {
            let mut acts = Vec::new();
            let q = qty_for(w, good, w.dock[good].left, s.capacity.saturating_sub(held(&s)), s.money);
            if q > 0 {
                acts.push(buy(id, good, q));
            }
            acts.push(price(id, good, FAIR[good] * 2));
            acts
        }
        Strategy::FrontRunner => {
            // The best spot it can afford, then whatever money is left goes into stock.
            let mut acts = Vec::new();
            let mut after = s.clone();
            let free = |x: u8| !w.row.iter().any(|r| r.spot == Some(x));
            let here = s.spot.unwrap_or(ROW_SPOTS as u8);
            if let Some(best) = (0..here).find(|&x| free(x) && spot_fee(x) * 10 <= s.money * 8) {
                let fee = spot_fee(best);
                if w.night >= s.moved_at + MOVE_COOLDOWN_NIGHTS {
                    acts.push(format!(r#"{{"move":{{"stall":{id},"spot":{best},"max_fee":{fee}}}}}"#));
                    after.money -= fee;
                }
            }
            acts.extend(restock_at(w, &after, MIX, FAIR, 40));
            acts
        }
        Strategy::Dumplings => {
            let unit = w.dock[2].price;
            let p = (unit * 125 / 100).min(FAIR[2]);
            restock_at(w, &s, [0, 0, 24, 0, 0], [0, 0, p, 0, 0], 60)
        }
        Strategy::SilkOnly => {
            let unit = w.dock[3].price;
            let p = (unit * 125 / 100).min(FAIR[3] * 3 / 2);
            restock_at(w, &s, [0, 0, 0, 5, 0], [0, 0, 0, p, 0], 80)
        }
    };
    b.started = true;
    if acts.is_empty() {
        return;
    }
    // A batch stops at its first refusal, like a real client's would.
    let batch = format!("[{}]", acts.join(","));
    g.play(&b.who, &batch);
}

struct Stats {
    sales: u64,
    revenue_vs_fair_num: u64,
    revenue_vs_fair_den: u64,
    missed: u64,
    refusals: u64,
    evictions: u64,
    relief: u64,
    min_treasury: u64,
    nights: u64,
}

impl Stats {
    fn new() -> Self {
        Stats { sales: 0, revenue_vs_fair_num: 0, revenue_vs_fair_den: 0, missed: 0, refusals: 0, evictions: 0, relief: 0, min_treasury: u64::MAX, nights: 0 }
    }

    fn add(&mut self, w: &WorldView) {
        let log = w.last.as_ref().expect("a log");
        self.sales += log.sales.len() as u64;
        for sale in &log.sales {
            self.revenue_vs_fair_num += sale.3 as u64;
            self.revenue_vs_fair_den += FAIR[sale.2 as usize] as u64;
        }
        self.missed += log.missed.len() as u64;
        self.refusals += log.refusals.len() as u64;
        self.evictions += log.evicted.len() as u64;
        self.relief += log.relief;
        self.min_treasury = self.min_treasury.min(w.treasury);
        self.nights += 1;
    }

    fn price_index(&self) -> u64 {
        self.revenue_vs_fair_num * 100 / self.revenue_vs_fair_den.max(1)
    }

    fn sales_per_night(&self) -> f64 {
        self.sales as f64 / self.nights.max(1) as f64
    }

    fn missed_per_night(&self) -> f64 {
        self.missed as f64 / self.nights.max(1) as f64
    }
}

fn health(g: &mut Game, label: &str, stats: &Stats) {
    let a = g.audit();
    let w = g.world();
    let merchants: Vec<u64> = (1..=MERCHANTS).map(|id| g.stall(id).money).collect();
    println!(
        "{label:>12} | night {:>5} | treasury {:>7} dock {:>6} wallets {:>6} stalls {:>7} purses {:>5} | sales/night {:>5.1} missed/night {:>4.1} price {:>3}% relief/night {:>4} | merchants min {:>6} max {:>6} | event {:?}",
        w.night,
        a.treasury,
        a.dock,
        a.villagers,
        a.stalls,
        a.purses,
        stats.sales_per_night(),
        stats.missed_per_night(),
        stats.price_index(),
        stats.relief / stats.nights.max(1),
        merchants.iter().min().unwrap(),
        merchants.iter().max().unwrap(),
        w.event,
    );
    assert_eq!(a.total, FOUNDING_MONEY, "conservation broke: {a:?}");
}

fn make_bots(g: &mut Game, plan: &[Strategy]) -> Vec<Bot> {
    let mut bots = Vec::new();
    for (i, &strategy) in plan.iter().enumerate() {
        if i > 0 && i as u32 % MAX_FOUNDINGS_PER_NIGHT == 0 {
            g.next_night();
        }
        let who = acc(&format!("bot{i}.testnet"));
        let name: String = format!("{strategy:?}").chars().filter(char::is_ascii_alphanumeric).take(MAX_NAME_CHARS).collect();
        let stall = g.found(&who, &name);
        bots.push(Bot { who, stall, strategy, started: false, ask: [0; GOODS] });
    }
    bots
}

/// Plays `nights` nights, checking the health of the economy as it goes.
fn run(g: &mut Game, bots: &mut [Bot], nights: u32, label: &str, print_every: u32) -> Stats {
    let mut stats = Stats::new();
    let mut window = Stats::new();
    for n in 1..=nights {
        let w = g.world();
        for b in bots.iter_mut() {
            turn(g, b, &w);
        }
        g.next_night();
        let w = g.world();
        stats.add(&w);
        window.add(&w);
        if n % 10 == 0 {
            g.assert_conserved();
        }
        if print_every > 0 && n % print_every == 0 {
            health(g, label, &window);
            window = Stats::new();
        }
    }
    g.assert_conserved();
    stats
}

fn worth_of(g: &mut Game, id: u32) -> u64 {
    g.stall(id).worth
}

#[test]
fn a_judge_alone_for_two_minutes_meets_a_living_market() {
    let mut profits = Vec::new();
    println!("\nsolo: one attentive player, six nights");
    for seed in 1..=8 {
        let mut g = Game::with_seed(seed);
        let mut bots = make_bots(&mut g, &[Strategy::Trader]);
        let start = worth_of(&mut g, bots[0].stall);
        let mut line = String::new();
        let mut merchants_moved = false;
        for _ in 0..6 {
            let w = g.world();
            let before: Vec<_> = w.row.iter().filter(|s| s.npc).map(|s| s.price).collect();
            turn(&mut g, &mut bots[0], &w);
            g.next_night();
            let w = g.world();
            let log = w.last.as_ref().unwrap();
            let mine = log.sales.iter().filter(|s| s.1 == bots[0].stall).count();
            line.push_str(&format!("{mine}/{} ", log.sales.len()));
            let after: Vec<_> = w.row.iter().filter(|s| s.npc).map(|s| s.price).collect();
            merchants_moved |= before != after;
        }
        let end = worth_of(&mut g, bots[0].stall);
        println!("seed {seed}: my sales/all sales per night {line}| worth {start} -> {end}");
        assert!(merchants_moved, "merchants should reprice within two minutes");
        profits.push(end as i64 - start as i64);
        g.assert_conserved();
    }
    let wins = profits.iter().filter(|&&p| p > 0).count();
    println!("profits over six nights: {profits:?}");
    assert!(wins >= 6, "an attentive player should usually profit quickly: {profits:?}");
}

#[test]
fn the_town_alone_stays_alive_for_two_thousand_nights() {
    println!("\nno players at all");
    let mut g = Game::with_seed(100);
    let stats = run(&mut g, &mut [], 2_000, "npc-only", 400);
    assert!(stats.sales_per_night() > 12.0, "the row should stay busy: {}", stats.sales_per_night());
    let idx = stats.price_index();
    assert!((70..=170).contains(&idx), "prices drifted to {idx}% of fair");
    assert!(stats.min_treasury > 100_000, "treasury fell to {}", stats.min_treasury);
    for id in 1..=MERCHANTS {
        let m = g.stall(id);
        assert!(m.money > 0, "merchant {id} is broke");
        assert!(m.customers > 500, "merchant {id} had only {} customers", m.customers);
        assert!(m.sold_last.iter().sum::<u16>() > 0 || m.stock.iter().sum::<u32>() > 0, "merchant {id} is dead");
    }
}

fn league(seed: u64, nights: u32, print_every: u32) -> Vec<(Strategy, u64)> {
    let mut g = Game::with_seed(seed);
    let mut bots = make_bots(&mut g, &ALL);
    let label = format!("league-{seed}");
    let stats = run(&mut g, &mut bots, nights, &label, print_every);
    let idx = stats.price_index();
    assert!((60..=200).contains(&idx), "prices drifted to {idx}% of fair");
    assert!(stats.min_treasury > 50_000, "treasury fell to {}", stats.min_treasury);
    for id in 1..=MERCHANTS {
        let m = g.stall(id);
        assert!(m.money > 0, "merchant {id} went broke");
        assert!(m.customers > 100, "merchant {id} had only {} customers", m.customers);
    }
    bots.iter().map(|b| (b.strategy, g.stall(b.stall).worth)).collect()
}

#[test]
fn nine_strategies_over_a_thousand_nights_and_no_trivial_one_dominates() {
    println!("\nnine strategies on one row, 1000 nights, 6 seeds");
    let mut totals = [0u64; ALL.len()];
    let seeds = 6;
    let mut trader_first = 0;
    for seed in 1..=seeds {
        let results = league(seed, 1_000, if seed == 1 { 200 } else { 0 });
        let best = results.iter().max_by_key(|r| r.1).unwrap();
        if best.0 == Strategy::Trader {
            trader_first += 1;
        }
        for (i, r) in results.iter().enumerate() {
            totals[i] += r.1;
        }
        let line: Vec<String> = results.iter().map(|r| format!("{:?}={}", r.0, r.1)).collect();
        println!("seed {seed}: {}", line.join(" "));
    }
    println!("average net worth after 1000 nights:");
    for (i, s) in ALL.iter().enumerate() {
        println!("  {:<12} {:>8}", format!("{s:?}"), totals[i] / seeds);
    }
    let avg = |s: Strategy| totals[ALL.iter().position(|&x| x == s).unwrap()] / seeds;
    println!("trader finished first in {trader_first}/{seeds} seeds");
    assert!(avg(Strategy::Trader) > avg(Strategy::Passive) * 2, "attention must pay");
    assert!(avg(Strategy::Trader) > avg(Strategy::Restocker), "thinking must beat refilling");
    for trivial in [
        Strategy::Gouger,
        Strategy::Cornerer(3),
        Strategy::Undercutter,
        Strategy::FrontRunner,
        Strategy::Dumplings,
        Strategy::SilkOnly,
    ] {
        assert!(
            avg(Strategy::Trader) > avg(trivial),
            "{trivial:?} ({}) beats the attentive Trader ({})",
            avg(trivial),
            avg(Strategy::Trader)
        );
    }
}

#[test]
fn an_active_player_beats_a_passive_one_head_to_head_on_every_seed() {
    println!("\nTrader against Passive, head to head, 300 nights");
    for seed in 1..=10 {
        let mut g = Game::with_seed(1000 + seed);
        let mut bots = make_bots(&mut g, &[Strategy::Trader, Strategy::Passive]);
        run(&mut g, &mut bots, 300, "h2h", 0);
        let (t, p) = (g.stall(bots[0].stall).worth, g.stall(bots[1].stall).worth);
        println!("seed {seed}: Trader {t}, Passive {p}");
        assert!(t > p * 2, "seed {seed}: Trader {t} vs Passive {p}");
    }
}

#[test]
fn a_crowded_row_of_traders_shares_the_market_without_collapse() {
    println!("\ncrowded row: every free spot a Trader, plus some in the alley");
    let mut g = Game::with_seed(555);
    let plan = vec![Strategy::Trader; ROW_SPOTS - MERCHANTS as usize + 6];
    let mut bots = make_bots(&mut g, &plan);
    let stats = run(&mut g, &mut bots, 600, "crowded", 150);
    assert!(stats.min_treasury > 50_000, "treasury {}", stats.min_treasury);
    let worths: Vec<u64> = bots.iter().map(|b| g.stall(b.stall).worth).collect();
    println!("worths: {worths:?}");
    let idx = stats.price_index();
    assert!((50..=200).contains(&idx), "prices {idx}%");
    for id in 1..=MERCHANTS {
        assert!(g.stall(id).money > 0, "merchant {id} broke");
    }
}

#[test]
fn a_hundred_abandoned_stalls_recycle_their_money() {
    println!("\nthe worst case for the loop: every licence founded, then abandoned");
    let mut g = Game::with_seed(777);
    for i in 0..MAX_PLAYER_STALLS {
        if i > 0 && i % MAX_FOUNDINGS_PER_NIGHT == 0 {
            g.next_night();
        }
        g.found(&acc(&format!("ghost{i}.testnet")), "Ghost");
    }
    let start = g.audit();
    println!("after the foundings: {start:?}");
    let stats = run(&mut g, &mut [], 1_500, "ghosts", 300);
    let end = g.audit();
    println!("after 1500 nights: {end:?}");
    assert!(end.treasury > start.treasury, "rent should bring the grants back");
    assert!(end.stalls < start.stalls);
    assert!(stats.sales_per_night() > 10.0, "the merchants should still trade");
    let w = g.world();
    assert!(w.row.iter().all(|s| s.npc), "idle stalls should have left the row");
}

#[test]
fn cornering_any_good_does_not_beat_trading() {
    println!("\none Cornerer buys out one good every night next to a Trader, 500 nights");
    for good in 0..GOODS {
        for seed in 1..=4u64 {
            let mut g = Game::with_seed(880 + seed);
            let mut bots = make_bots(&mut g, &[Strategy::Cornerer(good), Strategy::Trader]);
            let stats = run(&mut g, &mut bots, 500, "corner", 0);
            let corner = g.stall(bots[0].stall).worth;
            let trader = g.stall(bots[1].stall).worth;
            println!("{} seed {seed}: Cornerer {corner}, Trader {trader}, missed/night {:.1}", GOOD_NAMES[good], stats.missed_per_night());
            assert!(stats.sales_per_night() > 10.0);
            for id in 1..=MERCHANTS {
                assert!(g.stall(id).money > 0, "merchant {id} broke");
            }
            assert!(trader > corner, "{}: cornering {corner} beats trading {trader}", GOOD_NAMES[good]);
        }
    }
}

#[test]
fn money_does_not_pool_in_one_place() {
    let mut g = Game::with_seed(4242);
    let mut bots = make_bots(&mut g, &ALL);
    run(&mut g, &mut bots, 1_000, "pool", 0);
    let a = g.audit();
    println!("\nwhere the coin is after 1000 nights of nine strategies: {a:?}");
    assert!(a.treasury * 100 / FOUNDING_MONEY >= 20, "the treasury holds too little");
    let top = bots.iter().map(|b| g.stall(b.stall).money).max().unwrap();
    assert!(top * 100 / FOUNDING_MONEY < 15, "one stall holds {top}");
}

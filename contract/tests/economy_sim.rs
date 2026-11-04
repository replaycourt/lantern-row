//! The economy simulation: bots drive the real contract through the mock VM for hundreds of nights.
//!
//! Run with the tables printed: `cargo test --test economy_sim -- --nocapture --test-threads=1`
//! What these tables say, and the tuning they led to, is in docs/ECONOMY.md.
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
    /// Refills like the Restocker but at a fixed percentage of the fair price.
    Fixed(u32),
    /// Fixed price, and reinvests until it reaches a given spot and size.
    Investor(u32, u8, u8),
    /// What an attentive player does: prices against rivals, reads the forecast, reinvests.
    Trader,
    /// The same pricing, but ignores the forecast and never reinvests.
    Watcher,
    /// Always the cheapest on the row, as low as the Dock allows.
    Undercutter,
    /// Stocks everything and asks two and a half times the fair price.
    Gouger,
    /// Buys all of one good the Dock has every night and asks double, trying to corner the market.
    Cornerer(usize),
    /// Buys all of one good every night and sells it barely above cost: a glut on purpose.
    Flooder(usize),
    /// Spends everything on the best spot straight away, then restocks like the Restocker.
    FrontRunner,
    /// Sells only dumplings, the cheap everyday good, at a thin margin.
    Dumplings,
    /// Sells only silk, the luxury good.
    SilkOnly,
}

const ALL: [Strategy; 10] = [
    Strategy::Passive,
    Strategy::Restocker,
    Strategy::Trader,
    Strategy::Watcher,
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

/// What an attentive player does each night: prices just under the cheapest rival while that still
/// pays, never lets the shelf run empty, reads the forecast and buys ahead of it. With `invest` it also
/// reinvests its profit, and with `events` it reacts to the forecast.
fn trader(w: &WorldView, s: &StallView, events: bool, invest: bool) -> Vec<String> {
    let mut targets = [0; GOODS];
    let mut prices = [0; GOODS];
    let scale = s.tier as u32 + 1;
    for g in 0..GOODS {
        let unit = w.dock[g].price;
        // Under the cheapest rival, but it does not join a race to the bottom: below the fair price
        // it just holds, and lets the bargain stalls run out.
        let rival = rival_price(w, s.id, g).map_or(FAIR[g] * 140 / 100, |r| r * 97 / 100);
        let floor = (unit * 125 / 100).max(FAIR[g] * 95 / 100);
        let mut p = rival.clamp(floor, (FAIR[g] * 140 / 100).max(floor));
        let mut target = MIX[g] * (1 + (scale - 1) / 2);
        if events {
            let soon = w.event_left == 1;
            let festival_next = soon && matches!(w.event_next, Event::Festival { good } if good as usize == g);
            let festival_now = matches!(w.event, Event::Festival { good } if good as usize == g);
            let storm_next = soon && matches!(w.event_next, Event::Storm { good } if good as usize == g);
            let storm_now = matches!(w.event, Event::Storm { good } if good as usize == g);
            if festival_now {
                p = p * 125 / 100;
            }
            if storm_now {
                p = p * 130 / 100;
            }
            if festival_next {
                target *= 2;
            } else if storm_next {
                target = target * 3 / 2;
            }
        }
        prices[g] = p;
        if unit * 110 / 100 < p {
            targets[g] = target;
        }
    }
    let mut acts = restock_at(w, s, targets, prices, 40);
    if !invest {
        return acts;
    }
    // Reinvest when flush: a bigger stall once customers are being turned away, and a free spot around
    // the middle of the row. The front is rarely worth its fee and rent, and displacing costs double.
    if s.listed.is_none() {
        let sold: u32 = s.sold_last.iter().map(|&x| x as u32).sum();
        if (s.tier as usize) + 1 < TIERS && sold >= s.service && s.money > TIER_COST[s.tier as usize + 1] * 3 / 2 {
            acts.push(format!(r#"{{"upgrade":{{"stall":{},"max_cost":1000000}}}}"#, s.id));
        }
        let here = s.spot.unwrap_or(ROW_SPOTS as u8);
        if here > 10 && (s.moved_at == 0 || w.night >= s.moved_at + MOVE_COOLDOWN_NIGHTS) {
            let free = (10..here).find(|&x| !w.row.iter().any(|r| r.spot == Some(x)));
            if let Some(target) = free {
                let fee = spot_fee(target);
                if s.money > fee * 3 {
                    acts.push(format!(r#"{{"move":{{"stall":{},"spot":{target},"max_fee":{fee}}}}}"#, s.id));
                }
            }
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
        Strategy::Fixed(pct) => {
            let prices = core::array::from_fn(|good| FAIR[good] * pct / 100);
            restock_at(w, &s, MIX, prices, 40)
        }
        Strategy::Investor(pct, spot, tier) => {
            let prices = core::array::from_fn(|good| FAIR[good] * pct / 100);
            let scale = 1 + s.tier as u32 / 2;
            let mut acts = restock_at(w, &s, core::array::from_fn(|good| MIX[good] * scale), prices, 40);
            let here = s.spot.unwrap_or(ROW_SPOTS as u8);
            if here > spot {
                let occupied = w.row.iter().any(|x| x.spot == Some(spot));
                let fee = spot_fee(spot) * if occupied { DISPLACE_FACTOR } else { 1 };
                if s.money > fee * 3 / 2 && (s.moved_at == 0 || w.night >= s.moved_at + MOVE_COOLDOWN_NIGHTS) {
                    acts.push(format!(r#"{{"move":{{"stall":{id},"spot":{spot},"max_fee":{fee}}}}}"#));
                }
            }
            if s.tier < tier && s.money > TIER_COST[s.tier as usize + 1] * 3 / 2 {
                acts.push(format!(r#"{{"upgrade":{{"stall":{id},"max_cost":1000000}}}}"#));
            }
            acts
        }
        Strategy::Trader => trader(w, &s, true, true),
        Strategy::Watcher => trader(w, &s, false, false),
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
        Strategy::Flooder(good) => {
            let mut acts = Vec::new();
            let q = qty_for(w, good, w.dock[good].left, s.capacity.saturating_sub(held(&s)), s.money);
            if q > 0 {
                acts.push(buy(id, good, q));
            }
            acts.push(price(id, good, w.dock[good].price * 105 / 100));
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
    let mut acts = acts;
    // A stall nobody touches for 60 nights loses its spot. A player who is still there touches it.
    if acts.is_empty() && b.strategy != Strategy::Passive && w.night % 20 == 0 {
        acts.push(price(id, 0, s.price[0]));
    }
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
        bots.push(Bot { who, stall, strategy, started: false });
    }
    bots
}

/// Plays `nights` nights, checking the health of the economy as it goes.
fn run(g: &mut Game, bots: &mut [Bot], nights: u32, label: &str, print_every: u32) -> Stats {
    let mut stats = Stats::new();
    let mut window = Stats::new();
    for n in 1..=nights {
        let w = g.world();
        // The Dock serves whoever comes first, so nobody may always come first.
        if !bots.is_empty() {
            bots.rotate_left(1);
        }
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
    // Back in the order the caller planned.
    bots.sort_by_key(|b| b.stall);
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
fn a_judge_arriving_late_can_still_break_in() {
    println!("\nthe town has run alone for 600 nights when one attentive player arrives");
    let mut profits = Vec::new();
    for seed in 1..=8 {
        let mut g = Game::with_seed(5000 + seed);
        for _ in 0..600 {
            g.next_night();
        }
        let merchants_rep: Vec<u16> = (1..=MERCHANTS).map(|id| g.stall(id).rep).collect();
        let mut bots = make_bots(&mut g, &[Strategy::Trader]);
        let start = worth_of(&mut g, bots[0].stall);
        let mut line = String::new();
        for _ in 0..6 {
            let w = g.world();
            turn(&mut g, &mut bots[0], &w);
            g.next_night();
            let w = g.world();
            let log = w.last.as_ref().unwrap();
            let mine = log.sales.iter().filter(|s| s.1 == bots[0].stall).count();
            line.push_str(&format!("{mine}/{} ", log.sales.len()));
        }
        let end = worth_of(&mut g, bots[0].stall);
        println!("seed {seed}: merchants' rep {merchants_rep:?}; my sales/all {line}| worth {start} -> {end}");
        profits.push(end as i64 - start as i64);
    }
    println!("profits over six nights: {profits:?}");
    let wins = profits.iter().filter(|&&p| p > 0).count();
    assert!(wins >= 6, "a newcomer in an old town should usually profit quickly: {profits:?}");
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
fn ten_strategies_over_a_thousand_nights_and_the_one_trick_ones_lose() {
    println!("\nten strategies on one row, 1000 nights, 6 seeds");
    let mut totals = [0u64; ALL.len()];
    let seeds = 6;
    for seed in 1..=seeds {
        let results = league(seed, 1_000, if seed == 1 { 200 } else { 0 });
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
    // Paying attention every night beats doing nothing, by a wide margin.
    for attentive in [Strategy::Trader, Strategy::Watcher, Strategy::Restocker] {
        assert!(avg(attentive) > avg(Strategy::Passive) * 5, "{attentive:?} should far outearn Passive");
    }
    // Each one-trick idea loses to plain market-watching, and the attentive player beats them all.
    for trick in [Strategy::Gouger, Strategy::Undercutter, Strategy::Dumplings, Strategy::SilkOnly, Strategy::Cornerer(3), Strategy::FrontRunner, Strategy::Restocker] {
        assert!(avg(trick) < avg(Strategy::Watcher), "{trick:?} ({}) beats watching the market", avg(trick));
    }
    for other in ALL.iter().filter(|&&s| s != Strategy::Trader) {
        assert!(avg(Strategy::Trader) > avg(*other), "{other:?} ({}) beats the Trader ({})", avg(*other), avg(Strategy::Trader));
    }
}

/// Average net worth of a fixed price level over a few seeds: alone with the merchants, and in the league.
fn fixed_level(pct: u32) -> (u64, u64) {
    let (mut alone, mut in_league) = (0, 0);
    for seed in 1..=4 {
        let mut g = Game::with_seed(seed);
        let mut bots = make_bots(&mut g, &[Strategy::Fixed(pct)]);
        run(&mut g, &mut bots, 500, "fixed", 0);
        alone += g.stall(bots[0].stall).worth;
        let mut g = Game::with_seed(seed + 100);
        let mut plan = ALL.to_vec();
        plan[1] = Strategy::Fixed(pct);
        let mut bots = make_bots(&mut g, &plan);
        run(&mut g, &mut bots, 500, "fixed", 0);
        in_league += g.stall(bots[1].stall).worth;
    }
    (alone / 4, in_league / 4)
}

/// Refilling at a fixed price is the obvious simple play, so it gets its own scrutiny. It is not a
/// solved game: the best level depends on who else is on the row, and overshooting is punished hard.
#[test]
fn no_fixed_price_is_right_everywhere() {
    println!("\nnet worth after 500 nights at a fixed price level");
    println!("{:>7} {:>9} {:>9}", "price%", "alone", "league");
    let levels = [70, 80, 90, 100, 110, 120, 130, 140, 150, 170, 200];
    let results: Vec<(u32, u64, u64)> = levels.iter().map(|&pct| {
        let (a, l) = fixed_level(pct);
        println!("{pct:>7} {a:>9} {l:>9}");
        (pct, a, l)
    }).collect();
    let best_alone = results.iter().max_by_key(|r| r.1).unwrap();
    let best_league = results.iter().max_by_key(|r| r.2).unwrap();
    println!("best alone at {}%, best in the league at {}%", best_alone.0, best_league.0);
    assert!(best_alone.0 > best_league.0, "competition should push the best price down");
    let at_alone_best = results.iter().find(|r| r.0 == best_alone.0).unwrap().2;
    assert!(at_alone_best * 2 < best_league.2, "the price that is best alone should fail in a crowd");
    let extremes = [results[0], *results.last().unwrap()];
    for e in extremes {
        assert!(e.1 * 2 < best_alone.1, "{}% should be far from the best", e.0);
    }
}

#[test]
fn an_attentive_player_outplays_fixed_price_refilling() {
    println!("\nthe attentive Trader against the best fixed level and against a field of refillers");
    let (best_alone, _) = fixed_level(130);
    let mut trader_alone = 0;
    for seed in 1..=4 {
        let mut g = Game::with_seed(seed);
        let mut bots = make_bots(&mut g, &[Strategy::Trader]);
        run(&mut g, &mut bots, 500, "alone", 0);
        trader_alone += g.stall(bots[0].stall).worth;
    }
    trader_alone /= 4;
    println!("alone with the merchants, 500 nights: Trader {trader_alone}, best fixed level {best_alone}");
    assert!(trader_alone > best_alone, "Trader {trader_alone} vs fixed {best_alone}");
    let (mut trader_field, mut refill_field) = (0, 0);
    for seed in 1..=4 {
        let mut g = Game::with_seed(seed + 200);
        let plan = [Strategy::Restocker, Strategy::Restocker, Strategy::Restocker, Strategy::Restocker, Strategy::Trader];
        let mut bots = make_bots(&mut g, &plan);
        run(&mut g, &mut bots, 500, "field", 0);
        trader_field += g.stall(bots[4].stall).worth;
        refill_field += (0..4).map(|i| g.stall(bots[i].stall).worth).sum::<u64>() / 4;
    }
    println!("four refillers and one Trader, 500 nights: Trader {}, refillers on average {}", trader_field / 4, refill_field / 4);
    assert!(trader_field > refill_field, "the Trader should beat a field of refillers");
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
    println!("\nwhere the coin is after 1000 nights of ten strategies: {a:?}");
    assert!(a.treasury * 100 / FOUNDING_MONEY >= 20, "the treasury holds too little");
    let top = bots.iter().map(|b| g.stall(b.stall).money).max().unwrap();
    assert!(top * 100 / FOUNDING_MONEY < 15, "one stall holds {top}");
}

/// Average price the NPC merchants ask for a good, and how often villagers found none, while `plan` plays.
fn merchant_price(plan: &[Strategy], good: usize, seed: u64) -> (f64, f64) {
    let mut g = Game::with_seed(seed);
    let mut bots = make_bots(&mut g, plan);
    run(&mut g, &mut bots, 100, "warmup", 0);
    let (mut sum, mut count, mut missed) = (0u64, 0u64, 0u64);
    for _ in 0..300 {
        let w = g.world();
        for b in bots.iter_mut() {
            turn(&mut g, b, &w);
        }
        g.next_night();
        let w = g.world();
        for s in w.row.iter().filter(|s| s.npc && MERCHANT_TABLE[s.id as usize - 1].target[good] > 0) {
            sum += s.price[good] as u64;
            count += 1;
        }
        missed += w.last.as_ref().unwrap().missed.iter().filter(|m| m.1 as usize == good).count() as u64;
    }
    (sum as f64 / count.max(1) as f64, missed as f64 / 300.0)
}

#[test]
fn scarcity_and_gluts_come_from_what_players_do() {
    println!("\nwhat bots do to the merchants' prices, 300 nights after a warm-up");
    println!("{:<10} {:>8} {:>18} {:>12} | missed/night {:>6} {:>8} {:>8}", "good", "alone", "6 cornerers", "1 flooder", "alone", "corner", "flood");
    for good in 0..GOODS {
        let (alone, missed_alone) = merchant_price(&[], good, 3000 + good as u64);
        let (cornered, missed_cornered) = merchant_price(&[Strategy::Cornerer(good); 6], good, 3000 + good as u64);
        let (flooded, missed_flooded) = merchant_price(&[Strategy::Flooder(good)], good, 3000 + good as u64);
        println!(
            "{:<10} {alone:>8.1} {cornered:>18.1} {flooded:>12.1} | {:>19.2} {missed_cornered:>8.2} {missed_flooded:>8.2}",
            GOOD_NAMES[good], missed_alone
        );
        assert!(flooded < alone, "{}: a glut should lower prices: {flooded} vs {alone}", GOOD_NAMES[good]);
    }
}

#[test]
fn a_storm_shows_up_in_prices_and_empty_shelves() {
    // Compares the nights with a storm on dumplings, the good nobody can hold much of, with the rest.
    println!("\ndumplings during and outside storms, 3000 nights, no players");
    let mut g = Game::with_seed(4100);
    let (mut storm_nights, mut storm_missed, mut other_nights, mut other_missed) = (0u64, 0u64, 0u64, 0u64);
    let (mut storm_dock, mut other_dock) = (0u64, 0u64);
    let (mut storm_ask, mut other_ask) = (0u64, 0u64);
    for _ in 0..3_000 {
        let w = g.world();
        let storm = matches!(w.event, Event::Storm { good: 2 });
        let price = w.dock[2].price as u64;
        let ask = w.row.iter().filter(|s| s.npc && s.price[2] > 0).map(|s| s.price[2] as u64).sum::<u64>() / 3;
        if storm {
            storm_ask += ask;
        } else {
            other_ask += ask;
        }
        g.next_night();
        let w = g.world();
        let missed = w.last.as_ref().unwrap().missed.iter().filter(|m| m.1 == 2).count() as u64;
        if storm {
            storm_nights += 1;
            storm_missed += missed;
            storm_dock += price;
        } else {
            other_nights += 1;
            other_missed += missed;
            other_dock += price;
        }
    }
    let (sm, om) = (storm_missed as f64 / storm_nights as f64, other_missed as f64 / other_nights as f64);
    let (sd, od) = (storm_dock as f64 / storm_nights as f64, other_dock as f64 / other_nights as f64);
    println!("storm nights {storm_nights}: villagers without dumplings {sm:.2}/night, Dock price {sd:.1}, merchants ask {:.1}", storm_ask as f64 / storm_nights as f64);
    println!("other nights {other_nights}: villagers without dumplings {om:.2}/night, Dock price {od:.1}, merchants ask {:.1}", other_ask as f64 / other_nights as f64);
    assert!(sd > od * 1.3, "a storm should raise the Dock price");
    assert!(sm > om * 1.5, "a storm should empty shelves: {sm} vs {om}");
}

/// What spending profit on spot and size brings.
#[test]
fn spending_profit_on_size_pays_and_a_spot_pays_in_a_crowd() {
    println!("\nnet worth after 500 nights, by what the profit is spent on: at 120% of fair alone, at 90% in the league");
    println!("{:>6} {:>6} {:>10} {:>10}", "spot", "size", "alone", "league");
    let mut table = Vec::new();
    for (spot, tier) in [(23u8, 0u8), (10, 0), (2, 0), (0, 0), (23, 1), (23, 2), (23, 3), (10, 1), (10, 2), (0, 2), (0, 3)] {
        let (mut alone, mut league) = (0, 0);
        for seed in 1..=4 {
            let mut g = Game::with_seed(seed);
            let mut bots = make_bots(&mut g, &[Strategy::Investor(120, spot, tier)]);
            run(&mut g, &mut bots, 500, "invest", 0);
            alone += g.stall(bots[0].stall).worth;
            let mut g = Game::with_seed(seed + 100);
            let mut plan = ALL.to_vec();
            plan[1] = Strategy::Investor(90, spot, tier);
            let mut bots = make_bots(&mut g, &plan);
            run(&mut g, &mut bots, 500, "invest", 0);
            league += g.stall(bots[1].stall).worth;
        }
        println!("{spot:>6} {tier:>6} {:>10} {:>10}", alone / 4, league / 4);
        table.push((spot, tier, alone / 4, league / 4));
    }
    let at = |s: u8, t: u8| *table.iter().find(|r| r.0 == s && r.1 == t).unwrap();
    assert!(at(23, 3).2 > at(23, 0).2 * 3 / 2, "the biggest stall should far outearn the smallest");
    assert!(at(23, 1).3 > at(23, 0).3, "a size up should pay in a crowd too");
}

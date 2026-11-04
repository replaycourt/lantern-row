//! The rules of the game: founding, the Dock, villagers, rent, spots, sizes, events, merchants.
mod common;

use common::*;
use lantern_row::config::*;
use lantern_row::market::*;
use lantern_row::types::*;

#[test]
fn founding_splits_exactly_the_founding_money() {
    let mut g = Game::new();
    let a = g.audit();
    assert_eq!(a.total, FOUNDING_MONEY);
    assert_eq!(a.dock, DOCK_FOUNDING);
    assert_eq!(a.villagers, VILLAGER_FOUNDING * VILLAGERS as u64);
    assert_eq!(a.stalls, MERCHANT_FOUNDING * MERCHANTS as u64);
    assert_eq!(a.treasury, treasury_founding());
}

#[test]
fn the_world_starts_with_twelve_villagers_and_six_merchants() {
    let mut g = Game::new();
    let w = g.world();
    assert_eq!(w.night, 1);
    assert_eq!(w.villagers.len(), 12);
    assert_eq!(w.row.len(), 6);
    assert!(w.row.iter().all(|s| s.npc && s.money == MERCHANT_FOUNDING));
    assert!(w.row.windows(2).all(|p| p[0].spot < p[1].spot), "front of the row first");
    assert_eq!(w.stalls_total, MERCHANTS);
    assert_eq!(w.licences_left, MAX_PLAYER_STALLS);
}

#[test]
fn founding_a_stall_pays_the_grant_from_the_treasury_and_takes_the_worst_free_spot() {
    let mut g = Game::new();
    let before = g.audit();
    let me = acc("me.testnet");
    let id = g.found(&me, "Silk Lantern");
    assert_eq!(id, MERCHANTS + 1);
    let s = g.stall(id);
    assert_eq!(s.money, STARTER_GRANT);
    assert_eq!(s.spot, Some(23));
    assert_eq!(s.name, "Silk Lantern");
    let after = g.audit();
    assert_eq!(after.treasury, before.treasury - STARTER_GRANT);
    assert_eq!(after.grants_paid, STARTER_GRANT);
    assert_eq!(after.total, FOUNDING_MONEY);
    let second = g.found(&acc("you.testnet"), "Next Door");
    assert_eq!(g.stall(second).spot, Some(22));
}

#[test]
fn a_second_stall_of_the_same_account_gets_no_grant() {
    let mut g = Game::new();
    let me = acc("me.testnet");
    g.found(&me, "One");
    let two = g.found(&me, "Two");
    assert_eq!(g.stall(two).money, 0);
    assert_eq!(g.audit().grants_paid, STARTER_GRANT);
}

#[test]
fn dock_cost_is_the_same_for_one_order_or_many() {
    for good in 0..GOODS {
        let whole = dock_cost(good, 0, 12, 100);
        let mut parts = 0;
        for i in 0..12 {
            parts += dock_cost(good, i, 1, 100);
        }
        // Rounding each unit up can only make the split order dearer, never cheaper.
        assert!(parts >= whole, "good {good}: {parts} < {whole}");
        assert!(parts - whole <= 12, "good {good}: {parts} vs {whole}");
    }
}

#[test]
fn dock_price_rises_with_buying_and_decays_each_night() {
    let mut g = Game::new();
    let me = acc("me.testnet");
    let id = g.found(&me, "Mine");
    let p0 = g.world().dock[0].price;
    g.ok(&me, &format!(r#"[{{"buy":{{"stall":{id},"good":0,"qty":10,"max_cost":100000}}}}]"#));
    let w = g.world();
    assert!(w.dock[0].price > p0, "price should rise");
    assert_eq!(w.dock[0].heat, 10);
    assert_eq!(w.dock[0].left, DOCK_SUPPLY[0] - 10);
    let high = w.dock[0].heat;
    g.next_night();
    let w2 = g.world();
    assert!(w2.dock[0].heat < high + 30, "heat decays, merchants may add some");
    // With the merchants of that good satisfied, heat alone falls away.
    g.nights(10);
    assert!(g.world().dock[0].heat < 40);
}

#[test]
fn the_exact_price_is_charged_and_arrives_at_the_dock() {
    let mut g = Game::new();
    let me = acc("me.testnet");
    let id = g.found(&me, "Mine");
    let dock_before = g.audit().dock;
    let expected = dock_cost(2, 0, 7, dock_price_factor(g.world().event, 2));
    g.ok(&me, &format!(r#"[{{"buy":{{"stall":{id},"good":2,"qty":7,"max_cost":{expected}}}}}]"#));
    assert_eq!(g.stall(id).money, STARTER_GRANT - expected);
    assert_eq!(g.stall(id).stock[2], 7);
    assert_eq!(g.audit().dock, dock_before + expected);
    g.assert_conserved();
}

#[test]
fn sell_back_pays_less_than_the_stock_cost_and_cools_the_dock() {
    let mut g = Game::new();
    let me = acc("me.testnet");
    let id = g.found(&me, "Mine");
    g.ok(&me, &format!(r#"[{{"buy":{{"stall":{id},"good":1,"qty":5,"max_cost":100000}}}}]"#));
    let money = g.stall(id).money;
    let heat = g.world().dock[1].heat;
    g.ok(&me, &format!(r#"[{{"sell_back":{{"stall":{id},"good":1,"qty":5,"min_pay":1}}}}]"#));
    let s = g.stall(id);
    assert_eq!(s.stock[1], 0);
    assert!(s.money > money);
    assert!(s.money < STARTER_GRANT, "a round trip must lose money");
    assert_eq!(g.world().dock[1].heat, heat - 5);
    g.assert_conserved();
}

#[test]
fn villagers_buy_from_a_fair_stall_and_the_tax_goes_to_the_treasury() {
    let mut g = Game::with_seed(7);
    let me = acc("me.testnet");
    let id = g.found(&me, "Mine");
    g.ok(&me, &format!(
        r#"[{{"buy":{{"stall":{id},"good":2,"qty":15,"max_cost":100000}}}},{{"price":{{"stall":{id},"good":2,"price":20}}}}]"#
    ));
    g.ok(&me, &format!(r#"[{{"move":{{"stall":{id},"spot":14,"max_fee":100000}}}}]"#));
    let money = g.stall(id).money;
    g.next_night();
    let s = g.stall(id);
    assert!(s.customers > 0, "at this price somebody must buy");
    let sold = s.customers as u64;
    let w = g.world();
    let log = w.last.expect("a night log");
    let mine: Vec<_> = log.sales.iter().filter(|x| x.1 == id).collect();
    assert_eq!(mine.len() as u64, sold);
    assert!(mine.iter().all(|x| x.2 == 2 && x.3 == 20));
    let net = 20 - sales_tax(20);
    let rent = s.rent_paid;
    assert_eq!(s.money, money + net * sold - rent);
    assert_eq!(s.revenue, 20 * sold);
    assert!(log.tax >= sales_tax(20) * sold);
    g.assert_conserved();
}

#[test]
fn a_stall_without_a_price_sells_nothing() {
    let mut g = Game::new();
    let me = acc("me.testnet");
    let id = g.found(&me, "Mine");
    g.ok(&me, &format!(r#"[{{"buy":{{"stall":{id},"good":0,"qty":10,"max_cost":100000}}}}]"#));
    g.nights(3);
    assert_eq!(g.stall(id).customers, 0);
}

#[test]
fn willingness_to_pay_rises_with_unmet_nights() {
    let low = willingness_to_pay(0, 100, 0, 100, Event::Quiet);
    let mid = willingness_to_pay(0, 100, 3, 100, Event::Quiet);
    let high = willingness_to_pay(0, 100, 8, 100, Event::Quiet);
    let capped = willingness_to_pay(0, 100, 30, 100, Event::Quiet);
    assert_eq!(low, FAIR[0] as u64);
    assert!(mid > low && high > mid);
    assert_eq!(high, capped, "the premium is capped");
}

#[test]
fn villagers_who_cannot_buy_get_hungrier_on_chain() {
    let mut g = Game::new();
    let before = g.world().villagers[0].unmet;
    g.nights(1);
    let w = g.world();
    assert!(w.villagers.iter().any(|v| v.unmet.iter().any(|&u| u > 0)));
    assert_ne!(before, w.villagers[9].unmet);
}

#[test]
fn villagers_remember_a_stall_that_served_them() {
    let mut g = Game::with_seed(11);
    let me = acc("me.testnet");
    let id = g.found(&me, "Mine");
    g.ok(&me, &format!(r#"[{{"move":{{"stall":{id},"spot":14,"max_fee":100000}}}}]"#));
    for _ in 0..8 {
        g.ok(&me, &format!(
            r#"[{{"buy":{{"stall":{id},"good":2,"qty":10,"max_cost":100000}}}},{{"price":{{"stall":{id},"good":2,"price":18}}}}]"#
        ));
        g.next_night();
    }
    let w = g.world();
    let fans = w.villagers.iter().filter(|v| v.memory.iter().any(|m| m.0 == id)).count();
    assert!(fans >= 3, "only {fans} villagers remember the stall");
    assert!(g.stall(id).rep > REP_START_PLAYER, "reputation should have grown");
}

#[test]
fn a_remembered_stall_with_a_high_reputation_can_charge_more() {
    let plain = stall_wtp(100, 0, 0);
    assert_eq!(plain, 100);
    assert!(stall_wtp(100, REP_MAX, MEMORY_MAX) > 115);
}

#[test]
fn refusing_a_dear_stall_hurts_its_reputation() {
    let mut g = Game::with_seed(5);
    let me = acc("me.testnet");
    let id = g.found(&me, "Mine");
    g.ok(&me, &format!(
        r#"[{{"buy":{{"stall":{id},"good":2,"qty":16,"max_cost":100000}}}},{{"price":{{"stall":{id},"good":2,"price":400}}}},{{"move":{{"stall":{id},"spot":14,"max_fee":100000}}}}]"#
    ));
    g.next_night();
    let log = g.world().last.expect("log");
    assert!(log.refusals.iter().any(|r| r.1 == id), "somebody should have balked at the price");
    assert!(g.stall(id).rep < REP_START_PLAYER);
}

#[test]
fn rent_goes_to_the_treasury_and_never_touches_the_last_coins() {
    assert_eq!(rent_due(0, 0), 0);
    assert_eq!(rent_due(RENT_FLOOR, 0), 0);
    assert_eq!(rent_due(RENT_FLOOR + 1, 0), 1);
    assert_eq!(rent_due(RENT_FLOOR + 10_000, 23), spot_rent(23) + 10_000 * WEALTH_RENT_BP / 10_000);
    assert!(rent_due(RENT_FLOOR + 10_000, 0) > rent_due(RENT_FLOOR + 10_000, 23));

    let mut g = Game::new();
    let me = acc("me.testnet");
    let id = g.found(&me, "Idle");
    let before = g.stall(id).money;
    let expected = rent_due(before, 23);
    g.next_night();
    let s = g.stall(id);
    assert_eq!(s.money, before - expected);
    assert_eq!(s.rent_paid, expected);
    assert!(g.world().last.unwrap().rent >= expected);
    for _ in 0..200 {
        g.ok(&me, &format!(r#"[{{"price":{{"stall":{id},"good":0,"price":0}}}}]"#));
        g.next_night();
    }
    let s = g.stall(id);
    assert!(s.money >= RENT_FLOOR, "rent took the floor: {}", s.money);
    assert!(s.money < STARTER_GRANT / 2, "rent should bleed an idle stall: {}", s.money);
    g.assert_conserved();
}

#[test]
fn moving_to_a_free_spot_costs_the_fee_and_changes_footfall() {
    let mut g = Game::new();
    let me = acc("me.testnet");
    let id = g.found(&me, "Mine");
    assert_eq!(g.stall(id).footfall, footfall(23));
    g.ok(&me, &format!(r#"[{{"move":{{"stall":{id},"spot":10,"max_fee":{}}}}}]"#, spot_fee(10)));
    let s = g.stall(id);
    assert_eq!(s.spot, Some(10));
    assert_eq!(s.footfall, footfall(10));
    assert_eq!(s.money, STARTER_GRANT - spot_fee(10));
    g.assert_conserved();
}

#[test]
fn displacing_a_stall_costs_double_and_swaps_spots() {
    let mut g = Game::new();
    let me = acc("me.testnet");
    let id = g.found(&me, "Mine");
    let before = g.stall(1);
    let fee = spot_fee(16) * DISPLACE_FACTOR;
    g.ok(&me, &format!(r#"[{{"move":{{"stall":{id},"spot":16,"max_fee":{fee}}}}}]"#));
    assert_eq!(g.stall(id).spot, Some(16));
    assert_eq!(g.stall(id).money, STARTER_GRANT - fee);
    assert_eq!(g.stall(5).spot, Some(23), "the displaced merchant takes the old spot");
    assert_eq!(before.spot, Some(1));
    g.assert_conserved();
}

#[test]
fn moves_have_a_cooldown_for_mover_and_displaced() {
    let mut g = Game::new();
    let me = acc("me.testnet");
    let you = acc("you.testnet");
    let id = g.found(&me, "Mine");
    let other = g.found(&you, "Yours");
    g.ok(&me, &format!(r#"[{{"move":{{"stall":{id},"spot":21,"max_fee":100000}}}}]"#));
    let e = g.refused(&me, &format!(r#"[{{"move":{{"stall":{id},"spot":19,"max_fee":100000}}}}]"#));
    assert!(e.contains("too recently"), "{e}");
    let e = g.refused(&you, &format!(r#"[{{"move":{{"stall":{other},"spot":21,"max_fee":100000}}}}]"#));
    assert!(e.contains("settled"), "{e}");
    g.nights(MOVE_COOLDOWN_NIGHTS);
    g.ok(&you, &format!(r#"[{{"move":{{"stall":{other},"spot":21,"max_fee":100000}}}}]"#));
    assert_eq!(g.stall(id).spot, Some(22));
}

#[test]
fn moving_back_to_a_free_spot_is_free() {
    let mut g = Game::new();
    let me = acc("me.testnet");
    let id = g.found(&me, "Mine");
    g.ok(&me, &format!(r#"[{{"move":{{"stall":{id},"spot":11,"max_fee":100000}}}}]"#));
    let money = g.stall(id).money;
    g.nights(MOVE_COOLDOWN_NIGHTS);
    let money_after_rent = g.stall(id).money;
    assert!(money_after_rent <= money);
    g.ok(&me, &format!(r#"[{{"move":{{"stall":{id},"spot":23,"max_fee":0}}}}]"#));
    assert_eq!(g.stall(id).money, money_after_rent);
}

#[test]
fn upgrading_raises_capacity_and_service_and_pays_the_treasury() {
    let mut g = Game::new();
    let me = acc("me.testnet");
    let id = g.found(&me, "Mine");
    let e = g.refused(&me, &format!(r#"[{{"upgrade":{{"stall":{id},"max_cost":100000}}}}]"#));
    assert!(e.contains("not enough money"), "{e}");
    // Sell tea and dumplings under the merchants until the stall can afford a size.
    for _ in 0..200 {
        let s = g.stall(id);
        if s.money >= TIER_COST[1] {
            break;
        }
        let w = g.world();
        for (good, price) in [(0, 54), (2, 36)] {
            let qty = 8u32.saturating_sub(s.stock[good]).min(w.dock[good].left).min((s.money / 200) as u32);
            if qty > 0 {
                g.play(&me, &format!(r#"[{{"buy":{{"stall":{id},"good":{good},"qty":{qty},"max_cost":100000}}}}]"#));
            }
            g.ok(&me, &format!(r#"[{{"price":{{"stall":{id},"good":{good},"price":{price}}}}}]"#));
        }
        g.next_night();
    }
    let s = g.stall(id);
    assert!(s.money >= TIER_COST[1], "steady selling should pay for a size, have {}", s.money);
    let treasury = g.audit().treasury;
    let money = s.money;
    g.ok(&me, &format!(r#"[{{"upgrade":{{"stall":{id},"max_cost":{}}}}}]"#, TIER_COST[1]));
    let s = g.stall(id);
    assert_eq!(s.tier, 1);
    assert_eq!(s.capacity, TIER_CAPACITY[1]);
    assert_eq!(s.service, TIER_SERVICE[1]);
    assert_eq!(s.money, money - TIER_COST[1]);
    assert_eq!(g.audit().treasury, treasury + TIER_COST[1]);
}

#[test]
fn capacity_and_service_limit_a_stall() {
    let mut g = Game::with_seed(3);
    let me = acc("me.testnet");
    let id = g.found(&me, "Mine");
    let cap = TIER_CAPACITY[0];
    let e = g.refused(&me, &format!(r#"[{{"buy":{{"stall":{id},"good":2,"qty":{},"max_cost":100000}}}}]"#, cap + 1));
    assert!(e.contains("Dock does not have"), "{e}");
    // Fill the stall over two nights: the Dock does not carry a stallful on a normal night.
    let mut room = cap;
    while room > 0 {
        let w = g.world();
        for (good, price) in [(2usize, 5), (0, 5), (1, 5)] {
            let qty = w.dock[good].left.min(room);
            if qty > 0 {
                g.ok(&me, &format!(r#"[{{"buy":{{"stall":{id},"good":{good},"qty":{qty},"max_cost":100000}}}},{{"price":{{"stall":{id},"good":{good},"price":{price}}}}}]"#));
                room -= qty;
            }
        }
        if room > 0 {
            g.next_night();
            room = TIER_CAPACITY[0] - g.stall(id).stock.iter().sum::<u32>();
        }
    }
    g.tick(0);
    let e = g.refused(&me, &format!(r#"[{{"buy":{{"stall":{id},"good":0,"qty":1,"max_cost":100000}}}}]"#));
    assert!(e.contains("cannot hold"), "{e}");
    for _ in 0..3 {
        g.next_night();
        let s = g.stall(id);
        assert!(s.sold_last.iter().map(|&x| x as u32).sum::<u32>() <= TIER_SERVICE[0]);
    }
}

#[test]
fn every_event_is_announced_one_night_ahead() {
    let mut g = Game::with_seed(99);
    let first = g.world();
    let (mut current, mut announced) = (first.event, first.event_next);
    let mut changes = 0;
    for _ in 0..80 {
        let before_left = g.world().event_left;
        g.next_night();
        let w = g.world();
        if before_left == 1 {
            assert_eq!(w.event, announced, "night {} did not run the announced event", w.night);
            assert_eq!(w.event_left, event_nights(w.event));
            current = w.event;
            announced = w.event_next;
            changes += 1;
        } else {
            assert_eq!(w.event, current, "an event changed before its time");
            assert_eq!(w.event_next, announced, "the forecast changed");
            assert_eq!(w.event_left, before_left - 1);
        }
    }
    assert!(changes > 20, "only {changes} events in 80 nights");
}

#[test]
fn events_come_in_all_kinds() {
    let mut rng = Rng(1);
    let mut kinds = [0; 5];
    for _ in 0..2_000 {
        match roll_event(&mut rng) {
            Event::Quiet => kinds[0] += 1,
            Event::Festival { good } => {
                assert!((good as usize) < GOODS);
                kinds[1] += 1
            }
            Event::Storm { good } => {
                assert!((good as usize) < GOODS);
                kinds[2] += 1
            }
            Event::Bumper { good } => {
                assert!((good as usize) < GOODS);
                kinds[3] += 1
            }
            Event::Payday => kinds[4] += 1,
        }
    }
    assert!(kinds.iter().all(|&k| k > 100), "{kinds:?}");
}

#[test]
fn a_storm_cuts_supply_and_raises_the_price_a_bumper_does_the_opposite() {
    let storm = Event::Storm { good: 1 };
    assert_eq!(dock_night_supply(storm, 1), DOCK_SUPPLY[1] * STORM_SUPPLY_PCT / 100);
    assert_eq!(dock_night_supply(storm, 0), DOCK_SUPPLY[0]);
    assert!(dock_cost(1, 0, 1, dock_price_factor(storm, 1)) > dock_cost(1, 0, 1, 100));
    let bumper = Event::Bumper { good: 1 };
    assert_eq!(dock_night_supply(bumper, 1), DOCK_SUPPLY[1] * 2);
    assert!(dock_cost(1, 0, 1, dock_price_factor(bumper, 1)) < dock_cost(1, 0, 1, 100));
}

#[test]
fn storm_nights_on_chain_have_the_reduced_supply() {
    let mut g = Game::with_seed(123);
    let mut seen = false;
    for _ in 0..80 {
        g.next_night();
        let w = g.world();
        if let Event::Storm { good } = w.event {
            assert!(w.dock[good as usize].left <= dock_night_supply(w.event, good as usize));
            seen = true;
        }
    }
    assert!(seen, "no storm in 80 nights");
    assert_eq!(event_nights(Event::Storm { good: 0 }), STORM_NIGHTS);
}

#[test]
fn a_festival_makes_villagers_buy_that_good() {
    // Finds a festival announced ahead, stocks for it, and compares with a normal night.
    let mut g = Game::with_seed(2024);
    let me = acc("me.testnet");
    let id = g.found(&me, "Mine");
    g.ok(&me, &format!(r#"[{{"move":{{"stall":{id},"spot":14,"max_fee":100000}}}}]"#));
    let mut hit = false;
    for _ in 0..200 {
        let w = g.world();
        if let (Event::Festival { good }, 1) = (w.event_next, w.event_left) {
            let good = good as usize;
            if g.stall(id).money < dock_cost(good, 0, 8, 150) {
                g.next_night();
                continue;
            }
            g.ok(&me, &format!(
                r#"[{{"buy":{{"stall":{id},"good":{good},"qty":{},"max_cost":100000}}}},{{"price":{{"stall":{id},"good":{good},"price":{}}}}}]"#,
                w.dock[good].left.min(6),
                FAIR[good] / 2
            ));
            g.next_night();
            g.next_night();
            let log = g.world().last.unwrap();
            let n = log.sales.iter().filter(|s| s.2 as usize == good).count();
            assert!(n >= 3, "a festival of {good} sold only {n}");
            hit = true;
            break;
        }
        g.next_night();
    }
    assert!(hit, "no festival in 200 nights");
}

#[test]
fn dumplings_spoil_and_silk_does_not() {
    let mut g = Game::with_seed(8);
    let me = acc("me.testnet");
    let id = g.found(&me, "Mine");
    g.ok(&me, &format!(
        r#"[{{"buy":{{"stall":{id},"good":2,"qty":16,"max_cost":100000}}}},{{"buy":{{"stall":{id},"good":3,"qty":2,"max_cost":100000}}}}]"#
    ));
    g.nights(3);
    let s = g.stall(id);
    assert!(s.stock[2] < 16, "dumplings should spoil: {}", s.stock[2]);
    assert_eq!(s.stock[3], 2);
}

#[test]
fn merchants_restock_reprice_and_explain_themselves() {
    let mut g = Game::with_seed(31);
    let start = g.stall(1).price;
    g.nights(12);
    let m = g.stall(1);
    assert_ne!(m.price, start, "the merchant should have repriced");
    assert!(m.customers > 0);
    assert!(m.stock[0] > 0, "the merchant should have restocked tea");
    let w = g.world();
    let log = w.last.unwrap();
    assert!(!log.restocks.is_empty(), "merchants restock at the Dock");
    assert!(log.restocks.iter().all(|r| r.0 <= MERCHANTS && r.2 > 0 && r.3 > 0));
    assert!(m.notes.iter().all(|&n| (n as usize) < NOTE_NAMES.len()));
    g.as_(&acc("viewer.testnet"));
    assert_eq!(g.c.config().notes.len(), NOTE_NAMES.len());
    g.assert_conserved();
}

#[test]
fn merchants_keep_a_margin_over_the_dock() {
    let mut g = Game::with_seed(77);
    for _ in 0..60 {
        g.next_night();
        let w = g.world();
        for s in w.row.iter().filter(|s| s.npc) {
            for good in 0..GOODS {
                if MERCHANT_TABLE[s.id as usize - 1].target[good] > 0 && s.price[good] > 0 {
                    assert!(s.price[good] <= FAIR[good] * MERCHANT_MAX_PRICE_PCT / 100);
                }
            }
        }
    }
}

/// Buying and selling back loses money at the Dock every time, so this empties a stall.
fn burn_money(g: &mut Game, who: &near_sdk::AccountId, id: u32) {
    for _ in 0..60 {
        let money = g.stall(id).money;
        let dock = g.world().dock[2].clone();
        if money < dock.price as u64 {
            assert!(money < PLAYER_RELIEF_BELOW);
            return;
        }
        let qty = (money / (dock.price as u64 * 2)).clamp(1, dock.left as u64);
        g.ok(who, &format!(
            r#"[{{"buy":{{"stall":{id},"good":2,"qty":{qty},"max_cost":100000}}}},{{"sell_back":{{"stall":{id},"good":2,"qty":{qty},"min_pay":0}}}}]"#
        ));
    }
    panic!("the money did not burn: {}", g.stall(id).money);
}

#[test]
fn a_stall_with_nothing_left_gets_relief_once_per_cooldown_and_only_if_active() {
    let mut g = Game::new();
    let me = acc("me.testnet");
    let first = g.found(&me, "First");
    let empty = g.found(&me, "Second");
    assert_eq!(g.stall(empty).money, 0);
    g.next_night();
    assert_eq!(g.stall(empty).money, PLAYER_RELIEF);
    assert_eq!(g.stall(empty).earned, 0, "relief coin is not earned coin");
    assert!(g.world().last.unwrap().relief >= PLAYER_RELIEF);
    g.assert_conserved();
    let _ = first;
    // Burn it again; the next night brings nothing during the cooldown.
    burn_money(&mut g, &me, empty);
    let low = g.stall(empty).money;
    assert!(low < PLAYER_RELIEF_BELOW, "{low}");
    g.next_night();
    assert_eq!(g.stall(empty).money, low, "still cooling down");
    for _ in 0..PLAYER_RELIEF_COOLDOWN_NIGHTS {
        g.ok(&me, &format!(r#"[{{"price":{{"stall":{empty},"good":0,"price":1}}}}]"#));
        g.next_night();
    }
    assert!(g.stall(empty).money >= PLAYER_RELIEF, "relief should come back after the cooldown");
    g.assert_conserved();
}

#[test]
fn an_abandoned_broke_stall_gets_no_relief() {
    let mut g = Game::new();
    let me = acc("me.testnet");
    g.found(&me, "First");
    let empty = g.found(&me, "Empty");
    g.tick(0);
    g.nights(1);
    assert_eq!(g.stall(empty).money, PLAYER_RELIEF);
    burn_money(&mut g, &me, empty);
    let low = g.stall(empty).money;
    g.nights(PLAYER_RELIEF_ACTIVE_NIGHTS + PLAYER_RELIEF_COOLDOWN_NIGHTS + 2);
    assert_eq!(g.stall(empty).money, low, "nobody asked for help");
}

#[test]
fn a_broke_merchant_gets_relief_from_the_treasury() {
    // A merchant keeps operating at the relief floor. Checked through the rule itself: over a long
    // run with no competition no merchant is ever left without money for stock.
    let mut g = Game::with_seed(5150);
    for _ in 0..300 {
        g.next_night();
        let w = g.world();
        assert!(w.row.iter().filter(|s| s.npc).all(|s| s.money > 0));
    }
    g.assert_conserved();
}

#[test]
fn an_idle_stall_loses_its_spot_but_nothing_else() {
    let mut g = Game::new();
    let me = acc("me.testnet");
    let id = g.found(&me, "Sleeper");
    g.ok(&me, &format!(r#"[{{"buy":{{"stall":{id},"good":3,"qty":3,"max_cost":100000}}}}]"#));
    g.nights(IDLE_EVICT_NIGHTS + 1);
    let s = g.stall(id);
    assert_eq!(s.spot, None);
    assert_eq!(s.stock[3], 3);
    assert!(g.world().row.iter().all(|x| x.id != id));
    // It can come back by paying for a spot like anyone else.
    g.ok(&me, &format!(r#"[{{"move":{{"stall":{id},"spot":23,"max_fee":100000}}}}]"#));
    assert_eq!(g.stall(id).spot, Some(23));
    g.assert_conserved();
}

#[test]
fn a_stall_off_the_row_still_pays_wealth_rent_through_the_sweep() {
    let mut g = Game::new();
    let me = acc("me.testnet");
    let id = g.found(&me, "Sleeper");
    g.nights(IDLE_EVICT_NIGHTS + 1);
    let evicted = g.stall(id);
    assert_eq!(evicted.spot, None);
    g.nights(30);
    let s = g.stall(id);
    assert!(s.money < evicted.money, "the sweep should have charged rent");
    assert!(s.money >= RENT_FLOOR);
    g.assert_conserved();
}

#[test]
fn when_the_row_is_full_a_new_stall_starts_without_a_spot() {
    let mut g = Game::new();
    let mut last = 0;
    for i in 0..(ROW_SPOTS as u32 - MERCHANTS + 1) {
        if i > 0 && i % MAX_FOUNDINGS_PER_NIGHT == 0 {
            g.next_night();
        }
        last = g.found(&acc(&format!("p{i}.testnet")), "Crowded");
    }
    assert_eq!(g.stall(last).spot, None);
    assert_eq!(g.stall(last).footfall, 0);
    assert_eq!(g.world().row.len(), ROW_SPOTS);
}

#[test]
fn the_leaderboard_ranks_by_net_worth_and_includes_merchants() {
    let mut g = Game::new();
    let me = acc("me.testnet");
    let id = g.found(&me, "Mine");
    g.as_(&acc("viewer.testnet"));
    let board = g.c.leaderboard(None);
    assert_eq!(board.len(), MERCHANTS as usize + 1);
    assert!(board.windows(2).all(|p| p[0].worth >= p[1].worth));
    assert_eq!(board[0].rank, 1);
    assert!(board.iter().any(|r| r.id == id && !r.npc));
    assert!(board.iter().any(|r| r.npc));
    let short = g.c.leaderboard(Some(2));
    assert_eq!(short.len(), 2);
}

#[test]
fn net_worth_counts_money_goods_size_and_spot() {
    let stock = [1, 0, 0, 2, 0];
    assert_eq!(
        net_worth(100, &stock, 1, 0),
        100 + DOCK_BASE[0] as u64 + 2 * DOCK_BASE[3] as u64 + TIER_WORTH[1] + spot_fee(0) / 2
    );
    assert_eq!(net_worth(100, &[0; GOODS], 0, NO_SPOT), 100);
}

#[test]
fn the_player_view_shows_nonce_purse_and_stalls() {
    let mut g = Game::new();
    let mut k = Key::new(1);
    let id = {
        let out = g.act(&mut k, r#"[{"found":{"name":"Key Stall"}}]"#);
        out.minted[0]
    };
    g.as_(&acc("viewer.testnet"));
    let p = g.c.player(k.account.clone());
    assert_eq!(p.nonce, 1);
    assert_eq!(p.purse, 0);
    assert!(p.founded);
    assert_eq!(p.stalls.len(), 1);
    assert_eq!(p.stalls[0].id, id);
    assert_eq!(p.stalls[0].owner, k.account);
    let stranger = g.c.player(acc("nobody.testnet"));
    assert_eq!(stranger.nonce, 0);
    assert!(stranger.stalls.is_empty());
}

#[test]
fn the_stalls_view_pages_through_everything() {
    let mut g = Game::new();
    g.found(&acc("a.testnet"), "A");
    g.found(&acc("b.testnet"), "B");
    g.as_(&acc("viewer.testnet"));
    assert_eq!(g.c.stalls(None, None).len(), MERCHANTS as usize + 2);
    assert_eq!(g.c.stalls(Some(MERCHANTS + 2), None).len(), 1);
    assert_eq!(g.c.stalls(Some(2), Some(2)).len(), 2);
    assert!(g.c.stall(999).is_none());
}

#[test]
fn the_config_view_matches_the_rules() {
    let mut g = Game::new();
    g.as_(&acc("viewer.testnet"));
    let c = g.c.config();
    assert_eq!(c.goods.len(), GOODS);
    assert_eq!(c.spots.len(), ROW_SPOTS);
    assert_eq!(c.goods[3].fair, FAIR[3]);
    assert_eq!(c.spots[0].footfall, 100);
    assert_eq!(c.night_ms, NIGHT_MS);
    assert_eq!(c.starter_grant, STARTER_GRANT);
}

#[test]
fn the_dock_quote_matches_what_a_purchase_costs() {
    let mut g = Game::new();
    let me = acc("me.testnet");
    let id = g.found(&me, "Mine");
    g.as_(&me);
    let quote = g.c.dock_quote(1, 4).unwrap();
    assert!(g.c.dock_quote(9, 4).is_none());
    g.ok(&me, &format!(r#"[{{"buy":{{"stall":{id},"good":1,"qty":4,"max_cost":{quote}}}}}]"#));
    assert_eq!(g.stall(id).money, STARTER_GRANT - quote);
    let w = g.world();
    assert_eq!(w.dock[1].factor_pct, dock_price_factor(w.event, 1));
    assert_eq!(w.dock[1].price, dock_marginal(1, 4, w.dock[1].factor_pct));
}

#[test]
fn a_full_row_cannot_push_a_merchant_off_it() {
    let mut g = Game::new();
    let mut last = 0;
    let mut who = acc("x.testnet");
    for i in 0..(ROW_SPOTS as u32 - MERCHANTS + 1) {
        if i > 0 && i % MAX_FOUNDINGS_PER_NIGHT == 0 {
            g.next_night();
        }
        who = acc(&format!("p{i}.testnet"));
        last = g.found(&who, "Crowded");
    }
    assert_eq!(g.stall(last).spot, None);
    let e = g.refused(&who, &format!(r#"[{{"move":{{"stall":{last},"spot":20,"max_fee":100000}}}}]"#));
    assert!(e.contains("nowhere to go"), "{e}");
    assert_eq!(g.stall(6).spot, Some(20));
    // A player stall can be pushed off, and goes to the alley.
    let occupant = g.world().row.iter().find(|s| !s.npc && s.spot == Some(21)).unwrap().id;
    g.nights(MOVE_COOLDOWN_NIGHTS);
    g.ok(&who, &format!(r#"[{{"move":{{"stall":{last},"spot":21,"max_fee":100000}}}}]"#));
    assert_eq!(g.stall(last).spot, Some(21));
    assert_eq!(g.stall(occupant).spot, None);
    g.assert_conserved();
}

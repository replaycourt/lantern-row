//! The conservation invariant under random play: whatever anyone does, the coin total never moves.
mod common;

use common::*;
use lantern_row::config::*;
use lantern_row::market::Rng;
use near_sdk::AccountId;

fn random_action(rng: &mut Rng, id: u32, other: u32) -> String {
    let good = rng.below(GOODS as u32 + 1);
    match rng.below(12) {
        0 | 1 | 2 => format!(r#"[{{"buy":{{"stall":{id},"good":{good},"qty":{},"max_cost":1000000}}}}]"#, rng.below(25)),
        3 | 4 | 5 => format!(r#"[{{"price":{{"stall":{id},"good":{good},"price":{}}}}}]"#, rng.below(600)),
        6 => format!(r#"[{{"sell_back":{{"stall":{id},"good":{good},"qty":{},"min_pay":0}}}}]"#, rng.below(10)),
        7 => format!(r#"[{{"move":{{"stall":{id},"spot":{},"max_fee":1000000}}}}]"#, rng.below(26)),
        8 => format!(r#"[{{"upgrade":{{"stall":{id},"max_cost":1000000}}}}]"#),
        9 => format!(r#"[{{"list":{{"stall":{id},"price":{}}}}}]"#, 1 + rng.below(3000)),
        10 => format!(r#"[{{"unlist":{{"stall":{id}}}}},{{"collect":{{"stall":{id}}}}}]"#),
        _ => format!(r#"[{{"buy_stall":{{"with":{id},"target":{other},"max_price":1000000,"min_money":0}}}}]"#),
    }
}

fn run(seed: u64, players: u32, nights: u32) {
    let mut g = Game::with_seed(seed);
    let mut rng = Rng(seed ^ 0xABCD);
    let mut who: Vec<(AccountId, u32)> = Vec::new();
    for i in 0..players {
        if i > 0 && i % MAX_FOUNDINGS_PER_NIGHT == 0 {
            g.next_night();
        }
        let a = acc(&format!("r{i}.testnet"));
        let id = g.found(&a, "Random");
        who.push((a, id));
    }
    let mut applied = 0;
    for _ in 0..nights {
        let actions = rng.below(players * 3);
        for _ in 0..actions {
            let i = rng.below(players) as usize;
            let (a, _) = who[i].clone();
            g.as_(&a);
            // The account's current stalls, since stalls change hands in this run.
            let mine = g.c.player(a.clone()).stalls;
            let Some(stall) = mine.first() else { continue };
            let id = stall.id;
            let other = who[rng.below(players) as usize].1;
            let action = random_action(&mut rng, id, other);
            applied += g.play(&a, &action).applied;
        }
        g.next_night();
        g.assert_conserved();
        let a = g.audit();
        assert!(a.treasury + a.dock + a.villagers + a.stalls + a.purses == FOUNDING_MONEY);
        let w = g.world();
        assert!(w.row.iter().all(|s| s.stock.iter().sum::<u32>() <= s.capacity));
        assert!(w.villagers.iter().all(|v| v.wallet <= v.wage * WALLET_CAP_NIGHTS + VILLAGER_FOUNDING * 2));
    }
    // The run has to mean something: plenty of the random actions must really have happened.
    assert!(applied > nights, "only {applied} actions applied in {nights} nights");
}

#[test]
fn random_play_conserves_coin_seed_1() {
    run(1, 8, 150);
}

#[test]
fn random_play_conserves_coin_seed_2() {
    run(2, 16, 100);
}

#[test]
fn random_play_conserves_coin_seed_3() {
    run(3, 3, 300);
}

#[test]
fn an_empty_world_conserves_coin_for_a_thousand_nights() {
    let mut g = Game::with_seed(4);
    for _ in 0..1_000 {
        g.next_night();
    }
    g.assert_conserved();
}

#[test]
fn every_single_action_kind_conserves_coin() {
    let mut g = Game::with_seed(9);
    let me = acc("me.testnet");
    let id = g.found(&me, "Mine");
    let other = g.found(&acc("other.testnet"), "Other");
    for action in [
        format!(r#"[{{"buy":{{"stall":{id},"good":0,"qty":5,"max_cost":100000}}}}]"#),
        format!(r#"[{{"sell_back":{{"stall":{id},"good":0,"qty":1,"min_pay":0}}}}]"#),
        format!(r#"[{{"price":{{"stall":{id},"good":0,"price":50}}}}]"#),
        format!(r#"[{{"move":{{"stall":{id},"spot":21,"max_fee":100000}}}}]"#),
        format!(r#"[{{"list":{{"stall":{id},"price":10}}}}]"#),
        format!(r#"[{{"unlist":{{"stall":{id}}}}}]"#),
        format!(r#"[{{"rename":{{"stall":{id},"name":"Renamed"}}}}]"#),
        format!(r#"[{{"transfer":{{"stall":{id},"to":"third.testnet"}}}}]"#),
    ] {
        g.ok(&me, &action);
        g.assert_conserved();
    }
    assert_eq!(g.stall(id).owner, acc("third.testnet"));
    g.next_night();
    g.assert_conserved();
    assert!(g.stall(other).money > 0);
}

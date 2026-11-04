//! `advance_night`: timing, bounded catch-up, and how much it stays under the gas limit.
mod common;

use common::*;
use lantern_row::config::*;
use near_sdk::env;

#[test]
fn calling_early_does_nothing_and_does_not_fail() {
    let mut g = Game::new();
    let w = g.world();
    let out = g.advance();
    assert_eq!(out.advanced, 0);
    assert_eq!(out.night, 1);
    assert_eq!(out.ends_ms, w.ends_ms);
    g.tick(NIGHT_MS - 1);
    assert_eq!(g.advance().advanced, 0);
    assert_eq!(g.world().night, 1);
}

#[test]
fn one_call_ends_one_elapsed_night_and_a_second_call_nothing() {
    let mut g = Game::new();
    g.tick(NIGHT_MS);
    let out = g.advance();
    assert_eq!(out.advanced, 1);
    assert_eq!(out.night, 2);
    assert_eq!(g.advance().advanced, 0, "two clients racing must not end two nights");
}

#[test]
fn anyone_can_end_a_night() {
    let mut g = Game::new();
    g.tick(NIGHT_MS);
    g.as_(&acc("total-stranger.testnet"));
    assert_eq!(g.c.advance_night().advanced, 1);
}

#[test]
fn a_part_night_carries_over() {
    let mut g = Game::new();
    g.tick(NIGHT_MS + 5_000);
    let out = g.advance();
    assert_eq!(out.advanced, 1);
    assert_eq!(out.ends_ms, g.now_ms + NIGHT_MS - 5_000);
}

#[test]
fn a_short_absence_is_fully_simulated() {
    let mut g = Game::new();
    g.tick(NIGHT_MS * MAX_CATCHUP_NIGHTS);
    let out = g.advance();
    assert_eq!(out.advanced as u64, MAX_CATCHUP_NIGHTS);
    assert_eq!(out.slept, 0);
    assert_eq!(g.world().night, 1 + MAX_CATCHUP_NIGHTS as u32);
    g.assert_conserved();
}

#[test]
fn a_long_absence_is_bounded_and_leaves_no_backlog() {
    let mut g = Game::new();
    let month = 30 * 24 * 3600 * 1000;
    g.tick(month);
    let out = g.advance();
    assert_eq!(out.advanced as u64, MAX_CATCHUP_NIGHTS);
    assert_eq!(out.slept, month / NIGHT_MS - MAX_CATCHUP_NIGHTS);
    assert_eq!(g.advance().advanced, 0, "the backlog is gone, not queued");
    let w = g.world();
    assert_eq!(w.night, 1 + MAX_CATCHUP_NIGHTS as u32);
    assert_eq!(w.nights_slept, out.slept);
    assert!(!w.due);
    g.assert_conserved();
}

#[test]
fn night_logs_stay_readable_for_a_while_then_rotate() {
    let mut g = Game::new();
    g.nights(LOG_KEEP + 2);
    g.as_(&acc("viewer.testnet"));
    let night = g.c.world().night;
    assert_eq!(g.c.night_log(None).unwrap().night, night - 1);
    assert_eq!(g.c.night_log(Some(night - LOG_KEEP)).unwrap().night, night - LOG_KEEP);
    assert!(g.c.night_log(Some(night - LOG_KEEP - 1)).is_none());
    assert!(g.c.night_log(Some(night)).is_none(), "the current night has no log yet");
}

#[test]
fn a_catch_up_keeps_a_log_for_every_simulated_night() {
    let mut g = Game::new();
    g.tick(NIGHT_MS * 4);
    g.advance();
    g.as_(&acc("viewer.testnet"));
    for n in 1..=4 {
        assert_eq!(g.c.night_log(Some(n)).unwrap().night, n);
    }
}

#[test]
fn the_world_view_says_when_a_night_is_due() {
    let mut g = Game::new();
    assert!(!g.world().due);
    g.tick(NIGHT_MS);
    assert!(g.world().due);
    g.advance();
    assert!(!g.world().due);
}

#[test]
fn host_side_gas_of_a_full_row_catch_up_stays_far_below_the_limit() {
    // The mock VM meters host calls, not wasm instructions. It is a floor for the real figure,
    // which the testnet run in docs/testnet-run.md measures.
    let mut g = Game::new();
    for i in 0..(ROW_SPOTS as u32 - MERCHANTS) {
        if i > 0 && i % MAX_FOUNDINGS_PER_NIGHT == 0 {
            g.next_night();
        }
        let who = acc(&format!("p{i}.testnet"));
        let id = g.found(&who, "Full Row");
        g.ok(&who, &format!(
            r#"[{{"buy":{{"stall":{id},"good":2,"qty":1,"max_cost":100000}}}},{{"price":{{"stall":{id},"good":2,"price":30}}}}]"#
        ));
    }
    g.tick(NIGHT_MS * MAX_CATCHUP_NIGHTS);
    g.as_(&acc("anyone.testnet"));
    let before = env::used_gas();
    let out = g.c.advance_night();
    let spent = env::used_gas().as_gas() - before.as_gas();
    assert_eq!(out.advanced as u64, MAX_CATCHUP_NIGHTS);
    assert!(spent < 100_000_000_000_000, "{} Tgas in host calls", spent / 1_000_000_000_000);
    g.assert_conserved();
}

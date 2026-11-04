//! `act`: signatures, nonces, and what a refused action does.
mod common;

use common::*;
use lantern_row::config::*;

const FOUND: &str = r#"[{"found":{"name":"Key Stall"}}]"#;

fn founded(g: &mut Game) -> (Key, u32) {
    let mut k = Key::new(1);
    let out = g.act(&mut k, FOUND);
    (k, out.minted[0])
}

#[test]
fn a_signed_action_acts_for_the_implicit_account_of_the_key() {
    let mut g = Game::new();
    let mut k = Key::new(1);
    let out = g.act(&mut k, FOUND);
    assert_eq!(out.applied, 1);
    assert_eq!(out.error, None);
    assert_eq!(out.nonce, 1);
    let id = out.minted[0];
    assert_eq!(g.stall(id).owner, k.account);
    assert_eq!(k.account.as_str().len(), 64);
}

#[test]
fn anyone_can_relay_a_signed_action() {
    let mut g = Game::new();
    let k = Key::new(1);
    let sig = k.sign(CONTRACT, 1, FOUND);
    g.as_(&acc("some-relayer.testnet"));
    let out = g.c.act(k.hex.clone(), 1, FOUND.to_string(), sig);
    assert_eq!(out.applied, 1);
}

#[test]
#[should_panic(expected = "nonce already used")]
fn a_replayed_message_is_rejected() {
    let mut g = Game::new();
    let mut k = Key::new(1);
    g.act(&mut k, FOUND);
    let sig = k.sign(CONTRACT, 1, FOUND);
    g.as_(&acc("gas.testnet"));
    g.c.act(k.hex.clone(), 1, FOUND.to_string(), sig);
}

#[test]
#[should_panic(expected = "nonce already used")]
fn an_older_nonce_is_rejected() {
    let mut g = Game::new();
    let (mut k, id) = founded(&mut g);
    let action = format!(r#"[{{"price":{{"stall":{id},"good":0,"price":50}}}}]"#);
    k.nonce = 10;
    g.act(&mut k, &action);
    let sig = k.sign(CONTRACT, 5, &action);
    g.as_(&acc("gas.testnet"));
    g.c.act(k.hex.clone(), 5, action, sig);
}

#[test]
fn nonces_may_skip_ahead() {
    let mut g = Game::new();
    let (mut k, id) = founded(&mut g);
    k.nonce = 1000;
    let out = g.act(&mut k, &format!(r#"[{{"price":{{"stall":{id},"good":0,"price":50}}}}]"#));
    assert_eq!(out.nonce, 1001);
    assert_eq!(out.error, None);
}

#[test]
#[should_panic(expected = "bad signature")]
fn a_tampered_action_fails() {
    let mut g = Game::new();
    let (k, id) = founded(&mut g);
    let signed = format!(r#"[{{"price":{{"stall":{id},"good":0,"price":50}}}}]"#);
    let sent = format!(r#"[{{"price":{{"stall":{id},"good":0,"price":51}}}}]"#);
    let sig = k.sign(CONTRACT, 2, &signed);
    g.as_(&acc("gas.testnet"));
    g.c.act(k.hex.clone(), 2, sent, sig);
}

#[test]
#[should_panic(expected = "bad signature")]
fn a_tampered_nonce_fails() {
    let mut g = Game::new();
    let (k, id) = founded(&mut g);
    let action = format!(r#"[{{"price":{{"stall":{id},"good":0,"price":50}}}}]"#);
    let sig = k.sign(CONTRACT, 2, &action);
    g.as_(&acc("gas.testnet"));
    g.c.act(k.hex.clone(), 3, action, sig);
}

#[test]
#[should_panic(expected = "bad signature")]
fn another_keys_signature_fails() {
    let mut g = Game::new();
    let (k, _) = founded(&mut g);
    let other = Key::new(2);
    let sig = other.sign(CONTRACT, 2, FOUND);
    g.as_(&acc("gas.testnet"));
    g.c.act(k.hex.clone(), 2, FOUND.to_string(), sig);
}

#[test]
#[should_panic(expected = "bad signature")]
fn a_signature_for_another_deployment_fails() {
    let mut g = Game::new();
    let k = Key::new(1);
    let sig = k.sign("other-row.testnet", 1, FOUND);
    g.as_(&acc("gas.testnet"));
    g.c.act(k.hex.clone(), 1, FOUND.to_string(), sig);
}

#[test]
#[should_panic(expected = "bad public key")]
fn an_uppercase_public_key_is_rejected() {
    let mut g = Game::new();
    let k = Key::new(1);
    let sig = k.sign(CONTRACT, 1, FOUND);
    g.as_(&acc("gas.testnet"));
    g.c.act(k.hex.to_uppercase(), 1, FOUND.to_string(), sig);
}

#[test]
#[should_panic(expected = "bad public key")]
fn a_short_public_key_is_rejected() {
    let mut g = Game::new();
    g.as_(&acc("gas.testnet"));
    g.c.act("abcd".to_string(), 1, FOUND.to_string(), "00".repeat(64));
}

#[test]
#[should_panic(expected = "bad signature encoding")]
fn a_short_signature_is_rejected() {
    let mut g = Game::new();
    let k = Key::new(1);
    g.as_(&acc("gas.testnet"));
    g.c.act(k.hex.clone(), 1, FOUND.to_string(), "00".repeat(10));
}

#[test]
#[should_panic(expected = "nonce too large")]
fn a_nonce_beyond_the_safe_range_is_rejected() {
    let mut g = Game::new();
    let k = Key::new(1);
    let sig = k.sign(CONTRACT, u64::MAX, FOUND);
    g.as_(&acc("gas.testnet"));
    g.c.act(k.hex.clone(), u64::MAX, FOUND.to_string(), sig);
}

#[test]
fn the_largest_allowed_nonce_works_once() {
    let mut g = Game::new();
    let mut k = Key::new(1);
    k.nonce = MAX_NONCE - 1;
    let out = g.act(&mut k, FOUND);
    assert_eq!(out.nonce, MAX_NONCE);
    assert_eq!(out.error, None);
}

#[test]
#[should_panic(expected = "malformed action")]
fn malformed_json_fails() {
    let mut g = Game::new();
    let mut k = Key::new(1);
    g.act(&mut k, "not json");
}

#[test]
#[should_panic(expected = "malformed action")]
fn an_unknown_action_fails() {
    let mut g = Game::new();
    let mut k = Key::new(1);
    g.act(&mut k, r#"[{"mint_coins":{"amount":1000000}}]"#);
}

#[test]
#[should_panic(expected = "malformed action")]
fn an_extra_field_fails() {
    let mut g = Game::new();
    let mut k = Key::new(1);
    g.act(&mut k, r#"[{"buy":{"stall":7,"good":0,"qty":1,"max_cost":1,"unit_price":1}}]"#);
}

#[test]
#[should_panic(expected = "action too long")]
fn an_oversized_action_fails() {
    let mut g = Game::new();
    let mut k = Key::new(1);
    let big = " ".repeat(MAX_ACTION_BYTES + 1);
    g.act(&mut k, &big);
}

#[test]
#[should_panic(expected = "too many actions")]
fn too_many_actions_fail() {
    let mut g = Game::new();
    let mut k = Key::new(1);
    let list = vec![r#"{"unlist":{"stall":1}}"#; MAX_ACTIONS_PER_CALL + 1].join(",");
    g.act(&mut k, &format!("[{list}]"));
}

#[test]
fn a_refused_action_spends_the_nonce_and_changes_nothing() {
    let mut g = Game::new();
    let (mut k, id) = founded(&mut g);
    let before = g.stall(id);
    let out = g.act(&mut k, &format!(r#"[{{"buy":{{"stall":{id},"good":0,"qty":5,"max_cost":1}}}}]"#));
    assert_eq!(out.applied, 0);
    assert!(out.error.unwrap().contains("above your limit"));
    assert_eq!(out.nonce, 2);
    let after = g.stall(id);
    assert_eq!(after.money, before.money);
    assert_eq!(after.stock, before.stock);
    g.as_(&acc("viewer.testnet"));
    assert_eq!(g.c.player(k.account.clone()).nonce, 2);
}

#[test]
#[should_panic(expected = "nonce already used")]
fn a_refused_action_cannot_be_replayed_later() {
    let mut g = Game::new();
    let (mut k, id) = founded(&mut g);
    let action = format!(r#"[{{"buy":{{"stall":{id},"good":0,"qty":500,"max_cost":100000}}}}]"#);
    g.act(&mut k, &action);
    let sig = k.sign(CONTRACT, 2, &action);
    g.as_(&acc("gas.testnet"));
    g.c.act(k.hex.clone(), 2, action, sig);
}

#[test]
fn a_batch_stops_at_the_first_refusal_and_keeps_what_came_before() {
    let mut g = Game::new();
    let (mut k, id) = founded(&mut g);
    let action = format!(
        r#"[{{"price":{{"stall":{id},"good":0,"price":50}}}},{{"price":{{"stall":{id},"good":9,"price":50}}}},{{"price":{{"stall":{id},"good":1,"price":70}}}}]"#
    );
    let out = g.act(&mut k, &action);
    assert_eq!(out.applied, 1);
    assert_eq!(out.total, 3);
    assert!(out.error.unwrap().contains("no such good"));
    let s = g.stall(id);
    assert_eq!(s.price[0], 50);
    assert_eq!(s.price[1], 0);
}

#[test]
fn a_stranger_key_leaves_no_trace_and_grows_nothing() {
    let mut g = Game::new();
    let mut k = Key::new(55);
    let before = g.audit();
    let out = g.act(&mut k, r#"[{"price":{"stall":1,"good":0,"price":1}}]"#);
    assert_eq!(out.applied, 0);
    assert!(out.error.unwrap().contains("not your stall"));
    assert_eq!(g.audit(), before);
    g.as_(&acc("viewer.testnet"));
    let p = g.c.player(k.account.clone());
    assert_eq!(p.nonce, 0, "no record is written for a stranger");
    assert!(!p.founded);
}

#[test]
fn a_key_can_only_touch_its_own_stall() {
    let mut g = Game::new();
    let (_, id) = founded(&mut g);
    let mut other = Key::new(2);
    g.act(&mut other, r#"[{"found":{"name":"Other"}}]"#);
    let out = g.act(&mut other, &format!(r#"[{{"price":{{"stall":{id},"good":0,"price":1}}}}]"#));
    assert!(out.error.unwrap().contains("not your stall"));
    assert_eq!(g.stall(id).price[0], 0);
}

#[test]
fn the_signing_text_view_returns_the_exact_message() {
    let mut g = Game::new();
    g.as_(&acc("viewer.testnet"));
    let text = g.c.signing_text(3, "[]".to_string());
    assert_eq!(text, format!("lantern-row:v1:{CONTRACT}:3:[]"));
}

//! The stall as a NEP-171 token: the token is the account.
mod common;

use common::*;
use lantern_row::config::*;
use near_sdk::json_types::U128;
use near_sdk::test_utils::get_logs;

fn owner() -> near_sdk::AccountId {
    acc("owner.testnet")
}

fn next() -> near_sdk::AccountId {
    acc("next.testnet")
}

fn setup() -> (Game, u32, String) {
    let mut g = Game::new();
    let id = g.stocked(&owner(), "Token Stall");
    (g, id, id.to_string())
}

#[test]
fn founding_mints_a_real_token_with_an_event() {
    let mut g = Game::new();
    let id = g.found(&owner(), "Minted");
    let logs = get_logs();
    assert!(logs.iter().any(|l| l.contains("EVENT_JSON") && l.contains("nft_mint") && l.contains("owner.testnet")), "{logs:?}");
    g.as_(&owner());
    let t = g.c.nft_token(id.to_string()).unwrap();
    assert_eq!(t.owner_id, owner());
    assert_eq!(t.token_id, id.to_string());
    assert_eq!(t.metadata.unwrap().copies, Some(1));
}

#[test]
fn transfer_moves_money_stock_reputation_and_spot_with_the_token() {
    let (mut g, id, token) = setup();
    g.next_night();
    let before = g.stall(id);
    g.as_paying(&owner(), 1);
    g.c.nft_transfer(next(), token.clone(), None, None);
    let logs = get_logs();
    let after = g.stall(id);
    assert_eq!(after.owner, next());
    assert_eq!(after.money, before.money);
    assert_eq!(after.stock, before.stock);
    assert_eq!(after.rep, before.rep);
    assert_eq!(after.spot, before.spot);
    assert_eq!(after.holders, vec![owner()]);
    assert_eq!(after.founder, owner());
    assert!(logs.iter().any(|l| l.contains("nft_transfer") && l.contains("next.testnet")), "{logs:?}");
    g.as_(&owner());
    assert_eq!(g.c.nft_supply_for_owner(owner()), U128(0));
    assert_eq!(g.c.nft_supply_for_owner(next()), U128(1));
    g.assert_conserved();
}

#[test]
fn the_new_owner_plays_the_stall_and_the_old_owner_no_longer_can() {
    let (mut g, id, token) = setup();
    g.as_paying(&owner(), 1);
    g.c.nft_transfer(next(), token, None, None);
    let price = format!(r#"[{{"price":{{"stall":{id},"good":0,"price":77}}}}]"#);
    let e = g.refused(&owner(), &price);
    assert!(e.contains("not your stall"));
    g.ok(&next(), &price);
    assert_eq!(g.stall(id).price[0], 77);
}

#[test]
fn a_key_player_can_transfer_by_signature_and_the_receiver_key_takes_over() {
    let mut g = Game::new();
    let mut a = Key::new(1);
    let mut b = Key::new(2);
    let id = g.act(&mut a, r#"[{"found":{"name":"Hand Over"}}]"#).minted[0];
    let out = g.act(&mut a, &format!(r#"[{{"transfer":{{"stall":{id},"to":"{}"}}}}]"#, b.account));
    assert_eq!(out.error, None);
    assert_eq!(g.stall(id).owner, b.account);
    let out = g.act(&mut b, &format!(r#"[{{"price":{{"stall":{id},"good":0,"price":66}}}}]"#));
    assert_eq!(out.error, None);
    let out = g.act(&mut a, &format!(r#"[{{"price":{{"stall":{id},"good":0,"price":1}}}}]"#));
    assert!(out.error.unwrap().contains("not your stall"));
}

#[test]
fn an_implicit_account_with_real_keys_can_use_nft_transfer_directly() {
    let mut g = Game::new();
    let mut k = Key::new(1);
    let id = g.act(&mut k, r#"[{"found":{"name":"Implicit"}}]"#).minted[0];
    g.as_paying(&k.account, 1);
    g.c.nft_transfer(next(), id.to_string(), None, None);
    assert_eq!(g.stall(id).owner, next());
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn nft_transfer_needs_exactly_one_yocto() {
    let (mut g, _, token) = setup();
    g.as_(&owner());
    g.c.nft_transfer(next(), token, None, None);
}

#[test]
#[should_panic(expected = "unauthorized")]
fn nft_transfer_by_a_stranger_fails() {
    let (mut g, _, token) = setup();
    g.as_paying(&acc("stranger.testnet"), 1);
    g.c.nft_transfer(next(), token, None, None);
}

#[test]
#[should_panic(expected = "the token owner and the receiver should be different")]
fn nft_transfer_to_self_fails() {
    let (mut g, _, token) = setup();
    g.as_paying(&owner(), 1);
    g.c.nft_transfer(owner(), token, None, None);
}

#[test]
#[should_panic(expected = "token not found")]
fn nft_transfer_of_a_missing_token_fails() {
    let (mut g, _, _) = setup();
    g.as_paying(&owner(), 1);
    g.c.nft_transfer(next(), "999".to_string(), None, None);
}

#[test]
#[should_panic(expected = "token not found")]
fn nft_transfer_of_a_garbage_token_id_fails() {
    let (mut g, _, _) = setup();
    g.as_paying(&owner(), 1);
    g.c.nft_transfer(next(), "abc".to_string(), None, None);
}

#[test]
#[should_panic(expected = "unauthorized")]
fn a_merchant_stall_cannot_be_taken() {
    let (mut g, _, _) = setup();
    g.as_paying(&owner(), 1);
    g.c.nft_transfer(next(), "1".to_string(), None, None);
}

#[test]
fn nft_token_of_a_missing_id_is_none() {
    let (mut g, _, _) = setup();
    g.as_(&owner());
    assert!(g.c.nft_token("999".to_string()).is_none());
    assert!(g.c.nft_token("abc".to_string()).is_none());
}

#[test]
fn approvals_let_an_approved_account_transfer_once() {
    let (mut g, id, token) = setup();
    let market = acc("market.testnet");
    g.as_paying(&owner(), 1);
    assert!(g.c.nft_approve(token.clone(), market.clone(), None).is_none());
    g.as_(&owner());
    assert!(g.c.nft_is_approved(token.clone(), market.clone(), None));
    assert!(g.c.nft_is_approved(token.clone(), market.clone(), Some(0)));
    assert!(!g.c.nft_is_approved(token.clone(), market.clone(), Some(5)));
    let t = g.c.nft_token(token.clone()).unwrap();
    assert_eq!(t.approved_account_ids.unwrap().get(&market), Some(&0));
    g.as_paying(&market, 1);
    g.c.nft_transfer(next(), token.clone(), Some(0), None);
    assert_eq!(g.stall(id).owner, next());
    g.as_(&owner());
    assert!(!g.c.nft_is_approved(token, market, None), "a transfer clears approvals");
}

#[test]
#[should_panic(expected = "wrong approval id")]
fn a_stale_approval_id_fails() {
    let (mut g, _, token) = setup();
    let market = acc("market.testnet");
    g.as_paying(&owner(), 1);
    g.c.nft_approve(token.clone(), market.clone(), None);
    g.as_paying(&market, 1);
    g.c.nft_transfer(next(), token, Some(9), None);
}

#[test]
#[should_panic(expected = "unauthorized")]
fn a_revoked_account_cannot_transfer() {
    let (mut g, _, token) = setup();
    let market = acc("market.testnet");
    g.as_paying(&owner(), 1);
    g.c.nft_approve(token.clone(), market.clone(), None);
    g.as_paying(&owner(), 1);
    g.c.nft_revoke(token.clone(), market.clone());
    g.as_paying(&market, 1);
    g.c.nft_transfer(next(), token, None, None);
}

#[test]
fn revoke_all_clears_every_approval() {
    let (mut g, _, token) = setup();
    for name in ["a.testnet", "b.testnet"] {
        g.as_paying(&owner(), 1);
        g.c.nft_approve(token.clone(), acc(name), None);
    }
    g.as_paying(&owner(), 1);
    g.c.nft_revoke_all(token.clone());
    g.as_(&owner());
    assert!(!g.c.nft_is_approved(token.clone(), acc("a.testnet"), None));
    assert!(!g.c.nft_is_approved(token, acc("b.testnet"), None));
}

#[test]
#[should_panic(expected = "only the owner can approve")]
fn only_the_owner_can_approve() {
    let (mut g, _, token) = setup();
    g.as_paying(&next(), 1);
    g.c.nft_approve(token, next(), None);
}

#[test]
#[should_panic(expected = "too many approvals")]
fn approvals_are_capped() {
    let (mut g, _, token) = setup();
    for i in 0..=MAX_APPROVALS {
        g.as_paying(&owner(), 1);
        g.c.nft_approve(token.clone(), acc(&format!("m{i}.testnet")), None);
    }
}

#[test]
fn enumeration_lists_supply_tokens_and_owners() {
    let (mut g, id, _) = setup();
    g.as_(&owner());
    assert_eq!(g.c.nft_total_supply(), U128(MERCHANTS as u128 + 1));
    assert_eq!(g.c.nft_supply_for_owner(owner()), U128(1));
    assert_eq!(g.c.nft_supply_for_owner(contract_id()), U128(MERCHANTS as u128));
    let all = g.c.nft_tokens(None, None);
    assert_eq!(all.len(), MERCHANTS as usize + 1);
    assert_eq!(all[0].token_id, "1");
    let page = g.c.nft_tokens(Some(U128(2)), Some(2));
    assert_eq!(page.iter().map(|t| t.token_id.as_str()).collect::<Vec<_>>(), ["3", "4"]);
    assert!(g.c.nft_tokens(Some(U128(100)), None).is_empty());
    let mine = g.c.nft_tokens_for_owner(owner(), None, None);
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].token_id, id.to_string());
    assert!(g.c.nft_tokens_for_owner(acc("nobody.testnet"), None, None).is_empty());
}

#[test]
fn contract_metadata_follows_the_standard() {
    let (mut g, _, _) = setup();
    g.as_(&owner());
    let m = g.c.nft_metadata();
    m.assert_valid();
    assert_eq!(m.symbol, "STALL");
}

#[test]
fn token_metadata_is_dynamic_and_valid() {
    let (mut g, id, token) = setup();
    g.as_(&owner());
    let m1 = g.c.nft_token(token.clone()).unwrap().metadata.unwrap();
    m1.assert_valid();
    assert!(m1.title.as_ref().unwrap().contains("Token Stall"));
    assert!(m1.media.as_ref().unwrap().starts_with("data:image/svg+xml,"));
    let extra: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(m1.extra.as_ref().unwrap()).unwrap();
    assert_eq!(extra["id"], id);
    assert_eq!(extra["money"], g.stall(id).money);

    g.ok(&owner(), &format!(r#"[{{"rename":{{"stall":{id},"name":"New Sign"}}}},{{"move":{{"stall":{id},"spot":15,"max_fee":100000}}}}]"#));
    g.next_night();
    g.as_(&owner());
    let m2 = g.c.nft_token(token).unwrap().metadata.unwrap();
    m2.assert_valid();
    assert!(m2.title.unwrap().contains("New Sign"));
    assert_ne!(m1.description, m2.description);
    assert_ne!(m1.media, m2.media);
    assert_ne!(m1.media_hash, m2.media_hash);
    assert!(m2.description.unwrap().contains("Spot 15"));
}

#[test]
fn token_media_hash_matches_the_decoded_picture() {
    let (mut g, _, token) = setup();
    g.as_(&owner());
    let m = g.c.nft_token(token).unwrap().metadata.unwrap();
    let encoded = m.media.unwrap();
    let body = encoded.strip_prefix("data:image/svg+xml,").unwrap();
    let mut bytes = Vec::new();
    let raw = body.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' {
            let h = std::str::from_utf8(&raw[i + 1..i + 3]).unwrap();
            bytes.push(u8::from_str_radix(h, 16).unwrap());
            i += 3;
        } else {
            bytes.push(raw[i]);
            i += 1;
        }
    }
    assert!(std::str::from_utf8(&bytes).unwrap().starts_with("<svg"));
    assert_eq!(near_sdk::env::sha256(&bytes), m.media_hash.unwrap().0);
}

#[test]
fn the_payout_gives_the_founder_the_royalty() {
    let (mut g, _, token) = setup();
    g.as_paying(&owner(), 1);
    g.c.nft_transfer(next(), token.clone(), None, None);
    g.as_(&next());
    let p = g.c.nft_payout(token, U128(1_000_000), Some(10)).payout;
    assert_eq!(p.get(&owner()), Some(&U128(50_000)));
    assert_eq!(p.get(&next()), Some(&U128(950_000)));
    assert_eq!(p.values().map(|v| v.0).sum::<u128>(), 1_000_000);
}

#[test]
fn the_payout_to_a_founder_who_still_owns_is_one_entry() {
    let (mut g, _, token) = setup();
    g.as_(&owner());
    let p = g.c.nft_payout(token, U128(1_000), None).payout;
    assert_eq!(p.len(), 1);
    assert_eq!(p.get(&owner()), Some(&U128(1_000)));
}

#[test]
#[should_panic(expected = "the payout needs at least 2 entries")]
fn the_payout_respects_max_len() {
    let (mut g, _, token) = setup();
    g.as_paying(&owner(), 1);
    g.c.nft_transfer(next(), token.clone(), None, None);
    g.as_(&next());
    g.c.nft_payout(token, U128(1_000), Some(1));
}

#[test]
fn nft_transfer_payout_pays_out_and_moves_the_token() {
    let (mut g, id, token) = setup();
    g.as_paying(&owner(), 1);
    g.c.nft_transfer(next(), token.clone(), None, None);
    let market = acc("market.testnet");
    g.as_paying(&next(), 1);
    g.c.nft_approve(token.clone(), market.clone(), None);
    g.as_paying(&market, 1);
    let buyer = acc("buyer.testnet");
    let p = g.c.nft_transfer_payout(buyer.clone(), token, Some(0), None, U128(10_000), Some(5));
    assert_eq!(p.payout.get(&owner()), Some(&U128(500)));
    assert_eq!(p.payout.get(&next()), Some(&U128(9_500)));
    assert_eq!(g.stall(id).owner, buyer);
}

fn resolve(g: &mut Game, id: u32, receiver_answer: Option<&str>, prev: near_sdk::AccountId, receiver: near_sdk::AccountId) -> bool {
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{PromiseResult, testing_env};
    let result = match receiver_answer {
        Some(a) => PromiseResult::Successful(a.as_bytes().to_vec()),
        None => PromiseResult::Failed,
    };
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id()).predecessor_account_id(contract_id());
    let ctx = b.build();
    testing_env!(
        ctx,
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        std::collections::HashMap::default(),
        vec![result],
    );
    g.c.nft_resolve_transfer(prev, receiver, id.to_string(), None)
}

#[test]
fn nft_transfer_call_keeps_the_token_when_the_receiver_accepts() {
    let (mut g, id, token) = setup();
    let receiver = acc("receiver.testnet");
    g.as_paying(&owner(), 1);
    let _ = g.c.nft_transfer_call(receiver.clone(), token, None, None, "hello".to_string());
    assert_eq!(g.stall(id).owner, receiver);
    assert!(resolve(&mut g, id, Some("false"), owner(), receiver.clone()));
    assert_eq!(g.stall(id).owner, receiver);
}

#[test]
fn nft_transfer_call_returns_the_token_when_the_receiver_refuses() {
    let (mut g, id, token) = setup();
    let receiver = acc("receiver.testnet");
    g.as_paying(&owner(), 1);
    let _ = g.c.nft_transfer_call(receiver.clone(), token, None, None, "no".to_string());
    assert!(!resolve(&mut g, id, Some("true"), owner(), receiver.clone()));
    let s = g.stall(id);
    assert_eq!(s.owner, owner());
    assert!(s.holders.is_empty(), "a bounce is not a change of hands");
    g.as_(&owner());
    assert_eq!(g.c.nft_supply_for_owner(owner()), U128(1));
    assert_eq!(g.c.nft_supply_for_owner(receiver), U128(0));
}

#[test]
fn nft_transfer_call_returns_the_token_when_the_receiver_panics() {
    let (mut g, id, token) = setup();
    let receiver = acc("receiver.testnet");
    g.as_paying(&owner(), 1);
    let _ = g.c.nft_transfer_call(receiver.clone(), token, None, None, "x".to_string());
    assert!(!resolve(&mut g, id, None, owner(), receiver));
    assert_eq!(g.stall(id).owner, owner());
}

#[test]
fn nft_resolve_leaves_a_token_the_receiver_already_passed_on() {
    let (mut g, id, token) = setup();
    let receiver = acc("receiver.testnet");
    let third = acc("third.testnet");
    g.as_paying(&owner(), 1);
    let _ = g.c.nft_transfer_call(receiver.clone(), token.clone(), None, None, "x".to_string());
    g.as_paying(&receiver, 1);
    g.c.nft_transfer(third.clone(), token, None, None);
    assert!(resolve(&mut g, id, Some("true"), owner(), receiver));
    assert_eq!(g.stall(id).owner, third);
}

#[test]
fn holder_history_keeps_the_latest_few() {
    let (mut g, id, token) = setup();
    let names = ["h1.testnet", "h2.testnet", "h3.testnet", "h4.testnet", "h5.testnet"];
    let mut from = owner();
    for n in names {
        let to = acc(n);
        g.as_paying(&from, 1);
        g.c.nft_transfer(to.clone(), token.clone(), None, None);
        from = to;
    }
    let s = g.stall(id);
    assert_eq!(s.holders.len(), MAX_HOLDER_HISTORY);
    assert_eq!(s.holders.last().unwrap().as_str(), "h4.testnet");
}

#[test]
#[should_panic(expected = "that account holds too many stalls")]
fn an_account_cannot_be_flooded_past_the_cap() {
    let mut g = Game::new();
    let target = acc("target.testnet");
    for i in 0..=MAX_TOKENS_PER_ACCOUNT {
        if i > 0 && i % MAX_FOUNDINGS_PER_NIGHT as usize == 0 {
            g.next_night();
        }
        let from = acc(&format!("s{i}.testnet"));
        let id = g.found(&from, "Gift");
        g.as_paying(&from, 1);
        g.c.nft_transfer(target.clone(), id.to_string(), None, None);
    }
}

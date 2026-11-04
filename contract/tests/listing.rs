//! Selling a stall on the row: listing, purchase, tax, founder royalty, and the guards around them.
mod common;

use common::*;
use lantern_row::config::*;
use lantern_row::market::*;
use near_sdk::AccountId;

fn seller() -> AccountId {
    acc("seller.testnet")
}
fn buyer() -> AccountId {
    acc("buyer.testnet")
}

/// A stall that has earned money from villagers, so it may buy other stalls.
fn earner(g: &mut Game, who: &AccountId, min_earned: u64) -> u32 {
    let id = g.found(who, "Earner");
    g.ok(who, &format!(r#"[{{"move":{{"stall":{id},"spot":14,"max_fee":100000}}}}]"#));
    for _ in 0..300 {
        let s = g.stall(id);
        if s.earned >= min_earned && s.money >= min_earned {
            return id;
        }
        let room = s.capacity - s.stock.iter().sum::<u32>();
        let qty = room.min(g.world().dock[2].left).min(6).saturating_sub(s.stock[2]).min((s.money / 40) as u32);
        if qty > 0 {
            g.ok(who, &format!(r#"[{{"buy":{{"stall":{id},"good":2,"qty":{qty},"max_cost":100000}}}}]"#));
        }
        g.ok(who, &format!(r#"[{{"price":{{"stall":{id},"good":2,"price":30}}}}]"#));
        g.next_night();
    }
    panic!("the stall did not earn {min_earned}: {:?}", g.stall(id));
}

#[test]
fn a_sale_moves_the_token_with_everything_and_splits_the_price() {
    let mut g = Game::with_seed(1);
    let pay_with = earner(&mut g, &buyer(), 1_000);
    let target = g.stocked(&seller(), "For Sale");
    let price = 800;
    g.ok(&seller(), &format!(r#"[{{"list":{{"stall":{target},"price":{price}}}}}]"#));
    assert_eq!(g.stall(target).listed, Some(price));
    assert!(g.world().listings.contains(&(target, price)));
    let money_inside = g.stall(target).money;
    let stock_inside = g.stall(target).stock;
    let payer_before = g.stall(pay_with).money;
    let earned_before = g.stall(pay_with).earned;
    let treasury = g.audit().treasury;

    g.ok(&buyer(), &format!(r#"[{{"buy_stall":{{"with":{pay_with},"target":{target},"max_price":{price},"min_money":0}}}}]"#));

    let t = g.stall(target);
    assert_eq!(t.owner, buyer());
    assert_eq!(t.money, money_inside);
    assert_eq!(t.stock, stock_inside);
    assert_eq!(t.listed, None);
    assert_eq!(t.holders, vec![seller()]);
    let p = g.stall(pay_with);
    assert_eq!(p.money, payer_before - price);
    assert_eq!(p.earned, earned_before - price);
    assert_eq!(g.audit().treasury, treasury + sales_tax(price));
    // The seller founded it, so the seller gets royalty and proceeds.
    assert_eq!(g.purse(&seller()), price - sales_tax(price));
    g.assert_conserved();
}

#[test]
fn a_resale_pays_the_royalty_to_whoever_minted_it() {
    let mut g = Game::with_seed(1);
    let founder = acc("founder.testnet");
    let target = g.found(&founder, "Heirloom");
    g.as_paying(&founder, 1);
    g.c.nft_transfer(seller(), target.to_string(), None, None);
    let pay_with = earner(&mut g, &buyer(), 1_000);
    let price = 1_000;
    g.ok(&seller(), &format!(r#"[{{"list":{{"stall":{target},"price":{price}}}}}]"#));
    g.ok(&buyer(), &format!(r#"[{{"buy_stall":{{"with":{pay_with},"target":{target},"max_price":{price},"min_money":0}}}}]"#));
    assert_eq!(g.purse(&founder), royalty(price));
    assert_eq!(g.purse(&seller()), price - royalty(price) - sales_tax(price));
    g.assert_conserved();
}

#[test]
fn a_purse_can_be_collected_into_any_stall_of_the_account() {
    let mut g = Game::with_seed(1);
    let pay_with = earner(&mut g, &buyer(), 1_000);
    let target = g.found(&seller(), "Sold");
    g.ok(&seller(), &format!(r#"[{{"list":{{"stall":{target},"price":500}}}}]"#));
    g.ok(&buyer(), &format!(r#"[{{"buy_stall":{{"with":{pay_with},"target":{target},"max_price":500,"min_money":0}}}}]"#));
    let purse = g.purse(&seller());
    assert!(purse > 0);
    // The seller has no stall left: found a new one (no second grant) and collect.
    let fresh = g.found(&seller(), "Fresh Start");
    assert_eq!(g.stall(fresh).money, 0);
    g.ok(&seller(), &format!(r#"[{{"collect":{{"stall":{fresh}}}}}]"#));
    assert_eq!(g.purse(&seller()), 0);
    let s = g.stall(fresh);
    assert_eq!(s.money, purse);
    assert_eq!(s.earned, purse);
    let e = g.refused(&seller(), &format!(r#"[{{"collect":{{"stall":{fresh}}}}}]"#));
    assert!(e.contains("empty"));
    g.assert_conserved();
}

#[test]
fn a_starter_grant_cannot_buy_a_stall() {
    let mut g = Game::new();
    let throwaway = g.found(&buyer(), "Throwaway");
    let target = g.found(&seller(), "Target");
    g.ok(&seller(), &format!(r#"[{{"list":{{"stall":{target},"price":100}}}}]"#));
    let e = g.refused(&buyer(), &format!(r#"[{{"buy_stall":{{"with":{throwaway},"target":{target},"max_price":100,"min_money":0}}}}]"#));
    assert!(e.contains("earned"), "{e}");
    assert_eq!(g.purse(&seller()), 0);
}

#[test]
fn the_buy_guards_stop_price_and_money_changes() {
    let mut g = Game::with_seed(1);
    let pay_with = earner(&mut g, &buyer(), 1_000);
    let target = g.stocked(&seller(), "Target");
    g.ok(&seller(), &format!(r#"[{{"list":{{"stall":{target},"price":500}}}}]"#));
    let e = g.refused(&buyer(), &format!(r#"[{{"buy_stall":{{"with":{pay_with},"target":{target},"max_price":499,"min_money":0}}}}]"#));
    assert!(e.contains("above your limit"), "{e}");
    let e = g.refused(&buyer(), &format!(r#"[{{"buy_stall":{{"with":{pay_with},"target":{target},"max_price":500,"min_money":999999}}}}]"#));
    assert!(e.contains("less money"), "{e}");
    assert_eq!(g.stall(target).owner, seller());
}

#[test]
fn a_listed_stall_cannot_be_stripped_but_keeps_selling() {
    let mut g = Game::with_seed(1);
    let target = g.stocked(&seller(), "Frozen");
    g.ok(&seller(), &format!(r#"[{{"list":{{"stall":{target},"price":500}}}}]"#));
    for action in [
        format!(r#"[{{"buy":{{"stall":{target},"good":0,"qty":1,"max_cost":100000}}}}]"#),
        format!(r#"[{{"sell_back":{{"stall":{target},"good":0,"qty":1,"min_pay":0}}}}]"#),
        format!(r#"[{{"move":{{"stall":{target},"spot":20,"max_fee":100000}}}}]"#),
        format!(r#"[{{"upgrade":{{"stall":{target},"max_cost":100000}}}}]"#),
    ] {
        let e = g.refused(&seller(), &action);
        assert!(e.contains("unlist"), "{e}");
    }
    g.ok(&seller(), &format!(r#"[{{"price":{{"stall":{target},"good":0,"price":50}}}}]"#));
    g.ok(&seller(), &format!(r#"[{{"unlist":{{"stall":{target}}}}}]"#));
    assert_eq!(g.stall(target).listed, None);
    let e = g.refused(&seller(), &format!(r#"[{{"unlist":{{"stall":{target}}}}}]"#));
    assert!(e.contains("not listed"));
}

#[test]
fn a_listed_stall_cannot_pay_for_another() {
    let mut g = Game::with_seed(1);
    let pay_with = earner(&mut g, &buyer(), 1_000);
    let target = g.found(&seller(), "Target");
    g.ok(&seller(), &format!(r#"[{{"list":{{"stall":{target},"price":100}}}}]"#));
    g.ok(&buyer(), &format!(r#"[{{"list":{{"stall":{pay_with},"price":100}}}}]"#));
    let e = g.refused(&buyer(), &format!(r#"[{{"buy_stall":{{"with":{pay_with},"target":{target},"max_price":100,"min_money":0}}}}]"#));
    assert!(e.contains("unlist"), "{e}");
}

#[test]
fn only_the_owner_can_list_and_nobody_buys_their_own() {
    let mut g = Game::with_seed(1);
    let pay_with = earner(&mut g, &buyer(), 1_000);
    let other = g.found(&buyer(), "Second");
    let e = g.refused(&seller(), &format!(r#"[{{"list":{{"stall":{other},"price":100}}}}]"#));
    assert!(e.contains("not your stall"));
    g.ok(&buyer(), &format!(r#"[{{"list":{{"stall":{other},"price":100}}}}]"#));
    let e = g.refused(&buyer(), &format!(r#"[{{"buy_stall":{{"with":{pay_with},"target":{other},"max_price":100,"min_money":0}}}}]"#));
    assert!(e.contains("already yours"), "{e}");
    let e = g.refused(&buyer(), &format!(r#"[{{"buy_stall":{{"with":{pay_with},"target":{pay_with},"max_price":100,"min_money":0}}}}]"#));
    assert!(e.contains("buy itself"), "{e}");
}

#[test]
fn buying_an_unlisted_stall_fails() {
    let mut g = Game::with_seed(1);
    let pay_with = earner(&mut g, &buyer(), 1_000);
    let target = g.found(&seller(), "Target");
    let e = g.refused(&buyer(), &format!(r#"[{{"buy_stall":{{"with":{pay_with},"target":{target},"max_price":100,"min_money":0}}}}]"#));
    assert!(e.contains("not for sale"), "{e}");
    // A merchant stall is never for sale either.
    let e = g.refused(&buyer(), &format!(r#"[{{"buy_stall":{{"with":{pay_with},"target":1,"max_price":100,"min_money":0}}}}]"#));
    assert!(e.contains("not for sale"), "{e}");
}

#[test]
fn a_transfer_clears_the_listing() {
    let mut g = Game::new();
    let target = g.found(&seller(), "Target");
    g.ok(&seller(), &format!(r#"[{{"list":{{"stall":{target},"price":100}}}}]"#));
    g.as_paying(&seller(), 1);
    g.c.nft_transfer(acc("friend.testnet"), target.to_string(), None, None);
    assert_eq!(g.stall(target).listed, None);
    assert!(g.world().listings.is_empty());
}

#[test]
fn relisting_changes_the_price_and_the_board_is_capped() {
    let mut g = Game::new();
    let target = g.found(&seller(), "Target");
    g.ok(&seller(), &format!(r#"[{{"list":{{"stall":{target},"price":100}}}}]"#));
    g.ok(&seller(), &format!(r#"[{{"list":{{"stall":{target},"price":200}}}}]"#));
    assert_eq!(g.world().listings, vec![(target, 200)]);
    for bad in [0u64, FOUNDING_MONEY + 1] {
        let e = g.refused(&seller(), &format!(r#"[{{"list":{{"stall":{target},"price":{bad}}}}}]"#));
        assert!(e.contains("asking price"));
    }
    for i in 0..(MAX_LISTINGS as u32 - 1) {
        if i % MAX_FOUNDINGS_PER_NIGHT == 0 {
            g.next_night();
        }
        let who = acc(&format!("l{i}.testnet"));
        let id = g.found(&who, "Lister");
        g.ok(&who, &format!(r#"[{{"list":{{"stall":{id},"price":100}}}}]"#));
    }
    g.next_night();
    let who = acc("toolate.testnet");
    let id = g.found(&who, "Late");
    let e = g.refused(&who, &format!(r#"[{{"list":{{"stall":{id},"price":100}}}}]"#));
    assert!(e.contains("full"));
}

#[test]
fn a_key_player_can_sell_and_buy_by_signature() {
    let mut g = Game::with_seed(1);
    let pay_with = earner(&mut g, &buyer(), 1_000);
    let mut k = Key::new(9);
    let target = g.act(&mut k, r#"[{"found":{"name":"Key Sale"}}]"#).minted[0];
    let out = g.act(&mut k, &format!(r#"[{{"list":{{"stall":{target},"price":300}}}}]"#));
    assert_eq!(out.error, None);
    g.ok(&buyer(), &format!(r#"[{{"buy_stall":{{"with":{pay_with},"target":{target},"max_price":300,"min_money":0}}}}]"#));
    assert_eq!(g.stall(target).owner, buyer());
    assert!(g.purse(&k.account) > 0);
}

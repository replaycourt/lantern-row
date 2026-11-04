//! Attempts to cheat: forged prices, overflows, empty stock, caps, bad names.
mod common;

use common::*;
use lantern_row::config::*;
use near_sdk::AccountId;

fn me() -> AccountId {
    acc("me.testnet")
}

fn game_with_stall() -> (Game, u32) {
    let mut g = Game::new();
    let id = g.found(&me(), "Mine");
    (g, id)
}

#[test]
fn a_client_cannot_name_its_own_wholesale_price() {
    // The only price field in a purchase is a limit; there is no way to send a unit price.
    let (mut g, id) = game_with_stall();
    let e = g.refused(&me(), &format!(r#"[{{"buy":{{"stall":{id},"good":3,"qty":3,"max_cost":1}}}}]"#));
    assert!(e.contains("above your limit"), "{e}");
    assert_eq!(g.stall(id).stock[3], 0);
    assert_eq!(g.stall(id).money, STARTER_GRANT);
}

#[test]
fn a_huge_limit_does_not_change_what_is_charged() {
    let (mut g, id) = game_with_stall();
    g.ok(&me(), &format!(r#"[{{"buy":{{"stall":{id},"good":0,"qty":1,"max_cost":{}}}}}]"#, u64::MAX));
    assert!(g.stall(id).money > STARTER_GRANT - 200);
}

#[test]
fn a_purchase_beyond_the_money_is_refused_whole() {
    let (mut g, id) = game_with_stall();
    // A second stall of the same account starts with nothing.
    let poor = g.found(&me(), "Poor");
    assert_eq!(g.stall(poor).money, 0);
    let e = g.refused(&me(), &format!(r#"[{{"buy":{{"stall":{poor},"good":0,"qty":1,"max_cost":{}}}}}]"#, u64::MAX));
    assert!(e.contains("not enough money"), "{e}");
    assert_eq!(g.stall(poor).stock[0], 0);
    let money = g.stall(id).money;
    g.ok(&me(), &format!(r#"[{{"buy":{{"stall":{id},"good":3,"qty":3,"max_cost":{}}}}}]"#, u64::MAX));
    assert!(g.stall(id).money < money);
    g.assert_conserved();
}

#[test]
fn absurd_quantities_do_not_overflow() {
    let (mut g, id) = game_with_stall();
    for good in 0..GOODS {
        let e = g.refused(&me(), &format!(r#"[{{"buy":{{"stall":{id},"good":{good},"qty":{},"max_cost":{}}}}}]"#, u32::MAX, u64::MAX));
        assert!(e.contains("Dock does not have"), "{e}");
    }
    let e = g.refused(&me(), &format!(r#"[{{"sell_back":{{"stall":{id},"good":0,"qty":{},"min_pay":0}}}}]"#, u32::MAX));
    assert!(e.contains("does not hold"), "{e}");
}

#[test]
fn dock_cost_saturates_rather_than_wraps() {
    use lantern_row::market::dock_cost;
    let c = dock_cost(3, u32::MAX, u32::MAX, u32::MAX);
    assert_eq!(c, u64::MAX);
}

#[test]
#[should_panic(expected = "malformed action")]
fn a_quantity_beyond_u32_is_malformed() {
    let (mut g, id) = game_with_stall();
    g.play(&me(), &format!(r#"[{{"buy":{{"stall":{id},"good":0,"qty":99999999999,"max_cost":1}}}}]"#));
}

#[test]
#[should_panic(expected = "malformed action")]
fn a_negative_quantity_is_malformed() {
    let (mut g, id) = game_with_stall();
    g.play(&me(), &format!(r#"[{{"buy":{{"stall":{id},"good":0,"qty":-1,"max_cost":1}}}}]"#));
}

#[test]
fn zero_quantities_are_refused() {
    let (mut g, id) = game_with_stall();
    let e = g.refused(&me(), &format!(r#"[{{"buy":{{"stall":{id},"good":0,"qty":0,"max_cost":1}}}}]"#));
    assert!(e.contains("positive"));
    let e = g.refused(&me(), &format!(r#"[{{"sell_back":{{"stall":{id},"good":0,"qty":0,"min_pay":0}}}}]"#));
    assert!(e.contains("positive"));
}

#[test]
fn nonexistent_goods_and_stalls_are_refused() {
    let (mut g, id) = game_with_stall();
    for bad in [
        format!(r#"[{{"buy":{{"stall":{id},"good":5,"qty":1,"max_cost":100}}}}]"#),
        format!(r#"[{{"sell_back":{{"stall":{id},"good":200,"qty":1,"min_pay":0}}}}]"#),
        format!(r#"[{{"price":{{"stall":{id},"good":5,"price":1}}}}]"#),
    ] {
        assert!(g.refused(&me(), &bad).contains("no such good"));
    }
    assert!(g.refused(&me(), r#"[{"price":{"stall":9999,"good":0,"price":1}}]"#).contains("no such stall"));
    assert!(g.refused(&me(), r#"[{"price":{"stall":0,"good":0,"price":1}}]"#).contains("no such stall"));
}

#[test]
fn nobody_can_operate_a_merchant_stall() {
    let (mut g, _) = game_with_stall();
    for bad in [
        r#"[{"price":{"stall":1,"good":0,"price":1}}]"#,
        r#"[{"buy":{"stall":1,"good":0,"qty":1,"max_cost":100}}]"#,
        r#"[{"list":{"stall":1,"price":1}}]"#,
        r#"[{"transfer":{"stall":1,"to":"me.testnet"}}]"#,
        r#"[{"collect":{"stall":1}}]"#,
    ] {
        assert!(g.refused(&me(), bad).contains("not your stall"), "{bad}");
    }
}

#[test]
fn selling_back_stock_you_do_not_have_is_refused() {
    let (mut g, id) = game_with_stall();
    let e = g.refused(&me(), &format!(r#"[{{"sell_back":{{"stall":{id},"good":0,"qty":1,"min_pay":0}}}}]"#));
    assert!(e.contains("does not hold"));
}

#[test]
fn sell_back_respects_its_minimum() {
    let (mut g, id) = game_with_stall();
    g.ok(&me(), &format!(r#"[{{"buy":{{"stall":{id},"good":0,"qty":2,"max_cost":100000}}}}]"#));
    let e = g.refused(&me(), &format!(r#"[{{"sell_back":{{"stall":{id},"good":0,"qty":2,"min_pay":100000}}}}]"#));
    assert!(e.contains("less than your limit"));
}

#[test]
fn buy_and_sell_back_loops_always_lose() {
    let (mut g, id) = game_with_stall();
    let mut money = g.stall(id).money;
    for _ in 0..20 {
        g.ok(&me(), &format!(r#"[{{"buy":{{"stall":{id},"good":1,"qty":1,"max_cost":100000}}}},{{"sell_back":{{"stall":{id},"good":1,"qty":1,"min_pay":0}}}}]"#));
        let now = g.stall(id).money;
        assert!(now < money);
        money = now;
    }
    g.assert_conserved();
}

#[test]
fn an_empty_stall_gets_no_sales_and_breaks_nothing() {
    let (mut g, id) = game_with_stall();
    g.ok(&me(), &format!(r#"[{{"price":{{"stall":{id},"good":0,"price":1}}}},{{"move":{{"stall":{id},"spot":14,"max_fee":100000}}}}]"#));
    g.nights(5);
    let s = g.stall(id);
    assert_eq!(s.customers, 0);
    assert_eq!(s.stock, [0; GOODS]);
    g.assert_conserved();
}

#[test]
fn prices_above_the_limit_are_refused() {
    let (mut g, id) = game_with_stall();
    let e = g.refused(&me(), &format!(r#"[{{"price":{{"stall":{id},"good":0,"price":{}}}}}]"#, FAIR[0] * MAX_PRICE_FACTOR + 1));
    assert!(e.contains("limit"));
    let e = g.refused(&me(), &format!(r#"[{{"price":{{"stall":{id},"good":0,"price":{}}}}}]"#, u32::MAX));
    assert!(e.contains("limit"));
}

#[test]
fn a_price_of_one_is_allowed_and_loses_money_only_for_its_owner() {
    let (mut g, id) = game_with_stall();
    g.ok(&me(), &format!(r#"[{{"buy":{{"stall":{id},"good":3,"qty":3,"max_cost":100000}}}},{{"price":{{"stall":{id},"good":3,"price":1}}}}]"#));
    g.nights(10);
    g.assert_conserved();
}

#[test]
fn fees_and_size_costs_respect_their_limits() {
    let (mut g, id) = game_with_stall();
    let e = g.refused(&me(), &format!(r#"[{{"move":{{"stall":{id},"spot":0,"max_fee":0}}}}]"#));
    assert!(e.contains("above your limit"));
    let e = g.refused(&me(), &format!(r#"[{{"upgrade":{{"stall":{id},"max_cost":0}}}}]"#));
    assert!(e.contains("above your limit"));
    let e = g.refused(&me(), &format!(r#"[{{"move":{{"stall":{id},"spot":24,"max_fee":0}}}}]"#));
    assert!(e.contains("no such spot"));
    let e = g.refused(&me(), &format!(r#"[{{"move":{{"stall":{id},"spot":255,"max_fee":0}}}}]"#));
    assert!(e.contains("no such spot"));
    let e = g.refused(&me(), &format!(r#"[{{"move":{{"stall":{id},"spot":23,"max_fee":0}}}}]"#));
    assert!(e.contains("already there"));
    let e = g.refused(&me(), &format!(r#"[{{"move":{{"stall":{id},"spot":0,"max_fee":999999999}}}}]"#));
    assert!(e.contains("not enough money"));
}

#[test]
fn bad_names_are_refused() {
    let mut g = Game::new();
    for bad in ["", "   ", "<script>", "a&b", "too long a name for one stall sign", "quote\\\"d", "naïve", "tab\\tname"] {
        let e = g.refused(&me(), &format!(r#"[{{"found":{{"name":"{bad}"}}}}]"#));
        assert!(e.contains("a name is"), "{bad}: {e}");
    }
    let id = g.found(&me(), "Ok-Name 9");
    let e = g.refused(&me(), &format!(r#"[{{"rename":{{"stall":{id},"name":"<b>"}}}}]"#));
    assert!(e.contains("a name is"));
    assert_eq!(g.stall(id).name, "Ok-Name 9");
}

#[test]
fn foundings_per_night_are_capped() {
    let mut g = Game::new();
    for i in 0..MAX_FOUNDINGS_PER_NIGHT {
        g.found(&acc(&format!("p{i}.testnet")), "Ok");
    }
    let who = acc("late.testnet");
    let e = g.refused(&who, r#"[{"found":{"name":"Late"}}]"#);
    assert!(e.contains("next night"), "{e}");
    assert_eq!(g.world().licences_tonight, 0);
    g.next_night();
    g.found(&who, "Late");
    g.assert_conserved();
}

#[test]
fn the_number_of_stalls_is_capped_and_the_treasury_cannot_be_drained_by_grants() {
    let mut g = Game::new();
    let mut made = 0;
    for i in 0..MAX_PLAYER_STALLS {
        if i > 0 && i % MAX_FOUNDINGS_PER_NIGHT == 0 {
            g.next_night();
        }
        g.found(&acc(&format!("p{i}.testnet")), "Sybil");
        made += 1;
    }
    assert_eq!(made, MAX_PLAYER_STALLS);
    g.next_night();
    let e = g.refused(&acc("one-too-many.testnet"), r#"[{"found":{"name":"No"}}]"#);
    assert!(e.contains("no more stall licences"), "{e}");
    assert_eq!(g.world().licences_left, 0);
    let a = g.audit();
    assert_eq!(a.grants_paid, STARTER_GRANT * MAX_PLAYER_STALLS as u64);
    assert!(a.treasury >= GRANT_TREASURY_FLOOR);
    assert_eq!(a.total, FOUNDING_MONEY);
}

#[test]
fn the_grant_budget_always_leaves_the_wage_reserve() {
    assert!(treasury_founding() >= STARTER_GRANT * MAX_PLAYER_STALLS as u64 + GRANT_TREASURY_FLOOR);
}

#[test]
fn the_account_register_is_capped() {
    let mut g = Game::new();
    let id = g.found(&acc("root.testnet"), "Hopper");
    let mut from = acc("root.testnet");
    // Each hop registers a new account, on the contract's storage. The cap stops that.
    let mut stopped = false;
    for i in 0..MAX_ACCOUNTS + 5 {
        let to = acc(&format!("h{i}.testnet"));
        let out = g.play(&from, &format!(r#"[{{"transfer":{{"stall":{id},"to":"{to}"}}}}]"#));
        match out.error {
            None => from = to,
            Some(e) => {
                assert!(e.contains("register is full"), "{e}");
                stopped = true;
                break;
            }
        }
    }
    assert!(stopped, "the register never filled");
    // Accounts already on the register can still receive, and new ones can no longer found.
    let e = g.refused(&acc("new-face.testnet"), r#"[{"found":{"name":"No"}}]"#);
    assert!(e.contains("register is full"), "{e}");
    g.assert_conserved();
}

#[test]
fn sybil_stalls_cannot_funnel_their_grants_to_one_stall() {
    let mut g = Game::new();
    let target = g.found(&acc("main.testnet"), "Main");
    g.ok(&acc("main.testnet"), &format!(r#"[{{"list":{{"stall":{target},"price":{STARTER_GRANT}}}}}]"#));
    let mut paid = 0;
    for i in 0..MAX_FOUNDINGS_PER_NIGHT - 1 {
        let who = acc(&format!("sybil{i}.testnet"));
        let id = g.found(&who, "Sybil");
        let out = g.play(&who, &format!(
            r#"[{{"buy_stall":{{"with":{id},"target":{target},"max_price":{STARTER_GRANT},"min_money":0}}}}]"#
        ));
        if out.error.is_none() {
            paid += 1;
        }
    }
    assert_eq!(paid, 0);
    assert_eq!(g.purse(&acc("main.testnet")), 0);
}

#[test]
fn a_spot_war_only_feeds_the_treasury() {
    let mut g = Game::new();
    let a = acc("a.testnet");
    let b = acc("b.testnet");
    let sa = g.found(&a, "A");
    let sb = g.found(&b, "B");
    let treasury = g.audit().treasury;
    let money = g.stall(sa).money + g.stall(sb).money;
    g.ok(&a, &format!(r#"[{{"move":{{"stall":{sa},"spot":22,"max_fee":100000}}}}]"#));
    g.nights(MOVE_COOLDOWN_NIGHTS);
    let rent_a = g.stall(sa).rent_paid;
    let rent_b = g.stall(sb).rent_paid;
    let spent = money - (g.stall(sa).money + g.stall(sb).money) - rent_a - rent_b;
    assert_eq!(spent, spot_fee(22) * DISPLACE_FACTOR);
    assert!(g.audit().treasury > treasury);
    g.assert_conserved();
}

#[test]
fn the_money_floor_holds_on_every_stall_after_a_rough_night() {
    let (mut g, id) = game_with_stall();
    g.ok(&me(), &format!(r#"[{{"buy":{{"stall":{id},"good":3,"qty":3,"max_cost":100000}}}}]"#));
    g.next_night();
    // Spending below the floor is the owner's choice; rent alone never goes below it.
    let m = g.stall(id).money;
    g.next_night();
    assert!(g.stall(id).money >= m.min(RENT_FLOOR));
}

#[test]
fn view_numbers_stay_inside_the_javascript_safe_range() {
    let (mut g, _) = game_with_stall();
    g.nights(5);
    let w = g.world();
    let limit = MAX_NONCE;
    assert!(w.treasury < limit && w.dock_money < limit);
    assert!(FOUNDING_MONEY < limit);
}

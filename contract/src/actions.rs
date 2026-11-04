//! What players can do. Every action checks everything first and changes state only after all
//! checks passed, so a refused action leaves no trace.

use crate::config::*;
use crate::market::*;
use crate::types::*;
use crate::LanternRow;
use near_contract_standards::non_fungible_token::events::{NftMint, NftTransfer};
use near_sdk::{AccountId, env};

type Applied = Result<Option<u32>, String>;

fn err<T>(msg: &str) -> Result<T, String> {
    Err(msg.to_string())
}

pub(crate) fn clean_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    let ok = |c: char| c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '\'';
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS || !name.chars().all(ok) {
        return err("a name is 1 to 24 letters, digits, spaces, hyphens or apostrophes");
    }
    Ok(name.to_string())
}

impl LanternRow {
    pub(crate) fn apply_action(&mut self, actor: &AccountId, action: Action) -> Applied {
        match action {
            Action::Found { name } => self.do_found(actor, &name),
            Action::Buy { stall, good, qty, max_cost } => self.do_buy(actor, stall, good, qty, max_cost),
            Action::SellBack { stall, good, qty, min_pay } => self.do_sell_back(actor, stall, good, qty, min_pay),
            Action::Price { stall, good, price } => self.do_price(actor, stall, good, price),
            Action::Move { stall, spot, max_fee } => self.do_move(actor, stall, spot, max_fee),
            Action::Upgrade { stall, max_cost } => self.do_upgrade(actor, stall, max_cost),
            Action::Rename { stall, name } => self.do_rename(actor, stall, &name),
            Action::List { stall, price } => self.do_list(actor, stall, price),
            Action::Unlist { stall } => self.do_unlist(actor, stall),
            Action::BuyStall { with, target, max_price, min_money } => {
                self.do_buy_stall(actor, with, target, max_price, min_money)
            }
            Action::Collect { stall } => self.do_collect(actor, stall),
            Action::Transfer { stall, to } => self.do_transfer(actor, stall, &to),
        }
    }

    fn check_owner(&self, actor: &AccountId, id: u32) -> Result<(), String> {
        match self.deeds.get(&id) {
            None => err("no such stall"),
            Some(d) if &d.owner != actor => err("not your stall"),
            Some(_) => Ok(()),
        }
    }

    pub(crate) fn listing_price(&self, id: u32) -> Option<u64> {
        self.listings.iter().find(|l| l.0 == id).map(|l| l.1)
    }

    /// A stall listed for sale can still sell to villagers, but its owner cannot strip it.
    fn check_not_listed(&self, id: u32) -> Result<(), String> {
        if self.listing_price(id).is_some() { err("unlist the stall first") } else { Ok(()) }
    }

    fn stall_ref(&self, id: u32) -> &Stall {
        self.stalls.get(&id).unwrap_or_else(|| env::panic_str("stall record missing"))
    }

    fn stall_mut(&mut self, id: u32) -> &mut Stall {
        self.stalls.get_mut(&id).unwrap_or_else(|| env::panic_str("stall record missing"))
    }

    fn touch(&mut self, id: u32) {
        let night = self.night;
        self.stall_mut(id).last_action = night;
    }

    fn do_found(&mut self, actor: &AccountId, raw: &str) -> Applied {
        let name = clean_name(raw)?;
        if self.minted - MERCHANTS >= MAX_PLAYER_STALLS {
            return err("the row has no more stall licences");
        }
        if self.foundings_tonight >= MAX_FOUNDINGS_PER_NIGHT {
            return err("the town grants a few licences per night, try next night");
        }
        let known = self.players.get(actor).cloned();
        if known.is_none() && self.accounts.len() >= MAX_ACCOUNTS {
            return err("the town register is full");
        }
        let mut record = known.clone().unwrap_or_default();
        if record.tokens.len() >= MAX_TOKENS_PER_ACCOUNT {
            return err("this account holds too many stalls");
        }
        // One starter grant per account. Further stalls of the same account start with nothing.
        let grant = if record.founded { 0 } else { STARTER_GRANT };
        if grant > 0 && self.treasury < GRANT_TREASURY_FLOOR + grant {
            return err("the Treasury is too low to fund a new stall");
        }

        self.minted += 1;
        let id = self.minted;
        self.foundings_tonight += 1;
        self.treasury -= grant;
        self.grants_paid += grant;
        let spot = self.worst_free_spot();
        if spot != NO_SPOT {
            self.row[spot as usize] = id;
        }
        self.stalls.insert(
            id,
            Stall {
                money: grant,
                stock: [0; GOODS],
                price: [0; GOODS],
                rep: REP_START_PLAYER,
                tier: 0,
                spot,
                last_action: self.night,
                moved_at: 0,
                rent_at: self.night,
                sold_last: [0; GOODS],
                notes: [NOTE_HOLD; GOODS],
                revenue: 0,
                earned: 0,
                customers: 0,
                rent_paid: 0,
                relief_at: 0,
            },
        );
        self.deeds.insert(
            id,
            Deed {
                owner: actor.clone(),
                founder: actor.clone(),
                name,
                minted_night: self.night,
                holders: Vec::new(),
                approvals: Vec::new(),
                next_approval_id: 0,
            },
        );
        record.founded = true;
        record.tokens.push(id);
        self.players.insert(actor.clone(), record);
        if known.is_none() {
            self.accounts.push(actor.clone());
        }
        let token = id.to_string();
        NftMint { owner_id: actor, token_ids: &[token.as_str()], memo: None }.emit();
        Ok(Some(id))
    }

    pub(crate) fn worst_free_spot(&self) -> u8 {
        (0..ROW_SPOTS).rev().find(|&s| self.row[s] == 0).map_or(NO_SPOT, |s| s as u8)
    }

    fn do_buy(&mut self, actor: &AccountId, id: u32, good: u8, qty: u32, max_cost: u64) -> Applied {
        self.check_owner(actor, id)?;
        self.check_not_listed(id)?;
        let g = check_good(good)?;
        if qty == 0 {
            return err("quantity must be positive");
        }
        let dock = self.dock[g];
        if qty > dock.left {
            return err("the Dock does not have that many tonight");
        }
        let s = self.stall_ref(id);
        let held: u64 = s.stock.iter().map(|&x| x as u64).sum();
        if held + qty as u64 > TIER_CAPACITY[s.tier as usize] as u64 {
            return err("the stall cannot hold that much");
        }
        let cost = dock_cost(g, dock.heat, qty, dock_price_factor(self.event_now, g));
        if cost > max_cost {
            return err("the Dock's price is above your limit");
        }
        if cost > s.money {
            return err("not enough money");
        }
        let s = self.stall_mut(id);
        s.money -= cost;
        s.stock[g] += qty;
        self.dock_money += cost;
        self.dock[g].heat += qty;
        self.dock[g].left -= qty;
        self.touch(id);
        Ok(None)
    }

    fn do_sell_back(&mut self, actor: &AccountId, id: u32, good: u8, qty: u32, min_pay: u64) -> Applied {
        self.check_owner(actor, id)?;
        self.check_not_listed(id)?;
        let g = check_good(good)?;
        if qty == 0 {
            return err("quantity must be positive");
        }
        if self.stall_ref(id).stock[g] < qty {
            return err("the stall does not hold that much");
        }
        let unit = dock_marginal(g, self.dock[g].heat, dock_price_factor(self.event_now, g)) as u64;
        let pay = unit * SELL_BACK_PCT as u64 / 100 * qty as u64;
        if pay < min_pay {
            return err("the Dock pays less than your limit");
        }
        if pay > self.dock_money {
            return err("the Dock cannot pay that much tonight");
        }
        let s = self.stall_mut(id);
        s.stock[g] -= qty;
        s.money += pay;
        self.dock_money -= pay;
        let d = &mut self.dock[g];
        d.heat = d.heat.saturating_sub(qty);
        d.left = d.left.saturating_add(qty);
        self.touch(id);
        Ok(None)
    }

    fn do_price(&mut self, actor: &AccountId, id: u32, good: u8, price: u32) -> Applied {
        self.check_owner(actor, id)?;
        let g = check_good(good)?;
        if price > FAIR[g] * MAX_PRICE_FACTOR {
            return err("price above the town's limit");
        }
        self.stall_mut(id).price[g] = price;
        self.touch(id);
        Ok(None)
    }

    fn do_move(&mut self, actor: &AccountId, id: u32, spot: u8, max_fee: u64) -> Applied {
        self.check_owner(actor, id)?;
        self.check_not_listed(id)?;
        if spot as usize >= ROW_SPOTS {
            return err("no such spot");
        }
        let night = self.night;
        let s = self.stall_ref(id);
        let old = s.spot;
        if old == spot {
            return err("already there");
        }
        if cooling_down(s.moved_at, night) {
            return err("this stall moved too recently");
        }
        let occupant = self.row[spot as usize];
        let fee = if occupant != 0 {
            if cooling_down(self.stall_ref(occupant).moved_at, night) {
                return err("that stall has only just settled there");
            }
            if occupant <= MERCHANTS && old == NO_SPOT && self.worst_free_spot() == NO_SPOT {
                return err("the row is full and that merchant has nowhere to go");
            }
            spot_fee(spot) * DISPLACE_FACTOR
        } else if old != NO_SPOT && spot > old {
            0
        } else {
            spot_fee(spot)
        };
        if fee > max_fee {
            return err("the fee is above your limit");
        }
        // Coming in from outside the row pays the accrued wealth rent first.
        let accrued = if old == NO_SPOT { self.accrued_rent(id) } else { 0 };
        if fee + accrued > self.stall_ref(id).money {
            return err("not enough money");
        }
        self.settle_accrued(id, accrued);
        let s = self.stall_mut(id);
        s.money -= fee;
        s.spot = spot;
        s.moved_at = night;
        s.rent_at = night;
        self.treasury += fee;
        if old != NO_SPOT {
            self.row[old as usize] = 0;
        }
        self.row[spot as usize] = id;
        if occupant != 0 {
            // The displaced stall takes the mover's old spot, or else the worst free one.
            let dest = if old != NO_SPOT { old } else { self.worst_free_spot() };
            if dest != NO_SPOT {
                self.row[dest as usize] = occupant;
            }
            let o = self.stall_mut(occupant);
            o.spot = dest;
            o.moved_at = night;
            o.rent_at = night;
        }
        self.touch(id);
        Ok(None)
    }

    pub(crate) fn accrued_rent(&self, id: u32) -> u64 {
        let s = self.stall_ref(id);
        if s.spot != NO_SPOT {
            return 0;
        }
        let over = s.money.saturating_sub(RENT_FLOOR);
        let nights = self.night.saturating_sub(s.rent_at) as u64;
        over * (nights * WEALTH_RENT_BP).min(10_000) / 10_000
    }

    pub(crate) fn settle_accrued(&mut self, id: u32, accrued: u64) {
        let night = self.night;
        let s = self.stall_mut(id);
        s.money -= accrued;
        s.rent_paid += accrued;
        s.rent_at = night;
        self.treasury += accrued;
    }

    fn do_upgrade(&mut self, actor: &AccountId, id: u32, max_cost: u64) -> Applied {
        self.check_owner(actor, id)?;
        self.check_not_listed(id)?;
        let s = self.stall_ref(id);
        let tier = s.tier as usize;
        if tier + 1 >= TIERS {
            return err("the stall is as big as they get");
        }
        let cost = TIER_COST[tier + 1];
        if cost > max_cost {
            return err("the cost is above your limit");
        }
        if cost > s.money {
            return err("not enough money");
        }
        let s = self.stall_mut(id);
        s.money -= cost;
        s.tier += 1;
        self.treasury += cost;
        self.touch(id);
        Ok(None)
    }

    fn do_rename(&mut self, actor: &AccountId, id: u32, raw: &str) -> Applied {
        self.check_owner(actor, id)?;
        let name = clean_name(raw)?;
        let d = self.deeds.get_mut(&id).unwrap_or_else(|| env::panic_str("deed missing"));
        d.name = name;
        self.touch(id);
        Ok(None)
    }

    fn do_list(&mut self, actor: &AccountId, id: u32, price: u64) -> Applied {
        self.check_owner(actor, id)?;
        if price == 0 || price > FOUNDING_MONEY {
            return err("the asking price must be between 1 and all the coin in town");
        }
        if let Some(l) = self.listings.iter_mut().find(|l| l.0 == id) {
            l.1 = price;
        } else if self.listings.len() >= MAX_LISTINGS {
            return err("the listing board is full");
        } else {
            self.listings.push((id, price));
        }
        self.touch(id);
        Ok(None)
    }

    fn do_unlist(&mut self, actor: &AccountId, id: u32) -> Applied {
        self.check_owner(actor, id)?;
        if self.listing_price(id).is_none() {
            return err("the stall is not listed");
        }
        self.listings.retain(|l| l.0 != id);
        self.touch(id);
        Ok(None)
    }

    /// One stall buys another: it pays out of what it has earned, the buyer's account gets the token
    /// with everything in it, the tax goes to the Treasury, and the founder's royalty and the seller's
    /// proceeds go to their purses (the sold stall cannot hold them, it now belongs to the buyer).
    fn do_buy_stall(&mut self, actor: &AccountId, with: u32, target: u32, max_price: u64, min_money: u64) -> Applied {
        self.check_owner(actor, with)?;
        self.check_not_listed(with)?;
        if with == target {
            return err("a stall cannot buy itself");
        }
        let Some(price) = self.listing_price(target) else {
            return err("that stall is not for sale");
        };
        if price > max_price {
            return err("the asking price is above your limit");
        }
        let deed = self.deeds.get(&target).cloned().unwrap_or_else(|| env::panic_str("deed missing"));
        if &deed.owner == actor {
            return err("that stall is already yours");
        }
        if self.stall_ref(target).money < min_money {
            return err("that stall holds less money than your limit");
        }
        let payer = self.stall_ref(with);
        if payer.money < price {
            return err("not enough money");
        }
        if payer.earned < price {
            return err("only coin the stall has earned can buy a stall, not its starter grant");
        }

        // Moving the token is the last check that can refuse; nothing has changed before it.
        self.move_token(target, actor)?;
        let tax = sales_tax(price);
        let royal = royalty(price);
        let proceeds = price - tax - royal;
        let payer = self.stall_mut(with);
        payer.money -= price;
        payer.earned -= price;
        self.treasury += tax;
        self.pay_purse(&deed.founder, royal);
        self.pay_purse(&deed.owner, proceeds);
        self.touch(with);
        let token = target.to_string();
        NftTransfer {
            old_owner_id: &deed.owner,
            new_owner_id: actor,
            token_ids: &[token.as_str()],
            authorized_id: None,
            memo: Some("sold on the row"),
        }
        .emit();
        Ok(None)
    }

    fn pay_purse(&mut self, account: &AccountId, amount: u64) {
        let p = self.players.get_mut(account).unwrap_or_else(|| env::panic_str("player record missing"));
        p.purse += amount;
    }

    fn do_collect(&mut self, actor: &AccountId, id: u32) -> Applied {
        self.check_owner(actor, id)?;
        let p = self.players.get_mut(actor).unwrap_or_else(|| env::panic_str("player record missing"));
        if p.purse == 0 {
            return err("the purse is empty");
        }
        let amount = p.purse;
        p.purse = 0;
        let s = self.stall_mut(id);
        s.money += amount;
        s.earned += amount;
        self.touch(id);
        Ok(None)
    }

    fn do_transfer(&mut self, actor: &AccountId, id: u32, to: &AccountId) -> Applied {
        self.check_owner(actor, id)?;
        if to == actor {
            return err("the stall already belongs to that account");
        }
        self.move_token(id, to)?;
        let token = id.to_string();
        NftTransfer {
            old_owner_id: actor,
            new_owner_id: to,
            token_ids: &[token.as_str()],
            authorized_id: None,
            memo: None,
        }
        .emit();
        Ok(None)
    }
}

/// `moved_at` is 0 for a stall that has never moved.
fn cooling_down(moved_at: u32, night: u32) -> bool {
    moved_at != 0 && night < moved_at + MOVE_COOLDOWN_NIGHTS
}

fn check_good(good: u8) -> Result<usize, String> {
    if (good as usize) < GOODS { Ok(good as usize) } else { err("no such good") }
}

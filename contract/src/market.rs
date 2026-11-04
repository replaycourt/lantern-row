//! Pure pricing rules. Nothing here touches the chain, so these formulas can be read and tested alone.

use crate::config::*;
use crate::types::Event;

/// Cost of `qty` units at the Dock: the price climbs with each unit, so one big order costs the
/// same as many small ones (rounding only ever favours the Dock).
pub fn dock_cost(good: usize, heat: u32, qty: u32, factor_pct: u32) -> u64 {
    let (q, h, s) = (qty as u128, heat as u128, HEAT_SLOPE[good] as u128);
    let area = q * s + h * q + q * q.saturating_sub(1) / 2;
    let num = DOCK_BASE[good] as u128 * factor_pct as u128 * area;
    let den = s * 100;
    u64::try_from(num.div_ceil(den)).unwrap_or(u64::MAX)
}

pub fn dock_marginal(good: usize, heat: u32, factor_pct: u32) -> u32 {
    u32::try_from(dock_cost(good, heat, 1, factor_pct)).unwrap_or(u32::MAX)
}

pub fn dock_price_factor(event: Event, good: usize) -> u32 {
    match event {
        Event::Storm { good: g } if g as usize == good => STORM_PRICE_PCT,
        Event::Bumper { good: g } if g as usize == good => BUMPER_PRICE_PCT,
        _ => 100,
    }
}

pub fn dock_night_supply(event: Event, good: usize) -> u32 {
    let base = DOCK_SUPPLY[good];
    match event {
        Event::Storm { good: g } if g as usize == good => (base * STORM_SUPPLY_PCT / 100).max(1),
        Event::Bumper { good: g } if g as usize == good => base * BUMPER_SUPPLY_PCT / 100,
        _ => base,
    }
}

/// Nights between purchases: a villager who loves a good wants it sooner.
pub fn need_period(good: usize, taste: u32) -> u32 {
    if taste == 0 {
        return u32::MAX;
    }
    (NEED_PERIOD[good] * 100 / taste).max(1)
}

/// How much richer or poorer a villager feels, in percent: 100 at five nights of wage saved.
pub fn wealth_pct(wallet: u64, wage: u64) -> u64 {
    (60 + wallet.saturating_mul(40) / (5 * wage.max(1))).min(150)
}

/// A villager with money to spare wants things sooner: this many nights off every need.
pub fn spare_money_nights(wealth: u64) -> u32 {
    (wealth.saturating_sub(100) / 25) as u32
}

/// The most a villager pays for a good tonight, before stall reputation and memory.
pub fn willingness_to_pay(good: usize, taste: u32, over: u32, wealth: u64, event: Event) -> u64 {
    let event_pct = match event {
        Event::Festival { good: g } if g as usize == good => FESTIVAL_WTP_PCT,
        Event::Payday => PAYDAY_WTP_PCT,
        _ => 100,
    };
    let unmet = 100 + UNMET_PREMIUM_PCT * over.min(UNMET_PREMIUM_MAX_NIGHTS) as u64;
    FAIR[good] as u64 * taste as u64 * unmet * wealth * event_pct / 100_000_000
}

/// Willingness to pay at one particular stall.
pub fn stall_wtp(wtp: u64, rep: u16, memory: u8) -> u64 {
    wtp * (100 + rep as u64 / 50 + memory as u64) / 100
}

pub fn sales_tax(price: u64) -> u64 {
    (price * SALES_TAX_PCT).div_ceil(100)
}

pub fn royalty(price: u64) -> u64 {
    price * ROYALTY_PCT / 100
}

/// Rent due for one night: never reaches into the last `RENT_FLOOR` coins.
pub fn rent_due(money: u64, spot: u8) -> u64 {
    let over = money.saturating_sub(RENT_FLOOR);
    (spot_rent(spot) + over * WEALTH_RENT_BP / 10_000).min(over)
}

/// Wage share paid at a given Treasury balance.
pub fn wage_pct(treasury: u64) -> u64 {
    (treasury.saturating_mul(100) / WAGE_FULL_TREASURY).clamp(WAGE_MIN_PCT, 100)
}

/// Net worth: money, stock at the base wholesale price, and half of what size and spot cost.
pub fn net_worth(money: u64, stock: &[u32; GOODS], tier: u8, spot: u8) -> u64 {
    let goods: u64 = (0..GOODS).map(|g| stock[g] as u64 * DOCK_BASE[g] as u64).sum();
    money + goods + TIER_WORTH[tier as usize] + spot_fee(spot) / 2
}

/// Deterministic random numbers for one night, seeded from the block's random seed.
pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    pub fn below(&mut self, n: u32) -> u32 {
        (self.next() % n as u64) as u32
    }
}

pub fn roll_event(rng: &mut Rng) -> Event {
    let good = rng.below(GOODS as u32) as u8;
    let roll = rng.below(100);
    let [f, s, b, p] = EVENT_ODDS;
    if roll < f {
        Event::Festival { good }
    } else if roll < f + s {
        Event::Storm { good }
    } else if roll < f + s + b {
        Event::Bumper { good }
    } else if roll < f + s + b + p {
        Event::Payday
    } else {
        Event::Quiet
    }
}

//! What happens when a night ends: wages, the villagers' walk, rent, spoilage, the NPC merchants,
//! then the next night's Dock and event. The row is loaded once and saved once per call, so a
//! catch-up costs little more than one night.

use crate::config::*;
use crate::market::*;
use crate::types::*;
use crate::LanternRow;
use near_sdk::env;

/// A stall on the row while nights are being processed.
struct RowEntry {
    id: u32,
    npc: bool,
    stall: Stall,
    served: u32,
    sold: [u16; GOODS],
    refused: [u16; GOODS],
}

impl LanternRow {
    pub(crate) fn run_nights(&mut self, run: u32) {
        let mut row: Vec<RowEntry> = Vec::with_capacity(ROW_SPOTS);
        for spot in 0..ROW_SPOTS {
            let id = self.row[spot];
            if id != 0 {
                let stall = self.stalls.get(&id).cloned().unwrap_or_else(|| env::panic_str("stall missing"));
                row.push(RowEntry { id, npc: id <= MERCHANTS, stall, served: 0, sold: [0; GOODS], refused: [0; GOODS] });
            }
        }
        for _ in 0..run {
            let mut rng = Rng(self.night_seed());
            let log = self.process_night(&mut row, &mut rng);
            self.logs.insert(log.night % LOG_KEEP, log);
        }
        for e in row {
            self.stalls.insert(e.id, e.stall);
        }
        self.sweep_alley();
    }

    fn process_night(&mut self, row: &mut [RowEntry], rng: &mut Rng) -> NightLog {
        let mut log = NightLog {
            night: self.night,
            event: self.event_now,
            wages: 0,
            tax: 0,
            rent: 0,
            dues: 0,
            relief: 0,
            sales: Vec::new(),
            refusals: Vec::new(),
            missed: Vec::new(),
            restocks: Vec::new(),
            spoiled: Vec::new(),
            evicted: Vec::new(),
        };
        self.pay_wages(&mut log);
        self.walk_villagers(row, rng, &mut log);
        self.close_stalls(row, rng, &mut log);
        self.pay_dock_dues(&mut log);
        self.run_merchants(row, rng, &mut log);
        for e in row.iter_mut() {
            e.stall.sold_last = e.sold;
            e.sold = [0; GOODS];
            e.refused = [0; GOODS];
            e.served = 0;
        }
        self.turn_the_night(rng);
        log
    }

    fn pay_wages(&mut self, log: &mut NightLog) {
        let pct = wage_pct(self.treasury);
        let payday = if self.event_now == Event::Payday { PAYDAY_WAGE_PCT } else { 100 };
        for (v, cfg) in self.villagers.iter_mut().zip(VILLAGER_TABLE.iter()) {
            let cap = cfg.wage * WALLET_CAP_NIGHTS;
            let due = (cfg.wage * pct / 100 * payday / 100).min(cap.saturating_sub(v.wallet)).min(self.treasury);
            v.wallet += due;
            self.treasury -= due;
            log.wages += due;
        }
    }

    fn walk_villagers(&mut self, row: &mut [RowEntry], rng: &mut Rng, log: &mut NightLog) {
        let mut order: [u8; VILLAGERS] = core::array::from_fn(|i| i as u8);
        for i in (1..VILLAGERS).rev() {
            order.swap(i, rng.below(i as u32 + 1) as usize);
        }
        for &vi in order.iter() {
            self.walk_one(vi, row, rng, log);
        }
    }

    fn walk_one(&mut self, vi: u8, row: &mut [RowEntry], rng: &mut Rng, log: &mut NightLog) {
        let cfg = &VILLAGER_TABLE[vi as usize];
        let event = self.event_now;
        let mut v = self.villagers[vi as usize].clone();
        let wealth = wealth_pct(v.wallet, cfg.wage);

        // What this villager wants tonight, most overdue first.
        let mut wants: Vec<(u32, usize)> = Vec::with_capacity(GOODS);
        for g in 0..GOODS {
            if cfg.taste[g] == 0 {
                continue;
            }
            let period = need_period(g, cfg.taste[g]);
            let mut unmet = v.unmet[g] as u32 + spare_money_nights(wealth);
            if matches!(event, Event::Festival { good } if good as usize == g) {
                unmet = unmet.max(period) + FESTIVAL_EXTRA_UNMET;
            }
            if unmet >= period {
                wants.push((unmet - period, g));
            }
        }
        wants.sort_by(|a, b| b.0.cmp(&a.0));
        wants.truncate(MAX_WANTS);

        // The stalls on this villager's walk. Empty spots do not count against the cap, and a
        // remembered stall is worth a longer walk, though even a regular does not always come.
        let mut walk: Vec<usize> = Vec::with_capacity(VISIT_CAP + MEMORY_SLOTS);
        let mut strolled = 0;
        for (i, e) in row.iter().enumerate() {
            if e.stall.spot == NO_SPOT {
                continue;
            }
            let roll = rng.below(100);
            let remembered = v.memory.iter().any(|m| m.0 == e.id && m.1 > 0);
            if remembered {
                if roll < footfall(e.stall.spot) + REMEMBERED_FOOTFALL_BONUS {
                    walk.push(i);
                }
            } else if strolled < VISIT_CAP && roll < footfall(e.stall.spot) {
                walk.push(i);
                strolled += 1;
            }
        }

        let mut bought = [false; GOODS];
        let mut served_ids: [u32; MEMORY_SLOTS] = [0; MEMORY_SLOTS];
        for &(over, g) in wants.iter() {
            let wtp = willingness_to_pay(g, cfg.taste[g], over, wealth, event);
            let units = if matches!(event, Event::Festival { good } if good as usize == g) { FESTIVAL_UNITS } else { 1 };
            for unit in 0..units {
                let mut best: Option<(usize, u64)> = None;
                let mut too_dear: Option<(usize, u32)> = None;
                for &i in walk.iter() {
                    let e = &row[i];
                    let price = e.stall.price[g];
                    if e.stall.stock[g] == 0 || price == 0 || e.served >= TIER_SERVICE[e.stall.tier as usize] {
                        continue;
                    }
                    let mem = v.memory.iter().find(|m| m.0 == e.id).map_or(0, |m| m.1);
                    let eff = stall_wtp(wtp, e.stall.rep, mem);
                    if price as u64 <= eff && price as u64 <= v.wallet {
                        let surplus = eff - price as u64;
                        if best.is_none_or(|b| surplus > b.1) {
                            best = Some((i, surplus));
                        }
                    } else if too_dear.is_none_or(|t| price < t.1) {
                        too_dear = Some((i, price));
                    }
                }
                // The cheapest stall that still asked too much hears about it, even if the villager
                // then bought elsewhere. One unit of each want is enough to make the point.
                if unit == 0 {
                    if let Some((i, _)) = too_dear {
                        let e = &mut row[i];
                        e.stall.rep = e.stall.rep.saturating_sub(REP_PER_REFUSAL);
                        e.refused[g] = e.refused[g].saturating_add(1);
                        log.refusals.push((vi, e.id, g as u8));
                    } else if best.is_none() {
                        log.missed.push((vi, g as u8));
                    }
                }
                let Some((i, _)) = best else {
                    break;
                };
                let e = &mut row[i];
                let price = e.stall.price[g] as u64;
                let tax = sales_tax(price);
                v.wallet -= price;
                self.treasury += tax;
                log.tax += tax;
                e.stall.money += price - tax;
                e.stall.earned += price - tax;
                e.stall.stock[g] -= 1;
                e.stall.revenue += price;
                e.stall.customers += 1;
                e.stall.rep = (e.stall.rep + REP_PER_SALE).min(REP_MAX);
                e.served += 1;
                e.sold[g] = e.sold[g].saturating_add(1);
                bought[g] = true;
                log.sales.push((vi, e.id, g as u8, price as u32));
                remember(&mut v, e.id);
                if let Some(slot) = served_ids.iter_mut().find(|x| **x == 0 || **x == e.id) {
                    *slot = e.id;
                }
            }
        }

        for g in 0..GOODS {
            v.unmet[g] = if bought[g] { 0 } else { v.unmet[g].saturating_add(1).min(UNMET_CAP) };
        }
        // Stalls that did not serve this villager fade from memory.
        for m in v.memory.iter_mut() {
            if m.1 > 0 && !served_ids.contains(&m.0) {
                m.1 -= 1;
            }
        }
        self.villagers[vi as usize] = v;
    }

    fn close_stalls(&mut self, row: &mut [RowEntry], rng: &mut Rng, log: &mut NightLog) {
        for e in row.iter_mut() {
            for g in 0..GOODS {
                if e.stall.stock[g] > 0 && SPOIL_PCT[g] > 0 {
                    let lost = ((e.stall.stock[g] * SPOIL_PCT[g] + rng.below(100)) / 100).min(e.stall.stock[g]);
                    if lost > 0 {
                        e.stall.stock[g] -= lost;
                        log.spoiled.push((e.id, g as u8, lost));
                    }
                }
            }
            let rent = rent_due(e.stall.money, e.stall.spot);
            e.stall.money -= rent;
            e.stall.rent_paid += rent;
            e.stall.rent_at = self.night + 1;
            self.treasury += rent;
            log.rent += rent;
            e.stall.rep -= e.stall.rep * REP_DECAY_PCT / 100;
            if !e.npc {
                let relief = self.player_relief(&e.stall);
                e.stall.money += relief;
                if relief > 0 {
                    e.stall.relief_at = self.night;
                    self.treasury -= relief;
                    log.relief += relief;
                }
            }
            if !e.npc
                && e.stall.spot != NO_SPOT
                && self.night.saturating_sub(e.stall.last_action) >= IDLE_EVICT_NIGHTS
            {
                self.row[e.stall.spot as usize] = 0;
                e.stall.spot = NO_SPOT;
                log.evicted.push(e.id);
            }
        }
    }

    /// A stall with next to nothing left whose owner is still playing gets back on its feet.
    fn player_relief(&self, s: &Stall) -> u64 {
        let goods: u64 = (0..GOODS).map(|g| s.stock[g] as u64 * DOCK_BASE[g] as u64).sum();
        let broke = s.money + goods < PLAYER_RELIEF_BELOW;
        let active = self.night.saturating_sub(s.last_action) <= PLAYER_RELIEF_ACTIVE_NIGHTS;
        let due = s.relief_at == 0 || self.night >= s.relief_at + PLAYER_RELIEF_COOLDOWN_NIGHTS;
        if broke && active && due && s.spot != NO_SPOT { PLAYER_RELIEF.min(self.treasury) } else { 0 }
    }

    fn pay_dock_dues(&mut self, log: &mut NightLog) {
        let dues = self.dock_money.saturating_sub(DOCK_RESERVE) * DOCK_DUES_PCT / 100;
        self.dock_money -= dues;
        self.treasury += dues;
        log.dues = dues;
    }

    /// The merchant rules: push the price up while goods fly off, back off when villagers walk away,
    /// keep a margin over the Dock, restock what is missing with a limited budget, and stock up
    /// ahead of an announced festival.
    fn run_merchants(&mut self, row: &mut [RowEntry], rng: &mut Rng, log: &mut NightLog) {
        for e in row.iter_mut().filter(|e| e.npc) {
            if e.stall.money < MERCHANT_RELIEF_BELOW {
                let relief = MERCHANT_RELIEF.min(self.treasury);
                self.treasury -= relief;
                e.stall.money += relief;
                log.relief += relief;
            }
            let cfg = &MERCHANT_TABLE[e.id as usize - 1];
            for g in 0..GOODS {
                if cfg.target[g] == 0 {
                    continue;
                }
                let factor = dock_price_factor(self.event_now, g);
                let marginal = dock_marginal(g, self.dock[g].heat, factor);
                let stock = e.stall.stock[g];
                let sold = e.sold[g] as u32;
                let refused = e.refused[g] as u32;
                let (mut price, mut note) = (e.stall.price[g], NOTE_HOLD);
                if refused > 0 && refused >= sold {
                    price = price * MERCHANT_CUT_PCT / 100;
                    note = NOTE_CUT;
                } else if sold > 0 && stock == 0 {
                    price = (price * MERCHANT_SOLD_OUT_PCT / 100).max(price + 1);
                    note = NOTE_RAISED;
                } else if sold > 0 && sold * 3 >= stock + sold {
                    price = (price * MERCHANT_RAISE_PCT / 100).max(price + 1);
                    note = NOTE_RAISED;
                } else if sold == 0 && stock > 0 && rng.below(MERCHANT_DRIFT_ODDS) == 0 {
                    price = price * MERCHANT_DRIFT_PCT / 100;
                    note = NOTE_DRIFT;
                }
                let floor = marginal * (100 + MERCHANT_MIN_MARGIN_PCT) / 100;
                if price < floor {
                    price = floor;
                    note = NOTE_FLOOR;
                }
                price = price.min(FAIR[g] * MERCHANT_MAX_PRICE_PCT / 100);

                let festival = self.event_left == 1
                    && matches!(self.event_next, Event::Festival { good } if good as usize == g);
                let target = if festival { cfg.target[g] * MERCHANT_FESTIVAL_STOCK_PCT / 100 } else { cfg.target[g] };
                let held: u32 = e.stall.stock.iter().sum();
                let room = TIER_CAPACITY[e.stall.tier as usize].saturating_sub(held);
                let mut qty = target.saturating_sub(stock).min(self.dock[g].left).min(room);
                if marginal >= price {
                    qty = 0;
                    note = NOTE_TOO_DEAR;
                }
                let budget = e.stall.money * MERCHANT_RESTOCK_BUDGET_PCT / 100;
                let heat = self.dock[g].heat;
                while qty > 0 && dock_cost(g, heat, qty, factor) > budget {
                    qty -= 1;
                }
                if qty > 0 {
                    let cost = dock_cost(g, heat, qty, factor);
                    e.stall.money -= cost;
                    e.stall.stock[g] += qty;
                    self.dock_money += cost;
                    self.dock[g].heat += qty;
                    self.dock[g].left -= qty;
                    log.restocks.push((e.id, g as u8, qty, cost));
                }
                e.stall.price[g] = price;
                e.stall.notes[g] = note;
            }
        }
    }

    fn turn_the_night(&mut self, rng: &mut Rng) {
        self.night += 1;
        self.foundings_tonight = 0;
        self.event_left -= 1;
        if self.event_left == 0 {
            self.event_now = self.event_next;
            self.event_left = event_nights(self.event_now);
            self.event_next = roll_event(rng);
        }
        for g in 0..GOODS {
            let d = &mut self.dock[g];
            d.heat = d.heat * (100 - HEAT_DECAY_PCT) / 100;
            d.left = dock_night_supply(self.event_now, g);
        }
    }

    /// Stalls without a spot pay their wealth rent a few at a time, so money cannot hide off the row.
    fn sweep_alley(&mut self) {
        if self.minted <= MERCHANTS {
            return;
        }
        for _ in 0..SWEEP_PER_CALL {
            self.sweep_cursor += 1;
            if self.sweep_cursor > self.minted {
                self.sweep_cursor = MERCHANTS + 1;
            }
            let id = self.sweep_cursor;
            let accrued = self.accrued_rent(id);
            if accrued > 0 {
                self.settle_accrued(id, accrued);
            }
        }
    }
}

fn remember(v: &mut Villager, id: u32) {
    if let Some(m) = v.memory.iter_mut().find(|m| m.0 == id) {
        m.1 = (m.1 + MEMORY_GAIN).min(MEMORY_MAX);
    } else if let Some(m) = v.memory.iter_mut().min_by_key(|m| m.1) {
        *m = (id, MEMORY_GAIN);
    }
}

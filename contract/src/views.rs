//! Read-only methods for clients. All numbers fit a JavaScript number: no balance can exceed
//! `FOUNDING_MONEY`, and nonces stop at `MAX_NONCE`.

use crate::config::*;
use crate::market::*;
use crate::types::*;
use crate::{LanternRow, LanternRowExt, signing_message};
use near_sdk::{AccountId, env, near};

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct StallView {
    pub id: u32,
    pub name: String,
    pub npc: bool,
    pub owner: AccountId,
    pub founder: AccountId,
    /// None means no spot on the row: no customers until the stall moves back.
    pub spot: Option<u8>,
    pub footfall: u32,
    pub money: u64,
    pub stock: [u32; GOODS],
    pub price: [u32; GOODS],
    pub rep: u16,
    pub tier: u8,
    pub capacity: u32,
    pub service: u32,
    pub worth: u64,
    pub listed: Option<u64>,
    pub rent_next: u64,
    pub sold_last: [u16; GOODS],
    /// The merchant's reason for each price; index into `config().notes`.
    pub notes: [u8; GOODS],
    pub revenue: u64,
    pub earned: u64,
    pub customers: u32,
    pub rent_paid: u64,
    pub last_action: u32,
    pub moved_at: u32,
    pub minted_night: u32,
    pub holders: Vec<AccountId>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct DockView {
    /// Price of the next unit.
    pub price: u32,
    /// Units left tonight.
    pub left: u32,
    pub heat: u32,
    /// Percent the current event applies to this good's price.
    pub factor_pct: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct VillagerView {
    pub id: u8,
    pub name: String,
    pub trade: String,
    pub wallet: u64,
    pub wage: u64,
    pub taste: [u32; GOODS],
    pub unmet: [u8; GOODS],
    /// Goods this villager wants tonight, most overdue first.
    pub wants: Vec<u8>,
    /// (stall id, percent bonus) of the stalls they remember.
    pub memory: Vec<(u32, u8)>,
}

/// Everything a client needs to draw the street.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct WorldView {
    pub night: u32,
    pub now_ms: u64,
    pub ends_ms: u64,
    /// True once anyone may call `advance_night`.
    pub due: bool,
    /// In force tonight.
    pub event: Event,
    /// Nights it still lasts, counting tonight.
    pub event_left: u8,
    /// What follows it. An event is always announced at least one night ahead.
    pub event_next: Event,
    pub treasury: u64,
    pub dock_money: u64,
    pub dock: Vec<DockView>,
    /// Stalls on the row, front first.
    pub row: Vec<StallView>,
    pub villagers: Vec<VillagerView>,
    /// (stall id, asking price)
    pub listings: Vec<(u32, u64)>,
    pub stalls_total: u32,
    pub licences_left: u32,
    pub licences_tonight: u32,
    pub nights_slept: u64,
    /// The night that just ended, for animation.
    pub last: Option<NightLog>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PlayerView {
    pub account: AccountId,
    pub nonce: u64,
    pub purse: u64,
    pub founded: bool,
    pub stalls: Vec<StallView>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RankView {
    pub rank: u32,
    pub id: u32,
    pub name: String,
    pub npc: bool,
    pub owner: AccountId,
    pub worth: u64,
    pub money: u64,
    pub spot: Option<u8>,
    pub tier: u8,
    pub rep: u16,
}

/// Where all the coin is. `total` must always equal `founding`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditView {
    pub founding: u64,
    pub total: u64,
    pub treasury: u64,
    pub dock: u64,
    pub villagers: u64,
    pub stalls: u64,
    pub purses: u64,
    pub grants_paid: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct GoodCfg {
    pub name: String,
    pub fair: u32,
    pub dock_base: u32,
    pub dock_supply: u32,
    pub heat_slope: u32,
    pub spoil_pct: u32,
    pub need_period: u32,
    pub max_price: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SpotCfg {
    pub spot: u8,
    pub footfall: u32,
    pub fee: u64,
    pub rent: u64,
}

/// The fixed rules, so a client never hardcodes them.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ConfigView {
    pub version: String,
    pub night_ms: u64,
    pub max_catchup_nights: u64,
    pub log_keep: u32,
    pub goods: Vec<GoodCfg>,
    pub spots: Vec<SpotCfg>,
    pub tier_capacity: Vec<u32>,
    pub tier_service: Vec<u32>,
    pub tier_cost: Vec<u64>,
    pub starter_grant: u64,
    pub sales_tax_pct: u64,
    pub royalty_pct: u64,
    pub wealth_rent_bp: u64,
    pub rent_floor: u64,
    pub displace_factor: u64,
    pub move_cooldown_nights: u32,
    pub idle_evict_nights: u32,
    pub sell_back_pct: u32,
    pub rep_max: u16,
    pub max_actions_per_call: u32,
    pub max_action_bytes: u32,
    pub max_nonce: u64,
    pub founding_money: u64,
    pub notes: Vec<String>,
}

impl LanternRow {
    pub(crate) fn stall_view(&self, id: u32) -> Option<StallView> {
        let s = self.stalls.get(&id)?;
        let d = self.deeds.get(&id)?;
        Some(StallView {
            id,
            name: d.name.clone(),
            npc: id <= MERCHANTS,
            owner: d.owner.clone(),
            founder: d.founder.clone(),
            spot: (s.spot != NO_SPOT).then_some(s.spot),
            footfall: footfall(s.spot),
            money: s.money,
            stock: s.stock,
            price: s.price,
            rep: s.rep,
            tier: s.tier,
            capacity: TIER_CAPACITY[s.tier as usize],
            service: TIER_SERVICE[s.tier as usize],
            worth: net_worth(s.money, &s.stock, s.tier, s.spot),
            listed: self.listing_price(id),
            rent_next: rent_due(s.money, s.spot),
            sold_last: s.sold_last,
            notes: s.notes,
            revenue: s.revenue,
            earned: s.earned,
            customers: s.customers,
            rent_paid: s.rent_paid,
            last_action: s.last_action,
            moved_at: s.moved_at,
            minted_night: d.minted_night,
            holders: d.holders.clone(),
        })
    }

    fn last_log(&self) -> Option<NightLog> {
        let night = self.night.checked_sub(1)?;
        self.logs.get(&(night % LOG_KEEP)).filter(|l| l.night == night).cloned()
    }
}

#[near]
impl LanternRow {
    /// The whole world at once, for rendering.
    pub fn world(&self) -> WorldView {
        let now = env::block_timestamp_ms();
        let ends = self.night_started_ms + NIGHT_MS;
        let dock = (0..GOODS)
            .map(|g| DockView {
                price: dock_marginal(g, self.dock[g].heat, dock_price_factor(self.event_now, g)),
                left: self.dock[g].left,
                heat: self.dock[g].heat,
                factor_pct: dock_price_factor(self.event_now, g),
            })
            .collect();
        let row = self.row.iter().filter(|&&id| id != 0).filter_map(|&id| self.stall_view(id)).collect();
        let villagers = self
            .villagers
            .iter()
            .zip(VILLAGER_TABLE.iter())
            .enumerate()
            .map(|(i, (v, cfg))| {
                let mut wants: Vec<(u32, u8)> = (0..GOODS)
                    .filter(|&g| cfg.taste[g] > 0)
                    .filter_map(|g| {
                        let period = need_period(g, cfg.taste[g]);
                        let unmet = v.unmet[g] as u32 + spare_money_nights(wealth_pct(v.wallet, cfg.wage));
                        (unmet >= period).then(|| (unmet - period, g as u8))
                    })
                    .collect();
                wants.sort_by(|a, b| b.0.cmp(&a.0));
                VillagerView {
                    id: i as u8,
                    name: cfg.name.to_string(),
                    trade: cfg.trade.to_string(),
                    wallet: v.wallet,
                    wage: cfg.wage,
                    taste: cfg.taste,
                    unmet: v.unmet,
                    wants: wants.into_iter().map(|w| w.1).collect(),
                    memory: v.memory.iter().filter(|m| m.1 > 0).cloned().collect(),
                }
            })
            .collect();
        WorldView {
            night: self.night,
            now_ms: now,
            ends_ms: ends,
            due: now >= ends,
            event: self.event_now,
            event_left: self.event_left,
            event_next: self.event_next,
            treasury: self.treasury,
            dock_money: self.dock_money,
            dock,
            row,
            villagers,
            listings: self.listings.clone(),
            stalls_total: self.minted,
            licences_left: MAX_PLAYER_STALLS - (self.minted - MERCHANTS),
            licences_tonight: MAX_FOUNDINGS_PER_NIGHT.saturating_sub(self.foundings_tonight),
            nights_slept: self.nights_slept,
            last: self.last_log(),
        }
    }

    /// One account's nonce, purse and stalls. `account` is the 64-hex public key for wallet-free players.
    pub fn player(&self, account: AccountId) -> PlayerView {
        let record = self.players.get(&account).cloned().unwrap_or_default();
        let stalls = record.tokens.iter().filter_map(|&id| self.stall_view(id)).collect();
        PlayerView { account, nonce: record.nonce, purse: record.purse, founded: record.founded, stalls }
    }

    pub fn stall(&self, id: u32) -> Option<StallView> {
        self.stall_view(id)
    }

    /// Stalls by id, including those without a spot. `from` starts at 1.
    pub fn stalls(&self, from: Option<u32>, limit: Option<u32>) -> Vec<StallView> {
        let from = from.unwrap_or(1).max(1);
        let limit = limit.unwrap_or(50).min(120);
        (from..=self.minted).take(limit as usize).filter_map(|id| self.stall_view(id)).collect()
    }

    /// Every stall ranked by net worth, NPC merchants included.
    pub fn leaderboard(&self, limit: Option<u32>) -> Vec<RankView> {
        let mut rows: Vec<RankView> = (1..=self.minted)
            .filter_map(|id| {
                let s = self.stalls.get(&id)?;
                let d = self.deeds.get(&id)?;
                Some(RankView {
                    rank: 0,
                    id,
                    name: d.name.clone(),
                    npc: id <= MERCHANTS,
                    owner: d.owner.clone(),
                    worth: net_worth(s.money, &s.stock, s.tier, s.spot),
                    money: s.money,
                    spot: (s.spot != NO_SPOT).then_some(s.spot),
                    tier: s.tier,
                    rep: s.rep,
                })
            })
            .collect();
        rows.sort_by(|a, b| b.worth.cmp(&a.worth).then(a.id.cmp(&b.id)));
        rows.truncate(limit.unwrap_or(25).min(120) as usize);
        for (i, r) in rows.iter_mut().enumerate() {
            r.rank = i as u32 + 1;
        }
        rows
    }

    /// Who bought what on a past night. Without a night, the one that just ended.
    pub fn night_log(&self, night: Option<u32>) -> Option<NightLog> {
        match night {
            None => self.last_log(),
            Some(n) => self.logs.get(&(n % LOG_KEEP)).filter(|l| l.night == n).cloned(),
        }
    }

    /// Sums every balance in the game. Anyone can check that no coin ever appeared or vanished.
    pub fn audit(&self) -> AuditView {
        let villagers: u64 = self.villagers.iter().map(|v| v.wallet).sum();
        let stalls: u64 = (1..=self.minted).filter_map(|id| self.stalls.get(&id)).map(|s| s.money).sum();
        let purses: u64 = self.accounts.iter().filter_map(|a| self.players.get(a)).map(|p| p.purse).sum();
        AuditView {
            founding: FOUNDING_MONEY,
            total: self.treasury + self.dock_money + villagers + stalls + purses,
            treasury: self.treasury,
            dock: self.dock_money,
            villagers,
            stalls,
            purses,
            grants_paid: self.grants_paid,
        }
    }

    /// What `qty` units of a good would cost at the Dock right now; None for a good that does not
    /// exist. It may change before the purchase lands, so `buy` still takes a limit.
    pub fn dock_quote(&self, good: u8, qty: u32) -> Option<u64> {
        let g = good as usize;
        (g < GOODS).then(|| dock_cost(g, self.dock[g].heat, qty, dock_price_factor(self.event_now, g)))
    }

    /// The exact text a player signs for `act`.
    pub fn signing_text(&self, nonce: u64, action: String) -> String {
        signing_message(env::current_account_id().as_str(), nonce, &action)
    }

    pub fn config(&self) -> ConfigView {
        ConfigView {
            version: env!("CARGO_PKG_VERSION").to_string(),
            night_ms: NIGHT_MS,
            max_catchup_nights: MAX_CATCHUP_NIGHTS,
            log_keep: LOG_KEEP,
            goods: (0..GOODS)
                .map(|g| GoodCfg {
                    name: GOOD_NAMES[g].to_string(),
                    fair: FAIR[g],
                    dock_base: DOCK_BASE[g],
                    dock_supply: DOCK_SUPPLY[g],
                    heat_slope: HEAT_SLOPE[g],
                    spoil_pct: SPOIL_PCT[g],
                    need_period: NEED_PERIOD[g],
                    max_price: FAIR[g] * MAX_PRICE_FACTOR,
                })
                .collect(),
            spots: (0..ROW_SPOTS as u8)
                .map(|s| SpotCfg { spot: s, footfall: footfall(s), fee: spot_fee(s), rent: spot_rent(s) })
                .collect(),
            tier_capacity: TIER_CAPACITY.to_vec(),
            tier_service: TIER_SERVICE.to_vec(),
            tier_cost: TIER_COST.to_vec(),
            starter_grant: STARTER_GRANT,
            sales_tax_pct: SALES_TAX_PCT,
            royalty_pct: ROYALTY_PCT,
            wealth_rent_bp: WEALTH_RENT_BP,
            rent_floor: RENT_FLOOR,
            displace_factor: DISPLACE_FACTOR,
            move_cooldown_nights: MOVE_COOLDOWN_NIGHTS,
            idle_evict_nights: IDLE_EVICT_NIGHTS,
            sell_back_pct: SELL_BACK_PCT,
            rep_max: REP_MAX,
            max_actions_per_call: MAX_ACTIONS_PER_CALL as u32,
            max_action_bytes: MAX_ACTION_BYTES as u32,
            max_nonce: MAX_NONCE,
            founding_money: FOUNDING_MONEY,
            notes: NOTE_NAMES.iter().map(|n| n.to_string()).collect(),
        }
    }
}

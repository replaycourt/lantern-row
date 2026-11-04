//! Every number of the game, in one readable file. The contract has no owner and no method that
//! changes any of them: to change a rule, somebody has to deploy a different contract.

pub const NIGHT_MS: u64 = 20_000;
/// Most nights one `advance_night` call simulates. Nights beyond that are slept through: they are
/// not simulated and the clock simply restarts, so no backlog can ever exceed one call.
pub const MAX_CATCHUP_NIGHTS: u64 = 6;
/// How many past night logs stay readable.
pub const LOG_KEEP: u32 = 6;

// ---- goods ----------------------------------------------------------------------------------

pub const GOODS: usize = 5;
pub const GOOD_NAMES: [&str; GOODS] = ["tea", "lamp oil", "dumplings", "silk", "charms"];
/// What a villager with average taste considers a fair retail price.
pub const FAIR: [u32; GOODS] = [60, 90, 40, 350, 180];
/// Dock wholesale price with no recent buying.
pub const DOCK_BASE: [u32; GOODS] = [30, 46, 20, 170, 90];
/// Units per night the Dock can supply on a normal night.
pub const DOCK_SUPPLY: [u32; GOODS] = [16, 10, 26, 5, 7];
/// Heat (units recently bought) that doubles the wholesale price.
pub const HEAT_SLOPE: [u32; GOODS] = [120, 80, 180, 24, 45];
/// Heat lost per night.
pub const HEAT_DECAY_PCT: u32 = 30;
/// Stock lost per night (percent, rounded by a dice roll).
pub const SPOIL_PCT: [u32; GOODS] = [2, 1, 15, 0, 0];
/// Nights between purchases for a villager with taste 100.
pub const NEED_PERIOD: [u32; GOODS] = [2, 3, 1, 8, 5];
/// Share of the current wholesale price the Dock pays for goods sold back to it.
pub const SELL_BACK_PCT: u32 = 40;

// ---- money ----------------------------------------------------------------------------------

/// All the coin that will ever exist. It is split at founding and only moves afterwards.
pub const FOUNDING_MONEY: u64 = 1_000_000;
pub const DOCK_FOUNDING: u64 = 40_000;
pub const VILLAGER_FOUNDING: u64 = 1_200;
pub const MERCHANT_FOUNDING: u64 = 12_000;
/// The Treasury holds the remainder at founding (see `treasury_founding`).
pub const STARTER_GRANT: u64 = 3_000;
/// The Treasury stops paying grants below this balance, so founders cannot starve the wages.
pub const GRANT_TREASURY_FLOOR: u64 = 150_000;
/// Percent of each sale that goes to the Treasury (rounded up).
pub const SALES_TAX_PCT: u64 = 5;
/// Founder royalty on a sale of a stall, in percent (coin sale) and basis points (NEP-199 payout).
pub const ROYALTY_PCT: u64 = 5;
pub const ROYALTY_BPS: u128 = 500;
/// The Dock keeps this much for buying goods back and hands the rest over as harbour dues.
pub const DOCK_RESERVE: u64 = 20_000;
pub const DOCK_DUES_PCT: u64 = 40;
/// Wages run at 100% while the Treasury holds at least this, proportionally less below.
pub const WAGE_FULL_TREASURY: u64 = 300_000;
pub const WAGE_MIN_PCT: u64 = 25;
/// A villager with this many nights of wage saved gets no wage until they spend some.
pub const WALLET_CAP_NIGHTS: u64 = 12;

/// Ground rent per night is `spot_rent(spot)` plus this share of the money above the rent floor.
pub const WEALTH_RENT_BP: u64 = 50;
/// Rent never touches the last coins of a stall, so nobody is ever fully wiped out.
pub const RENT_FLOOR: u64 = 500;

// ---- the row --------------------------------------------------------------------------------

pub const ROW_SPOTS: usize = 24;
pub const NO_SPOT: u8 = 255;
/// Most stalls one villager looks at per night (plus up to three remembered ones). Together with
/// `ROW_SPOTS` this bounds the work of a night.
pub const VISIT_CAP: usize = 10;
/// Percent chance a villager walks past a stall at a spot.
pub const fn footfall(spot: u8) -> u32 {
    if spot == NO_SPOT { 0 } else { 100 - (spot as u32 * 3) / 2 }
}
/// One-off fee to move to a free spot. Displacing an occupant costs `DISPLACE_FACTOR` times this.
pub const fn spot_fee(spot: u8) -> u64 {
    if spot == NO_SPOT {
        return 0;
    }
    let d = ROW_SPOTS as u64 - spot as u64;
    12 * d * d
}
pub const fn spot_rent(spot: u8) -> u64 {
    if spot == NO_SPOT { 0 } else { ROW_SPOTS as u64 - spot as u64 }
}
pub const DISPLACE_FACTOR: u64 = 2;
/// A stall that just moved, or was just displaced, cannot move or be displaced for this long.
pub const MOVE_COOLDOWN_NIGHTS: u32 = 5;
/// A player stall nobody acted for over this many nights loses its spot.
pub const IDLE_EVICT_NIGHTS: u32 = 60;
/// Stalls without a spot checked for accrued wealth rent per `advance_night` call.
pub const SWEEP_PER_CALL: u32 = 4;

// ---- stalls ---------------------------------------------------------------------------------

pub const TIERS: usize = 4;
pub const TIER_CAPACITY: [u32; TIERS] = [40, 80, 140, 220];
/// Customers a stall can serve per night.
pub const TIER_SERVICE: [u32; TIERS] = [10, 14, 18, 24];
/// Cost of reaching each size, paid to the Treasury.
pub const TIER_COST: [u64; TIERS] = [0, 5_000, 14_000, 36_000];
/// What a size is worth on the leaderboard.
pub const TIER_WORTH: [u64; TIERS] = [0, 2_500, 9_500, 27_500];

pub const REP_MAX: u16 = 1_000;
pub const REP_START_PLAYER: u16 = 200;
pub const REP_START_MERCHANT: u16 = 250;
pub const REP_PER_SALE: u16 = 4;
pub const REP_PER_REFUSAL: u16 = 3;
pub const REP_DECAY_PCT: u16 = 3;

pub const MAX_PRICE_FACTOR: u32 = 10;
pub const MAX_NAME_CHARS: usize = 24;

// ---- caps that bound storage and gas ----------------------------------------------------------

pub const MERCHANTS: u32 = 6;
pub const MAX_PLAYER_STALLS: u32 = 100;
pub const MAX_FOUNDINGS_PER_NIGHT: u32 = 4;
pub const MAX_ACCOUNTS: u32 = 400;
pub const MAX_TOKENS_PER_ACCOUNT: usize = 8;
pub const MAX_LISTINGS: usize = 32;
pub const MAX_APPROVALS: usize = 4;
pub const MAX_HOLDER_HISTORY: usize = 3;
pub const MAX_ACTIONS_PER_CALL: usize = 16;
pub const MAX_ACTION_BYTES: usize = 2_048;
/// JavaScript's largest safe integer. A client cannot lock itself out by signing u64::MAX.
pub const MAX_NONCE: u64 = 9_007_199_254_740_991;

// ---- villagers --------------------------------------------------------------------------------

pub const VILLAGERS: usize = 12;
pub struct VillagerCfg {
    pub name: &'static str,
    pub trade: &'static str,
    pub wage: u64,
    /// Percent of the fair price this villager is prepared to pay; 0 means never buys it.
    pub taste: [u32; GOODS],
}
pub const VILLAGER_TABLE: [VillagerCfg; VILLAGERS] = [
    VillagerCfg { name: "Ansel", trade: "dock hand", wage: 200, taste: [100, 70, 120, 0, 40] },
    VillagerCfg { name: "Bao", trade: "lamplighter", wage: 220, taste: [90, 150, 100, 0, 60] },
    VillagerCfg { name: "Cora", trade: "seamstress", wage: 280, taste: [120, 60, 80, 130, 90] },
    VillagerCfg { name: "Dima", trade: "fisher", wage: 200, taste: [70, 90, 130, 0, 110] },
    VillagerCfg { name: "Eun", trade: "apothecary", wage: 250, taste: [150, 80, 70, 60, 120] },
    VillagerCfg { name: "Farah", trade: "bride-to-be", wage: 320, taste: [80, 50, 60, 160, 140] },
    VillagerCfg { name: "Goro", trade: "night watchman", wage: 210, taste: [110, 120, 110, 0, 80] },
    VillagerCfg { name: "Hana", trade: "teacher", wage: 240, taste: [130, 90, 90, 60, 70] },
    VillagerCfg { name: "Ines", trade: "card player", wage: 220, taste: [60, 40, 90, 40, 170] },
    VillagerCfg { name: "Jun", trade: "porter", wage: 190, taste: [90, 60, 140, 0, 50] },
    VillagerCfg { name: "Kalla", trade: "shrine keeper", wage: 240, taste: [100, 130, 50, 40, 150] },
    VillagerCfg { name: "Lio", trade: "heir", wage: 360, taste: [100, 60, 100, 140, 100] },
];
/// Most different goods one villager buys in a night.
pub const MAX_WANTS: usize = 4;
/// Extra willingness to pay, in percent, per night a want has gone unmet.
pub const UNMET_PREMIUM_PCT: u64 = 15;
pub const UNMET_PREMIUM_MAX_NIGHTS: u32 = 8;
pub const UNMET_CAP: u8 = 30;
/// Memory of a stall that served a villager: percent bonus, gained per sale, faded per night.
pub const MEMORY_SLOTS: usize = 3;
pub const MEMORY_GAIN: u8 = 2;
pub const MEMORY_MAX: u8 = 10;

// ---- NPC merchants ----------------------------------------------------------------------------

pub struct MerchantCfg {
    pub name: &'static str,
    pub spot: u8,
    /// Stock this merchant tries to hold of each good.
    pub target: [u32; GOODS],
}
pub const MERCHANT_TABLE: [MerchantCfg; MERCHANTS as usize] = [
    MerchantCfg { name: "The Quiet Kettle", spot: 1, target: [14, 3, 0, 0, 2] },
    MerchantCfg { name: "Steam and Sesame", spot: 4, target: [3, 0, 14, 0, 0] },
    MerchantCfg { name: "Wick and Flask", spot: 8, target: [0, 12, 3, 0, 2] },
    MerchantCfg { name: "Moth and Loom", spot: 12, target: [2, 0, 0, 5, 2] },
    MerchantCfg { name: "Seven Knots", spot: 16, target: [0, 2, 0, 1, 8] },
    MerchantCfg { name: "Uncle's Everything", spot: 20, target: [5, 4, 6, 1, 2] },
];
pub const MERCHANT_START_TIER: u8 = 1;
/// Selling at least a third of the stock in a night raises the price by this much.
pub const MERCHANT_RAISE_PCT: u32 = 103;
/// Villagers walking away cuts it by this much.
pub const MERCHANT_CUT_PCT: u32 = 96;
/// A night without any interest cuts it by this much, one time in `MERCHANT_DRIFT_ODDS`.
pub const MERCHANT_DRIFT_PCT: u32 = 97;
pub const MERCHANT_DRIFT_ODDS: u32 = 2;
/// A merchant never prices under the replacement cost plus this margin...
pub const MERCHANT_MIN_MARGIN_PCT: u32 = 25;
/// ...nor above this percentage of the fair price.
pub const MERCHANT_MAX_PRICE_PCT: u32 = 260;
/// Share of its money a merchant spends on one good per night.
pub const MERCHANT_RESTOCK_BUDGET_PCT: u64 = 30;
pub const MERCHANT_FESTIVAL_STOCK_PCT: u32 = 160;
/// The Treasury props up a merchant below this balance, so the row never goes dark.
pub const MERCHANT_RELIEF_BELOW: u64 = 1_500;
pub const MERCHANT_RELIEF: u64 = 1_500;
/// A player whose stall is down to nothing but who is still trying gets a small hand from the
/// Treasury, so no mistake ends the game. Relief coin is not "earned": it cannot buy other stalls.
pub const PLAYER_RELIEF: u64 = 400;
pub const PLAYER_RELIEF_BELOW: u64 = 100;
pub const PLAYER_RELIEF_COOLDOWN_NIGHTS: u32 = 30;
pub const PLAYER_RELIEF_ACTIVE_NIGHTS: u32 = 10;
/// Reasons a merchant gives for a price, shown as a tooltip by the client.
pub const NOTE_HOLD: u8 = 0;
pub const NOTE_RAISED: u8 = 1;
pub const NOTE_CUT: u8 = 2;
pub const NOTE_FLOOR: u8 = 3;
pub const NOTE_TOO_DEAR: u8 = 4;
pub const NOTE_DRIFT: u8 = 5;
pub const NOTE_NAMES: [&str; 6] = [
    "selling steadily, price held",
    "sold a good part of the stock, price raised",
    "villagers walked away, price cut",
    "the Dock got dearer, price raised to the floor",
    "the Dock is too dear to restock",
    "nobody was interested, price eased",
];

// ---- events -----------------------------------------------------------------------------------

/// Festival: villagers want the good now, buy two, and pay this percent.
pub const FESTIVAL_WTP_PCT: u64 = 130;
pub const FESTIVAL_EXTRA_UNMET: u32 = 1;
pub const FESTIVAL_UNITS: u32 = 2;
/// Storm: the Dock supplies this share of a good at this price.
pub const STORM_SUPPLY_PCT: u32 = 25;
pub const STORM_PRICE_PCT: u32 = 150;
/// Bumper catch: the Dock has twice the supply at this price.
pub const BUMPER_SUPPLY_PCT: u32 = 200;
pub const BUMPER_PRICE_PCT: u32 = 70;
/// Payday: wages at this percent, and villagers feel richer.
pub const PAYDAY_WAGE_PCT: u64 = 150;
pub const PAYDAY_WTP_PCT: u64 = 110;
/// Chance of each event per night, out of 100: festival, storm, bumper, payday; the rest is quiet.
pub const EVENT_ODDS: [u32; 4] = [28, 22, 15, 10];

/// What the Treasury starts with: everything not handed out at founding.
pub const fn treasury_founding() -> u64 {
    FOUNDING_MONEY
        - DOCK_FOUNDING
        - VILLAGER_FOUNDING * VILLAGERS as u64
        - MERCHANT_FOUNDING * MERCHANTS as u64
}

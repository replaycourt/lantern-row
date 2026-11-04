//! State and message types.

use crate::config::*;
use near_sdk::{AccountId, near};

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Event {
    Quiet,
    Festival { good: u8 },
    Storm { good: u8 },
    Bumper { good: u8 },
    Payday,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DockGood {
    pub heat: u32,
    pub left: u32,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Villager {
    pub wallet: u64,
    /// Nights since each good was last bought.
    pub unmet: [u8; GOODS],
    /// Stalls this villager remembers: (stall id, percent bonus).
    pub memory: [(u32, u8); MEMORY_SLOTS],
}

/// The part of a stall the nights touch. It stays with the token through every transfer.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Stall {
    pub money: u64,
    pub stock: [u32; GOODS],
    /// 0 means not for sale.
    pub price: [u32; GOODS],
    pub rep: u16,
    pub tier: u8,
    pub spot: u8,
    pub last_action: u32,
    pub moved_at: u32,
    pub rent_at: u32,
    pub sold_last: [u16; GOODS],
    pub notes: [u8; GOODS],
    pub revenue: u64,
    /// Coin earned from villagers or collected from a purse and not yet spent on buying stalls.
    /// Starter grants are not in here, so a throwaway stall cannot launder its grant.
    pub earned: u64,
    pub customers: u32,
    pub rent_paid: u64,
    /// When this stall last got relief from the Treasury; 0 means never.
    pub relief_at: u32,
}

/// The NFT part of a stall, untouched by the nights.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Deed {
    pub owner: AccountId,
    pub founder: AccountId,
    pub name: String,
    pub minted_night: u32,
    /// The latest previous owners, oldest first.
    pub holders: Vec<AccountId>,
    pub approvals: Vec<(AccountId, u64)>,
    pub next_approval_id: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct Player {
    pub nonce: u64,
    /// Coin from stall sales and founder royalties, waiting to be collected into a stall.
    pub purse: u64,
    pub founded: bool,
    pub tokens: Vec<u32>,
}

/// What a night looked like, so a client can animate it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct NightLog {
    pub night: u32,
    pub event: Event,
    pub wages: u64,
    pub tax: u64,
    pub rent: u64,
    pub dues: u64,
    pub relief: u64,
    /// (villager, stall, good, price), in the order the villagers walked.
    pub sales: Vec<(u8, u32, u8, u32)>,
    /// (villager, stall, good): saw it at this stall and found it too dear.
    pub refusals: Vec<(u8, u32, u8)>,
    /// (villager, good): wanted it and found no stock of it anywhere on their walk.
    pub missed: Vec<(u8, u8)>,
    /// (stall, good, units, cost): NPC merchants restocking at the Dock.
    pub restocks: Vec<(u32, u8, u32, u64)>,
    /// (stall, good, units) lost to spoilage.
    pub spoiled: Vec<(u32, u8, u32)>,
    pub evicted: Vec<u32>,
}

/// One gameplay action. Sent as a JSON array, for example
/// `[{"buy":{"stall":7,"good":0,"qty":5,"max_cost":400}},{"price":{"stall":7,"good":0,"price":70}}]`.
/// The `max_*` and `min_*` fields are guards: the contract computes every price itself and refuses
/// the action if the result is worse than the player agreed to.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Found { name: String },
    Buy { stall: u32, good: u8, qty: u32, max_cost: u64 },
    SellBack { stall: u32, good: u8, qty: u32, min_pay: u64 },
    Price { stall: u32, good: u8, price: u32 },
    Move { stall: u32, spot: u8, max_fee: u64 },
    Upgrade { stall: u32, max_cost: u64 },
    Rename { stall: u32, name: String },
    List { stall: u32, price: u64 },
    Unlist { stall: u32 },
    BuyStall { with: u32, target: u32, max_price: u64, min_money: u64 },
    Collect { stall: u32 },
    Transfer { stall: u32, to: AccountId },
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ActOutcome {
    /// Actions applied, in order, before the first refusal.
    pub applied: u32,
    pub total: u32,
    /// Why the next action was refused. The nonce is spent either way.
    pub error: Option<String>,
    pub night: u32,
    pub nonce: u64,
    /// Ids of stalls founded by this call.
    pub minted: Vec<u32>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AdvanceOutcome {
    /// Nights simulated by this call; 0 if the current night has not elapsed yet.
    pub advanced: u32,
    /// Nights not simulated because the town slept through them.
    pub slept: u64,
    pub night: u32,
    pub ends_ms: u64,
}

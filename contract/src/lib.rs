//! Lantern Row: a night-market trading game. See SPEC.md for the rules and the API.
//!
//! The contract has no owner and no admin method. Every rule is a constant in `config.rs`.

pub mod config;
pub mod market;
pub mod types;
pub mod views;

mod actions;
mod night;
mod nft;

use config::*;
use near_contract_standards::non_fungible_token::events::NftMint;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{AccountId, BorshStorageKey, PanicOnDefault, env, near, require, serde_json};
use types::*;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Stalls,
    Deeds,
    Players,
    Accounts,
    Logs,
}

#[near(contract_state, contract_metadata(standard(standard = "nep171", version = "1.2.0"), standard(standard = "nep177", version = "2.0.0"), standard(standard = "nep178", version = "1.1.0"), standard(standard = "nep181", version = "1.0.0"), standard(standard = "nep199", version = "2.1.0")))]
#[derive(PanicOnDefault)]
pub struct LanternRow {
    pub(crate) night: u32,
    pub(crate) night_started_ms: u64,
    pub(crate) nights_slept: u64,
    pub(crate) treasury: u64,
    pub(crate) grants_paid: u64,
    pub(crate) dock_money: u64,
    pub(crate) dock: [DockGood; GOODS],
    pub(crate) event_now: Event,
    /// Nights the current event still lasts, counting the current one.
    pub(crate) event_left: u8,
    pub(crate) event_next: Event,
    pub(crate) villagers: Vec<Villager>,
    /// Stall id at each spot; 0 means free.
    pub(crate) row: [u32; ROW_SPOTS],
    pub(crate) minted: u32,
    pub(crate) foundings_tonight: u32,
    pub(crate) sweep_cursor: u32,
    /// (stall id, asking price in coin)
    pub(crate) listings: Vec<(u32, u64)>,
    pub(crate) stalls: LookupMap<u32, Stall>,
    pub(crate) deeds: LookupMap<u32, Deed>,
    pub(crate) players: LookupMap<AccountId, Player>,
    pub(crate) accounts: Vector<AccountId>,
    pub(crate) logs: LookupMap<u32, NightLog>,
}

/// The exact bytes a player signs for `act`.
pub fn signing_message(contract: &str, nonce: u64, action: &str) -> String {
    format!("lantern-row:v1:{contract}:{nonce}:{action}")
}

#[near]
impl LanternRow {
    /// Founds the town. Can only run once, as part of the deployment.
    #[init]
    #[private]
    pub fn new() -> Self {
        let me = env::current_account_id();
        let mut c = Self {
            night: 1,
            night_started_ms: env::block_timestamp_ms(),
            nights_slept: 0,
            treasury: treasury_founding(),
            grants_paid: 0,
            dock_money: DOCK_FOUNDING,
            dock: [DockGood::default(); GOODS],
            event_now: Event::Quiet,
            event_left: 1,
            event_next: Event::Quiet,
            villagers: Vec::with_capacity(VILLAGERS),
            row: [0; ROW_SPOTS],
            minted: 0,
            foundings_tonight: 0,
            sweep_cursor: MERCHANTS,
            listings: Vec::new(),
            stalls: LookupMap::new(Key::Stalls),
            deeds: LookupMap::new(Key::Deeds),
            players: LookupMap::new(Key::Players),
            accounts: Vector::new(Key::Accounts),
            logs: LookupMap::new(Key::Logs),
        };
        for g in 0..GOODS {
            c.dock[g].left = DOCK_SUPPLY[g];
        }
        for (i, cfg) in VILLAGER_TABLE.iter().enumerate() {
            // The town does not start from a standstill: needs are staggered, some due tonight.
            let unmet = core::array::from_fn(|g| {
                let period = market::need_period(g, cfg.taste[g]);
                if period == u32::MAX { 0 } else { (period - (i + g) as u32 % period) as u8 }
            });
            c.villagers.push(Villager { wallet: VILLAGER_FOUNDING, unmet, memory: [(0, 0); MEMORY_SLOTS] });
        }
        // The town's first event comes from the deployment block, like every later one.
        let mut rng = market::Rng(c.night_seed());
        c.event_next = market::roll_event(&mut rng);
        // The NPC merchants hold their stalls like everybody else, as tokens of the contract itself,
        // which has no keys. Their first stock is stock, not coin, so no money moves here.
        let mut record = Player { founded: true, ..Default::default() };
        for (i, cfg) in MERCHANT_TABLE.iter().enumerate() {
            let id = i as u32 + 1;
            let mut price = [0; GOODS];
            for g in 0..GOODS {
                if cfg.target[g] > 0 {
                    price[g] = FAIR[g];
                }
            }
            c.stalls.insert(
                id,
                Stall {
                    money: MERCHANT_FOUNDING,
                    stock: cfg.target,
                    price,
                    rep: REP_START_MERCHANT,
                    tier: MERCHANT_START_TIER,
                    spot: cfg.spot,
                    last_action: 1,
                    moved_at: 0,
                    rent_at: 1,
                    sold_last: [0; GOODS],
                    notes: [NOTE_HOLD; GOODS],
                    revenue: 0,
                    earned: 0,
                    customers: 0,
                    rent_paid: 0,
                    relief_at: 0,
                },
            );
            c.deeds.insert(
                id,
                Deed {
                    owner: me.clone(),
                    founder: me.clone(),
                    name: cfg.name.to_string(),
                    minted_night: 1,
                    holders: Vec::new(),
                    approvals: Vec::new(),
                    next_approval_id: 0,
                },
            );
            c.row[cfg.spot as usize] = id;
            record.tokens.push(id);
            c.minted = id;
            let token = id.to_string();
            NftMint { owner_id: &me, token_ids: &[token.as_str()], memo: None }.emit();
        }
        c.players.insert(me.clone(), record);
        c.accounts.push(me);
        c
    }

    /// Plays a signed batch of actions for the implicit account of `player_pubkey`, whoever relays it.
    ///
    /// `player_pubkey` and `signature` are lowercase hex (32 and 64 bytes). `action` is a JSON array
    /// of actions, and the signature covers the UTF-8 bytes of
    /// `lantern-row:v1:<contract id>:<nonce>:<action>`. `nonce` must be above the player's last one.
    ///
    /// A bad signature, a used nonce or malformed JSON fails the call. A refused game action does
    /// not: earlier actions of the batch stay applied, the nonce is spent, and `error` says why.
    pub fn act(&mut self, player_pubkey: String, nonce: u64, action: String, signature: String) -> ActOutcome {
        require!(action.len() <= MAX_ACTION_BYTES, "action too long");
        require!(nonce <= MAX_NONCE, "nonce too large");
        let key: [u8; 32] = parse_hex(&player_pubkey).unwrap_or_else(|| env::panic_str("bad public key"));
        let sig: [u8; 64] = parse_hex(&signature).unwrap_or_else(|| env::panic_str("bad signature encoding"));
        let msg = signing_message(env::current_account_id().as_str(), nonce, &action);
        require!(env::ed25519_verify(&sig, msg.as_bytes(), &key), "bad signature");
        let actor: AccountId = player_pubkey.parse().unwrap_or_else(|_| env::panic_str("bad public key"));
        let seen = self.players.get(&actor).map_or(0, |p| p.nonce);
        require!(nonce > seen, "nonce already used");
        let mut outcome = self.run_actions(&actor, &action);
        // An unknown key that founded nothing has no record and leaves no trace, so strangers cannot
        // grow the contract's storage. Everything it could do was refused anyway.
        if let Some(p) = self.players.get_mut(&actor) {
            p.nonce = nonce;
        }
        outcome.nonce = nonce;
        outcome
    }

    /// The same as `act`, for an account that signs its own transactions (a wallet that bought a stall).
    pub fn play(&mut self, action: String) -> ActOutcome {
        require!(action.len() <= MAX_ACTION_BYTES, "action too long");
        let actor = env::predecessor_account_id();
        let seen = self.players.get(&actor).map_or(0, |p| p.nonce);
        let mut outcome = self.run_actions(&actor, &action);
        outcome.nonce = seen;
        outcome
    }

    /// Ends the current night once it has elapsed. Anyone may call it; calling early does nothing.
    pub fn advance_night(&mut self) -> AdvanceOutcome {
        let now = env::block_timestamp_ms();
        let elapsed = now.saturating_sub(self.night_started_ms);
        let due = elapsed / NIGHT_MS;
        if due == 0 {
            return AdvanceOutcome {
                advanced: 0,
                slept: 0,
                night: self.night,
                ends_ms: self.night_started_ms + NIGHT_MS,
            };
        }
        let run = due.min(MAX_CATCHUP_NIGHTS);
        let slept = due - run;
        self.run_nights(run as u32);
        self.nights_slept += slept;
        // Whatever part of a night has passed stays passed; a slept stretch costs nothing later.
        self.night_started_ms = now - elapsed % NIGHT_MS;
        AdvanceOutcome {
            advanced: run as u32,
            slept,
            night: self.night,
            ends_ms: self.night_started_ms + NIGHT_MS,
        }
    }
}

impl LanternRow {
    fn run_actions(&mut self, actor: &AccountId, action: &str) -> ActOutcome {
        let actions: Vec<Action> =
            serde_json::from_str(action).unwrap_or_else(|_| env::panic_str("malformed action"));
        require!(actions.len() <= MAX_ACTIONS_PER_CALL, "too many actions");
        let total = actions.len() as u32;
        let mut outcome =
            ActOutcome { applied: 0, total, error: None, night: self.night, nonce: 0, minted: Vec::new() };
        for a in actions {
            match self.apply_action(actor, a) {
                Ok(Some(id)) => {
                    outcome.minted.push(id);
                    outcome.applied += 1;
                }
                Ok(None) => outcome.applied += 1,
                Err(e) => {
                    outcome.error = Some(e);
                    break;
                }
            }
        }
        outcome
    }

    pub(crate) fn night_seed(&self) -> u64 {
        let mut input = env::random_seed();
        input.extend_from_slice(&self.night.to_le_bytes());
        let digest = env::sha256_array(&input);
        u64::from_le_bytes(digest[..8].try_into().unwrap_or_else(|_| env::abort()))
    }
}

pub(crate) fn parse_hex<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != N * 2 {
        return None;
    }
    let digit = |b: u8| match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        _ => None,
    };
    let bytes = s.as_bytes();
    let mut out = [0u8; N];
    for i in 0..N {
        out[i] = digit(bytes[i * 2])? << 4 | digit(bytes[i * 2 + 1])?;
    }
    Some(out)
}

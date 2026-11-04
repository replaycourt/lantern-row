//! Shared harness: the real contract in the SDK's mock VM, a clock, and players with real keys.
#![allow(dead_code)]

use ed25519_dalek::{Signer, SigningKey};
use lantern_row::config::*;
use lantern_row::market::Rng;
use lantern_row::types::*;
use lantern_row::views::*;
use lantern_row::{LanternRow, signing_message};
use near_parameters::RuntimeFeesConfig;
use near_parameters::vm::Config as VmConfig;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{AccountId, Gas, MockedBlockchain, NearToken, testing_env};
use std::sync::OnceLock;

pub const CONTRACT: &str = "row.testnet";

pub fn contract_id() -> AccountId {
    CONTRACT.parse().unwrap()
}

pub fn acc(name: &str) -> AccountId {
    name.parse().unwrap()
}

/// A wallet-free player: a local ed25519 key and the implicit account it implies.
pub struct Key {
    pub sk: SigningKey,
    pub hex: String,
    pub account: AccountId,
    pub nonce: u64,
}

impl Key {
    pub fn new(i: u32) -> Self {
        let mut seed = [0u8; 32];
        seed[..4].copy_from_slice(&i.to_le_bytes());
        seed[31] = 7;
        let sk = SigningKey::from_bytes(&seed);
        let hex: String = sk.verifying_key().to_bytes().iter().map(|b| format!("{b:02x}")).collect();
        let account = hex.parse().unwrap();
        Self { sk, hex, account, nonce: 0 }
    }

    pub fn sign(&self, contract: &str, nonce: u64, action: &str) -> String {
        let msg = signing_message(contract, nonce, action);
        self.sk.sign(msg.as_bytes()).to_bytes().iter().map(|b| format!("{b:02x}")).collect()
    }
}

pub struct Game {
    pub c: LanternRow,
    pub now_ms: u64,
    seed: Rng,
    views_left: u32,
    view_time: u64,
}

pub const START_MS: u64 = 1_800_000_000_000;

/// The SDK parses its whole runtime configuration on every default `testing_env!`, which dominates
/// long simulations. One parsed copy serves them all.
fn vm_config() -> VmConfig {
    static CONFIG: OnceLock<VmConfig> = OnceLock::new();
    CONFIG.get_or_init(near_sdk::test_vm_config).clone()
}

pub fn context(now_ms: u64, who: &AccountId, deposit: u128, seed: [u8; 32]) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .predecessor_account_id(who.clone())
        .signer_account_id(who.clone())
        .block_timestamp(now_ms * 1_000_000)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(300))
        .random_seed(seed);
    testing_env!(b.build(), vm_config(), RuntimeFeesConfig::test());
}

/// Throws away everything in the mock VM, including what a previous game left in its storage.
fn fresh_chain() {
    near_sdk::env::set_blockchain_interface(MockedBlockchain::new(
        VMContextBuilder::new().build(),
        vm_config(),
        RuntimeFeesConfig::test(),
        Vec::new(),
        Default::default(),
        Default::default(),
        None,
    ));
}

impl Game {
    pub fn new() -> Self {
        Self::with_seed(42)
    }

    pub fn with_seed(seed: u64) -> Self {
        let mut rng = Rng(seed);
        fresh_chain();
        context(START_MS, &contract_id(), 0, seed32(&mut rng));
        let c = LanternRow::new();
        Self { c, now_ms: START_MS, seed: rng, views_left: 0, view_time: 0 }
    }

    /// Sets the mock VM up for one call by `who`.
    pub fn as_(&mut self, who: &AccountId) {
        self.as_paying(who, 0);
    }

    pub fn as_paying(&mut self, who: &AccountId, yocto: u128) {
        let seed = seed32(&mut self.seed);
        context(self.now_ms, who, yocto, seed);
        self.views_left = 40;
        self.view_time = self.now_ms;
    }

    pub fn play(&mut self, who: &AccountId, action: &str) -> ActOutcome {
        self.as_(who);
        self.c.play(action.to_string())
    }

    /// Plays and insists nothing was refused.
    pub fn ok(&mut self, who: &AccountId, action: &str) -> ActOutcome {
        let out = self.play(who, action);
        assert_eq!(out.error, None, "refused: {action}");
        out
    }

    /// Plays one action and returns the refusal text.
    pub fn refused(&mut self, who: &AccountId, action: &str) -> String {
        let out = self.play(who, action);
        assert_eq!(out.applied, 0, "should have been refused: {action}");
        out.error.expect("a refusal")
    }

    /// Signs with the key's next nonce and sends it through `act`, relayed by a gas account.
    pub fn act(&mut self, key: &mut Key, action: &str) -> ActOutcome {
        key.nonce += 1;
        let sig = key.sign(CONTRACT, key.nonce, action);
        self.as_(&acc("gas.testnet"));
        self.c.act(key.hex.clone(), key.nonce, action.to_string(), sig)
    }

    pub fn found(&mut self, who: &AccountId, name: &str) -> u32 {
        let out = self.ok(who, &format!(r#"[{{"found":{{"name":"{name}"}}}}]"#));
        out.minted[0]
    }

    pub fn tick(&mut self, ms: u64) {
        self.now_ms += ms;
    }

    /// Lets one night pass and ends it.
    pub fn next_night(&mut self) -> AdvanceOutcome {
        self.now_ms += NIGHT_MS;
        self.advance()
    }

    pub fn nights(&mut self, n: u32) {
        for _ in 0..n {
            self.next_night();
        }
    }

    pub fn advance(&mut self) -> AdvanceOutcome {
        self.as_(&acc("anyone.testnet"));
        self.c.advance_night()
    }

    /// A context for a view. Setting up the mock VM is what makes long simulations slow, so views
    /// share one until the mock's gas meter needs a reset.
    fn viewer(&mut self) {
        self.views_left = self.views_left.saturating_sub(1);
        if self.views_left == 0 || self.view_time != self.now_ms {
            self.as_(&acc("viewer.testnet"));
            self.views_left = 40;
            self.view_time = self.now_ms;
        }
    }

    pub fn world(&mut self) -> WorldView {
        self.viewer();
        self.c.world()
    }

    pub fn stall(&mut self, id: u32) -> StallView {
        self.viewer();
        self.c.stall(id).expect("stall exists")
    }

    pub fn audit(&mut self) -> AuditView {
        self.viewer();
        self.c.audit()
    }

    pub fn assert_conserved(&mut self) {
        let a = self.audit();
        assert_eq!(a.total, FOUNDING_MONEY, "coin appeared or vanished: {a:?}");
    }

    pub fn purse(&mut self, who: &AccountId) -> u64 {
        self.as_(who);
        self.c.player(who.clone()).purse
    }

    /// Stall with some money and stock: a shortcut for the tests that are about something else.
    pub fn stocked(&mut self, who: &AccountId, name: &str) -> u32 {
        let id = self.found(who, name);
        self.ok(who, &format!(
            r#"[{{"buy":{{"stall":{id},"good":0,"qty":5,"max_cost":100000}}}},{{"price":{{"stall":{id},"good":0,"price":55}}}}]"#
        ));
        id
    }
}

fn seed32(rng: &mut Rng) -> [u8; 32] {
    let mut s = [0u8; 32];
    for chunk in s.chunks_mut(8) {
        chunk.copy_from_slice(&rng.next().to_le_bytes());
    }
    s
}

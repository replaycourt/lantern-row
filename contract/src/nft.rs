//! The stall as a token: NEP-171 core, NEP-177 metadata computed live from the stall, NEP-178
//! approvals, NEP-181 enumeration and NEP-199 payouts. Money, stock, reputation and spot live under
//! the token id, so moving the token moves all of it.

use crate::config::*;
use crate::market::*;
use crate::{LanternRow, LanternRowExt};
use near_contract_standards::non_fungible_token::events::NftTransfer;
use near_contract_standards::non_fungible_token::metadata::{NFT_METADATA_SPEC, NFTContractMetadata, TokenMetadata};
use near_contract_standards::non_fungible_token::Token;
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{AccountId, Gas, NearToken, Promise, PromiseOrValue, assert_one_yocto, env, ext_contract, near, require, serde_json};
use std::collections::HashMap;

const GAS_RECEIVER: Gas = Gas::from_tgas(35);
const GAS_RESOLVE: Gas = Gas::from_tgas(15);
const GAS_ON_APPROVE: Gas = Gas::from_tgas(15);

#[ext_contract(ext_nft_receiver)]
pub trait NftReceiver {
    fn nft_on_transfer(&mut self, sender_id: AccountId, previous_owner_id: AccountId, token_id: String, msg: String) -> PromiseOrValue<bool>;
}

#[ext_contract(ext_nft_approval_receiver)]
pub trait NftApprovalReceiver {
    fn nft_on_approve(&mut self, token_id: String, owner_id: AccountId, approval_id: u64, msg: String);
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payout {
    pub payout: HashMap<AccountId, U128>,
}

fn parse_id(token_id: &str) -> u32 {
    token_id.parse().unwrap_or_else(|_| env::panic_str("token not found"))
}

fn assert_at_least_one_yocto() {
    require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "requires at least one yoctoNEAR");
}

impl LanternRow {
    /// Moves a token between accounts. Refuses before changing anything.
    pub(crate) fn move_token(&mut self, id: u32, to: &AccountId) -> Result<(), String> {
        let from = self.deeds.get(&id).ok_or("no such stall")?.owner.clone();
        let known = self.players.get(to).cloned();
        if known.is_none() && self.accounts.len() >= MAX_ACCOUNTS {
            return Err("the town register is full".to_string());
        }
        let mut record = known.clone().unwrap_or_default();
        if record.tokens.len() >= MAX_TOKENS_PER_ACCOUNT {
            return Err("that account holds too many stalls".to_string());
        }
        record.tokens.push(id);
        self.players.insert(to.clone(), record);
        if known.is_none() {
            self.accounts.push(to.clone());
        }
        if let Some(p) = self.players.get_mut(&from) {
            p.tokens.retain(|t| *t != id);
        }
        let night = self.night;
        let deed = self.deeds.get_mut(&id).ok_or("no such stall")?;
        deed.owner = to.clone();
        deed.approvals.clear();
        deed.holders.push(from);
        if deed.holders.len() > MAX_HOLDER_HISTORY {
            deed.holders.remove(0);
        }
        self.listings.retain(|l| l.0 != id);
        if let Some(s) = self.stalls.get_mut(&id) {
            // The new owner gets the full grace period before the stall counts as idle.
            s.last_action = night;
        }
        Ok(())
    }

    /// NEP-171 authorisation: the owner, or an approved account with the matching approval id.
    fn authorise(&self, id: u32, approval_id: Option<u64>) -> (AccountId, Vec<(AccountId, u64)>, Option<AccountId>) {
        let deed = self.deeds.get(&id).unwrap_or_else(|| env::panic_str("token not found"));
        let sender = env::predecessor_account_id();
        let authorised = if sender == deed.owner {
            None
        } else {
            let approved = deed.approvals.iter().find(|a| a.0 == sender);
            let Some(a) = approved else { env::panic_str("unauthorized") };
            if approval_id.is_some_and(|want| want != a.1) {
                env::panic_str("wrong approval id");
            }
            Some(sender)
        };
        (deed.owner.clone(), deed.approvals.clone(), authorised)
    }

    fn transfer_checked(&mut self, receiver_id: &AccountId, id: u32, approval_id: Option<u64>, memo: Option<&str>) -> (AccountId, Vec<(AccountId, u64)>) {
        let (owner, approvals, authorised) = self.authorise(id, approval_id);
        require!(&owner != receiver_id, "the token owner and the receiver should be different");
        self.move_token(id, receiver_id).unwrap_or_else(|e| env::panic_str(&e));
        let token = id.to_string();
        NftTransfer {
            old_owner_id: &owner,
            new_owner_id: receiver_id,
            token_ids: &[token.as_str()],
            authorized_id: authorised.as_ref().map(|a| a.as_ref()),
            memo,
        }
        .emit();
        (owner, approvals)
    }

    fn payout_of(&self, id: u32, balance: u128, max_len: Option<u32>) -> Payout {
        let deed = self.deeds.get(&id).unwrap_or_else(|| env::panic_str("token not found"));
        let cut = balance.saturating_mul(ROYALTY_BPS) / 10_000;
        let mut payout = HashMap::new();
        if deed.founder == deed.owner || cut == 0 {
            payout.insert(deed.owner.clone(), U128(balance));
        } else {
            require!(max_len.is_none_or(|m| m >= 2), "the payout needs at least 2 entries");
            payout.insert(deed.founder.clone(), U128(cut));
            payout.insert(deed.owner.clone(), U128(balance - cut));
        }
        Payout { payout }
    }

    pub(crate) fn token_view(&self, id: u32) -> Option<Token> {
        let deed = self.deeds.get(&id)?;
        let s = self.stalls.get(&id)?;
        let approvals: HashMap<AccountId, u64> = deed.approvals.iter().cloned().collect();
        let held: u32 = s.stock.iter().sum();
        let worth = net_worth(s.money, &s.stock, s.tier, s.spot);
        let place = if s.spot == NO_SPOT {
            "No spot on the row".to_string()
        } else {
            format!("Spot {} of {} (walk-by {}%)", s.spot, ROW_SPOTS, footfall(s.spot))
        };
        let description = format!(
            "{place}. Money {}, goods {held}, reputation {}/100, size {}, net worth {worth}. Served {} customers. All of this moves with the token.",
            s.money,
            s.rep / 10,
            s.tier + 1,
            s.customers,
        );
        let extra = serde_json::to_string(&self.stall_view(id)).ok();
        let svg = stall_svg(id, &deed.name, s.tier, s.rep, s.money, held, s.spot);
        let media_hash = env::sha256(svg.as_bytes());
        Some(Token {
            token_id: id.to_string(),
            owner_id: deed.owner.clone(),
            metadata: Some(TokenMetadata {
                title: Some(format!("Stall {id}: {}", deed.name)),
                description: Some(description),
                media: Some(format!("data:image/svg+xml,{}", percent_encode(&svg))),
                media_hash: Some(Base64VecU8(media_hash)),
                copies: Some(1),
                issued_at: None,
                expires_at: None,
                starts_at: None,
                updated_at: None,
                extra,
                reference: None,
                reference_hash: None,
            }),
            approved_account_ids: Some(approvals),
        })
    }
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + s.len() / 4);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b" -_.~/=:;,()'".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// A picture of the stall, redrawn from its state: one lantern per size, brighter with reputation.
fn stall_svg(id: u32, name: &str, tier: u8, rep: u16, money: u64, goods: u32, spot: u8) -> String {
    let glow = 40 + (rep as u32 * 60) / REP_MAX as u32;
    let mut lanterns = String::new();
    for i in 0..=tier as u32 {
        let x = 40 + i * 70;
        lanterns.push_str(&format!(
            "<line x1='{x}' y1='60' x2='{x}' y2='84' stroke='black'/><ellipse cx='{x}' cy='100' rx='18' ry='22' fill='orange' fill-opacity='0.{:02}'/>",
            glow.min(99)
        ));
    }
    let place = if spot == NO_SPOT { "no spot".to_string() } else { format!("spot {spot}") };
    format!(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 280 280'><rect width='280' height='280' fill='midnightblue'/><path d='M10 60 L140 14 L270 60 Z' fill='firebrick'/>{lanterns}<rect x='30' y='170' width='220' height='60' fill='saddlebrown'/><text x='140' y='150' text-anchor='middle' fill='white' font-size='18'>{name}</text><text x='140' y='198' text-anchor='middle' fill='white' font-size='13'>Stall {id}, {place}</text><text x='140' y='220' text-anchor='middle' fill='white' font-size='13'>{money} coin, {goods} goods</text></svg>"
    )
}

#[near]
impl LanternRow {
    // ---- NEP-171 ------------------------------------------------------------------------------

    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>) {
        assert_one_yocto();
        self.transfer_checked(&receiver_id, parse_id(&token_id), approval_id, memo.as_deref());
    }

    #[payable]
    pub fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>, msg: String) -> PromiseOrValue<bool> {
        assert_one_yocto();
        require!(env::prepaid_gas() > GAS_RECEIVER.saturating_add(GAS_RESOLVE).saturating_add(Gas::from_tgas(10)), "more gas is required");
        let sender = env::predecessor_account_id();
        let id = parse_id(&token_id);
        let (owner, approvals) = self.transfer_checked(&receiver_id, id, approval_id, memo.as_deref());
        let approved: HashMap<AccountId, u64> = approvals.into_iter().collect();
        ext_nft_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_RECEIVER)
            .nft_on_transfer(sender, owner.clone(), token_id.clone(), msg)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_RESOLVE).nft_resolve_transfer(owner, receiver_id, token_id, Some(approved)))
            .into()
    }

    /// Returns true if the token stayed with the receiver.
    #[private]
    pub fn nft_resolve_transfer(&mut self, previous_owner_id: AccountId, receiver_id: AccountId, token_id: String, approved_account_ids: Option<HashMap<AccountId, u64>>) -> bool {
        let wants_back = match env::promise_result_checked(0, 16) {
            Ok(value) => serde_json::from_slice::<bool>(&value).unwrap_or(true),
            Err(_) => true,
        };
        if !wants_back {
            return true;
        }
        let id = parse_id(&token_id);
        match self.deeds.get(&id) {
            Some(d) if d.owner == receiver_id => {}
            // The receiver already passed it on; the token stays where it went.
            _ => return true,
        }
        if self.move_token(id, &previous_owner_id).is_err() {
            return true;
        }
        let deed = self.deeds.get_mut(&id).unwrap_or_else(|| env::panic_str("token not found"));
        // The bounce is not a real change of hands, and the approvals come back with the token.
        deed.holders.pop();
        deed.holders.pop();
        if let Some(a) = approved_account_ids {
            deed.approvals = a.into_iter().collect();
        }
        NftTransfer {
            old_owner_id: &receiver_id,
            new_owner_id: &previous_owner_id,
            token_ids: &[token_id.as_str()],
            authorized_id: None,
            memo: Some("returned by the receiver"),
        }
        .emit();
        false
    }

    pub fn nft_token(&self, token_id: String) -> Option<Token> {
        self.token_view(token_id.parse().ok()?)
    }

    // ---- NEP-177 ------------------------------------------------------------------------------

    pub fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Lantern Row Stalls".to_string(),
            symbol: "STALL".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }

    // ---- NEP-178 ------------------------------------------------------------------------------

    #[payable]
    pub fn nft_approve(&mut self, token_id: String, account_id: AccountId, msg: Option<String>) -> Option<Promise> {
        assert_at_least_one_yocto();
        let id = parse_id(&token_id);
        let deed = self.deeds.get_mut(&id).unwrap_or_else(|| env::panic_str("token not found"));
        require!(env::predecessor_account_id() == deed.owner, "only the owner can approve");
        let approval_id = deed.next_approval_id;
        deed.next_approval_id += 1;
        if let Some(a) = deed.approvals.iter_mut().find(|a| a.0 == account_id) {
            a.1 = approval_id;
        } else {
            require!(deed.approvals.len() < MAX_APPROVALS, "too many approvals on this token");
            deed.approvals.push((account_id.clone(), approval_id));
        }
        let owner = deed.owner.clone();
        msg.map(|m| ext_nft_approval_receiver::ext(account_id).with_static_gas(GAS_ON_APPROVE).nft_on_approve(token_id, owner, approval_id, m))
    }

    #[payable]
    pub fn nft_revoke(&mut self, token_id: String, account_id: AccountId) {
        assert_one_yocto();
        let id = parse_id(&token_id);
        let deed = self.deeds.get_mut(&id).unwrap_or_else(|| env::panic_str("token not found"));
        require!(env::predecessor_account_id() == deed.owner, "only the owner can revoke");
        deed.approvals.retain(|a| a.0 != account_id);
    }

    #[payable]
    pub fn nft_revoke_all(&mut self, token_id: String) {
        assert_one_yocto();
        let id = parse_id(&token_id);
        let deed = self.deeds.get_mut(&id).unwrap_or_else(|| env::panic_str("token not found"));
        require!(env::predecessor_account_id() == deed.owner, "only the owner can revoke");
        deed.approvals.clear();
    }

    pub fn nft_is_approved(&self, token_id: String, approved_account_id: AccountId, approval_id: Option<u64>) -> bool {
        let deed = self.deeds.get(&parse_id(&token_id)).unwrap_or_else(|| env::panic_str("token not found"));
        deed.approvals.iter().any(|a| a.0 == approved_account_id && approval_id.is_none_or(|want| want == a.1))
    }

    // ---- NEP-181 ------------------------------------------------------------------------------

    pub fn nft_total_supply(&self) -> U128 {
        U128(self.minted as u128)
    }

    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        let from = from_index.map_or(0, |f| f.0.min(u32::MAX as u128) as u32);
        let limit = limit.unwrap_or(50).min(100) as u32;
        (from..self.minted).take(limit as usize).filter_map(|i| self.token_view(i + 1)).collect()
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        U128(self.players.get(&account_id).map_or(0, |p| p.tokens.len() as u128))
    }

    pub fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        let Some(p) = self.players.get(&account_id) else {
            return Vec::new();
        };
        let from = from_index.map_or(0, |f| f.0.min(u32::MAX as u128) as usize);
        let limit = limit.unwrap_or(50).min(100) as usize;
        p.tokens.iter().skip(from).take(limit).filter_map(|&id| self.token_view(id)).collect()
    }

    // ---- NEP-199 ------------------------------------------------------------------------------

    /// How a NEAR sale of this stall at a marketplace splits: the founder gets the royalty.
    pub fn nft_payout(&self, token_id: String, balance: U128, max_len_payout: Option<u32>) -> Payout {
        self.payout_of(parse_id(&token_id), balance.0, max_len_payout)
    }

    #[payable]
    pub fn nft_transfer_payout(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>, balance: U128, max_len_payout: Option<u32>) -> Payout {
        assert_one_yocto();
        let id = parse_id(&token_id);
        let payout = self.payout_of(id, balance.0, max_len_payout);
        self.transfer_checked(&receiver_id, id, approval_id, memo.as_deref());
        payout
    }
}

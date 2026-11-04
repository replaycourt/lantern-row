#!/usr/bin/env node
// Shows the token behaving as an account on testnet: a sale on the row, a resale that pays the founder
// their royalty, a purse collected into a new stall, and a real `nft_transfer` by a funded implicit account.
//   node scripts/testnet-nft-demo.mjs <contract> <gas account>
// Needs the player created by testnet-play.mjs: it pays with coin its stall has earned.
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Signer, hex, keyFromNearString, keyFromSeed, newKey, sign, tgas, view } from './near-lite.mjs'

const [contract, gasAccount] = process.argv.slice(2)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pool = JSON.parse(readFileSync(join(root, '.secrets', 'gas-pool.json'), 'utf8')).filter((k) => k.contract === contract)
const payers = pool.map((k) => new Signer(k.account, keyFromNearString(k.private_key)))
let next = 0
const payer = () => payers[next++ % payers.length]
const sleep = (ms) => new Promise((s) => setTimeout(s, ms))
const settled = async () => sleep(2500) // views can lag a moment behind an executed transaction

function player(key) {
  return { key, account: hex(key.publicKey) }
}

function report(label, r) {
  console.log(`${label.padEnd(50)} ${tgas(r.gas).padStart(6)} Tgas  ${r.hash}${r.failure ? '  FAILED ' + r.failure : ''}`)
}

// The local nonce is the truth: a view right after a transaction can lag behind it.
async function nextNonce(p) {
  if (p.nonce === undefined) p.nonce = (await view(contract, 'player', { account: p.account })).nonce
  p.nonce += 1
  return p.nonce
}

async function act(p, label, actions) {
  const nonce = await nextNonce(p)
  const action = JSON.stringify(actions)
  const signature = hex(sign(p.key, Buffer.from(`lantern-row:v1:${contract}:${nonce}:${action}`, 'utf8')))
  const r = await payer().call(contract, 'act', { player_pubkey: p.account, nonce, action, signature }, { gas: 30_000_000_000_000n })
  report(label, r)
  if (r.value?.error) throw new Error(`refused: ${r.value.error}`)
  return r.value
}

async function found(p, name) {
  for (let i = 0; i < 4; i++) {
    const nonce = await nextNonce(p)
    const action = JSON.stringify([{ found: { name } }])
    const signature = hex(sign(p.key, Buffer.from(`lantern-row:v1:${contract}:${nonce}:${action}`, 'utf8')))
    const r = await payer().call(contract, 'act', { player_pubkey: p.account, nonce, action, signature }, { gas: 30_000_000_000_000n })
    report(`found "${name}"`, r)
    if (r.value?.minted?.length) return r.value.minted[0]
    console.log(`  ${r.value?.error}`)
    await sleep(21_000)
    await payer().call(contract, 'advance_night', {}, { gas: 150_000_000_000_000n })
  }
  throw new Error('could not found a stall')
}

const a = player(keyFromSeed(Buffer.from(JSON.parse(readFileSync(join(root, '.secrets', `players-${contract}.json`), 'utf8')).seed, 'hex')))
const b = player(newKey())
const c = player(newKey())
writeFileSync(join(root, '.secrets', `demo-players-${contract}.json`), JSON.stringify({ b: hex(b.key.seed), c: hex(c.key.seed) }) + '\n', { mode: 0o600 })
const aStall = (await view(contract, 'player', { account: a.account })).stalls[0]
console.log(`A ${a.account} stall ${aStall.id}: money ${aStall.money}, earned ${aStall.earned}`)

const bStall = await found(b, 'Founded By B')
console.log(`B ${b.account} founded stall ${bStall}`)
await act(b, 'B lists it for 300', [{ list: { stall: bStall, price: 300 } }])
await act(a, 'A buys it with the coin its stall earned', [{ buy_stall: { with: aStall.id, target: bStall, max_price: 300, min_money: 0 } }])
await settled()
let t = await view(contract, 'stall', { id: bStall })
console.log(`stall ${bStall} now belongs to A: ${t.owner === a.account}, still holds its ${t.money} coin, holders ${JSON.stringify(t.holders)}`)
console.log(`B's purse: ${(await view(contract, 'player', { account: b.account })).purse} (300 less 5% tax; B founded it, so the royalty is B's too)`)

// C needs earned coin to buy with: C sells a stall to A, and collects the proceeds into a new one.
const cFirst = await found(c, 'First Of C')
await act(c, 'C lists its stall for 250', [{ list: { stall: cFirst, price: 250 } }])
await act(a, 'A buys that too', [{ buy_stall: { with: aStall.id, target: cFirst, max_price: 250, min_money: 0 } }])
const cSecond = await found(c, 'Second Of C')
await act(c, 'C collects its purse into the new stall', [{ collect: { stall: cSecond } }])
await settled()
console.log(`C's new stall: ${JSON.stringify((({ money, earned }) => ({ money, earned }))(await view(contract, 'stall', { id: cSecond })))}`)

await settled()
const purseBefore = (await view(contract, 'player', { account: b.account })).purse
await act(a, "A resells B's stall for 100", [{ list: { stall: bStall, price: 100 } }])
await act(c, 'C buys it: the founder B gets the royalty', [{ buy_stall: { with: cSecond, target: bStall, max_price: 100, min_money: 0 } }])
await settled()
const purseAfter = (await view(contract, 'player', { account: b.account })).purse
console.log(`B's purse ${purseBefore} -> ${purseAfter}: the 5% founder royalty on a sale B was not part of`)

// A real NEP-171 transfer by an implicit account that holds its key and some NEAR.
const payout = await view(contract, 'nft_payout', { token_id: String(bStall), balance: '1000000', max_len_payout: 5 })
console.log(`NEP-199 payout of 1000000 for stall ${bStall}: ${JSON.stringify(payout.payout)}`)
const funder = new Signer(gasAccount, keyFromNearString(JSON.parse(readFileSync(join(homedir(), '.near-credentials', 'testnet', `${gasAccount}.json`), 'utf8')).private_key))
report('the gas account funds C with 0.1 NEAR', await funder.transfer(c.account, 100_000_000_000_000_000_000_000n))
await sleep(3000)
const before = await view(contract, 'stall', { id: bStall })
const direct = new Signer(c.account, c.key)
const r = await direct.call(contract, 'nft_transfer', { receiver_id: b.account, token_id: String(bStall), approval_id: null, memo: 'home again' }, { gas: 30_000_000_000_000n, deposit: 1n })
report(`C sends stall ${bStall} home with nft_transfer`, r)
for (const l of r.logs) if (l.startsWith('EVENT_JSON')) console.log(`  ${l}`)
await settled()
const after = await view(contract, 'stall', { id: bStall })
console.log(`owner is B again: ${after.owner === b.account}; money ${before.money} -> ${after.money}, rep ${before.rep} -> ${after.rep}, spot ${before.spot} -> ${after.spot}, holders ${JSON.stringify(after.holders)}`)
const token = await view(contract, 'nft_token', { token_id: String(bStall) })
console.log(`nft_token title: ${token.metadata.title}`)
console.log(`nft_token description: ${token.metadata.description}`)
const audit = await view(contract, 'audit')
console.log('audit', JSON.stringify(audit))
console.log(audit.total === audit.founding ? 'conservation holds on chain' : 'CONSERVATION BROKEN')

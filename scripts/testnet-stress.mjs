#!/usr/bin/env node
// Measures the worst case on a throwaway instance: every spot on the row taken, every stall stocked
// and cheap, then a normal night and a full catch-up.
//   node scripts/testnet-stress.mjs <contract> <path to the signer's key file>
// The signer is the instance's own account: this instance is only for measuring.
import { readFileSync } from 'node:fs'
import { Signer, hex, keyFromNearString, newKey, sign, tgas, view } from './near-lite.mjs'

const [contract, keyFile] = process.argv.slice(2)
const signer = new Signer(contract, keyFromNearString(JSON.parse(readFileSync(keyFile, 'utf8')).private_key))
const sleep = (ms) => new Promise((s) => setTimeout(s, ms))
const rows = []

function report(label, r) {
  rows.push({ label, gas: r.gas, hash: r.hash })
  console.log(`${label.padEnd(44)} ${tgas(r.gas).padStart(7)} Tgas  ${r.hash}${r.failure ? '  FAILED ' + r.failure : ''}`)
}

const players = []
async function act(p, label, actions) {
  p.nonce += 1
  const action = JSON.stringify(actions)
  const signature = hex(sign(p.key, Buffer.from(`lantern-row:v1:${contract}:${p.nonce}:${action}`, 'utf8')))
  const r = await signer.call(contract, 'act', { player_pubkey: hex(p.key.publicKey), nonce: p.nonce, action, signature }, { gas: 50_000_000_000_000n })
  report(label, r)
  if (r.value?.error) console.log(`  refused: ${r.value.error}`)
  return r.value
}

async function advance(label) {
  const r = await signer.call(contract, 'advance_night', {}, { gas: 300_000_000_000_000n })
  report(`${label} (+${r.value?.advanced}, slept ${r.value?.slept})`, r)
}

async function waitDue() {
  for (;;) {
    const w = await view(contract, 'world')
    if (w.due) return
    await sleep(Math.min(Math.max(w.ends_ms - w.now_ms, 300), 3000))
  }
}

const cfg = await view(contract, 'config')
let w = await view(contract, 'world')
const free = cfg.spots.length - w.row.length
console.log(`filling ${free} free spots`)
for (let i = 0; i < free; i++) {
  if ((await view(contract, 'world')).licences_tonight === 0) {
    await waitDue()
    await advance('advance_night while filling')
  }
  const p = { key: newKey(), nonce: 0, id: 0 }
  const out = await act(p, `found stall ${i}`, [{ found: { name: `Stress ${i}` } }])
  p.id = out.minted[0]
  players.push(p)
}

async function stockEveryone(tag) {
  w = await view(contract, 'world')
  for (const p of players) {
    const g = p.id % cfg.goods.length
    const cheap = w.dock[g].price
    const actions = []
    for (let good = 0; good < cfg.goods.length; good++) actions.push({ price: { stall: p.id, good, price: Math.max(1, Math.floor(cfg.goods[good].fair * 0.7)) } })
    if (w.dock[2].left > 3) actions.push({ buy: { stall: p.id, good: 2, qty: 2, max_cost: 100000 } })
    if (w.dock[0].left > 3) actions.push({ buy: { stall: p.id, good: 0, qty: 1, max_cost: 100000 } })
    if (w.dock[g].left > 3 && cheap < 150) actions.push({ buy: { stall: p.id, good: g, qty: 1, max_cost: 100000 } })
    await act(p, `${tag} stall ${p.id}: ${actions.length} actions`, actions)
    w = await view(contract, 'world')
  }
}

await stockEveryone('stock')
await waitDue()
await advance('advance_night, full row, one night')
await stockEveryone('restock')
const started = (await view(contract, 'world')).ends_ms
const waitMs = Math.max(0, started - Date.now()) + (cfg.max_catchup_nights - 1) * cfg.night_ms + 3000
console.log(`waiting ${Math.round(waitMs / 1000)} s for a full catch-up to be due`)
await sleep(waitMs)
await advance('advance_night, full row, full catch-up')
await sleep((cfg.max_catchup_nights + 3) * cfg.night_ms)
await advance('advance_night, more than a full catch-up')

const audit = await view(contract, 'audit')
console.log('audit', JSON.stringify(audit))
const summary = rows.filter((r) => r.label.startsWith('advance'))
console.log(JSON.stringify(summary, null, 1))
const account = await signer.key
void account

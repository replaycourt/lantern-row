#!/usr/bin/env node
// Plays real nights on testnet the way a client would: a local player key signs, a pool key pays.
//   node scripts/testnet-play.mjs <contract> <nights> [--catch-up <nights>]
// Prints one line per transaction with hash and gas, and a summary at the end.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Signer, hex, keyFromNearString, keyFromSeed, newKey, sign, tgas, view } from './near-lite.mjs'

const args = process.argv.slice(2)
const contract = args[0]
const nights = Number(args[1] ?? 4)
const catchUpIdx = args.indexOf('--catch-up')
const catchUp = catchUpIdx >= 0 ? Number(args[catchUpIdx + 1]) : 0

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pool = JSON.parse(readFileSync(join(root, '.secrets', 'gas-pool.json'), 'utf8')).filter((k) => k.contract === contract)
const payers = pool.map((k) => new Signer(k.account, keyFromNearString(k.private_key)))
let next = 0
const payer = () => payers[next++ % payers.length]

const playersFile = join(root, '.secrets', `players-${contract}.json`)
mkdirSync(dirname(playersFile), { recursive: true })
function loadPlayer() {
  if (existsSync(playersFile)) return keyFromSeed(Buffer.from(JSON.parse(readFileSync(playersFile, 'utf8')).seed, 'hex'))
  const k = newKey()
  writeFileSync(playersFile, JSON.stringify({ seed: hex(k.seed) }) + '\n', { mode: 0o600 })
  return k
}

const sleep = (ms) => new Promise((s) => setTimeout(s, ms))
const player = loadPlayer()
const account = hex(player.publicKey)
const results = []

function report(label, r) {
  results.push({ label, ...r })
  console.log(`${label.padEnd(34)} ${tgas(r.gas).padStart(7)} Tgas  ${r.hash}${r.failure ? '  FAILED ' + r.failure : ''}`)
}

// The local nonce is the truth: a view right after a transaction can lag behind it.
let lastNonce = (await view(contract, 'player', { account })).nonce

async function act(label, actions) {
  const nonce = ++lastNonce
  const action = JSON.stringify(actions)
  const message = `lantern-row:v1:${contract}:${nonce}:${action}`
  const signature = hex(sign(player, Buffer.from(message, 'utf8')))
  const r = await payer().call(contract, 'act', { player_pubkey: account, nonce, action, signature }, { gas: 30_000_000_000_000n })
  report(label, r)
  if (r.value?.error) console.log(`  refused: ${r.value.error}`)
  return r.value
}

async function advance(label) {
  const r = await payer().call(contract, 'advance_night', {}, { gas: 150_000_000_000_000n })
  report(`${label} (+${r.value?.advanced ?? '?'}, slept ${r.value?.slept ?? '?'})`, r)
  return r.value
}

// The same attentive player the economy simulation calls the Trader.
function decide(w, cfg, s) {
  const MIX = [8, 5, 10, 2, 3]
  const acts = []
  let room = s.capacity - s.stock.reduce((a, b) => a + b, 0)
  let money = s.money
  cfg.goods.forEach((good, g) => {
    const unit = w.dock[g].price
    const rivals = w.row.filter((x) => x.id !== s.id && x.stock[g] > 0 && x.price[g] > 0).map((x) => x.price[g])
    const rival = rivals.length ? Math.floor((Math.min(...rivals) * 97) / 100) : Math.floor((good.fair * 140) / 100)
    const floor = Math.max(Math.floor((unit * 125) / 100), Math.floor((good.fair * 95) / 100))
    let p = Math.min(Math.max(rival, floor), Math.max(floor, Math.floor((good.fair * 140) / 100)))
    const soon = w.event_left === 1
    const festivalNext = soon && w.event_next.festival?.good === g
    const stormNext = soon && w.event_next.storm?.good === g
    if (w.event.festival?.good === g) p = Math.floor((p * 125) / 100)
    if (w.event.storm?.good === g) p = Math.floor((p * 130) / 100)
    if (p !== s.price[g]) acts.push({ price: { stall: s.id, good: g, price: p } })
    const target = Math.floor(MIX[g] * (1 + s.tier / 2) * (festivalNext ? 2 : stormNext ? 1.5 : 1))
    const qty = Math.min(Math.max(0, target - s.stock[g]), room, w.dock[g].left, Math.floor((money * 0.3) / Math.max(unit, 1)))
    if (qty > 0 && (unit * 110) / 100 < p) {
      acts.push({ buy: { stall: s.id, good: g, qty, max_cost: money } })
      room -= qty
      money -= Math.ceil(qty * unit * 1.2)
    }
  })
  return acts
}

async function waitDue() {
  for (;;) {
    const w = await view(contract, 'world')
    if (w.due) return w
    await sleep(Math.min(Math.max(w.ends_ms - w.now_ms, 300), 3000))
  }
}

const cfg = await view(contract, 'config')
let me = await view(contract, 'player', { account })
if (me.stalls.length === 0) {
  const out = await act('found a stall', [{ found: { name: 'Testnet Lantern' } }])
  console.log(`  minted stall ${out.minted}`)
}
while (me.stalls.length === 0) {
  await sleep(1000)
  me = await view(contract, 'player', { account })
}
const id = me.stalls[0].id
console.log(`player ${account}, stall ${id}`)

for (let n = 0; n < nights; n++) {
  const w = await view(contract, 'world')
  const s = (await view(contract, 'player', { account })).stalls[0]
  const acts = decide(w, cfg, s).slice(0, cfg.max_actions_per_call)
  console.log(`night ${w.night}: event ${JSON.stringify(w.event)} (${w.event_left} left), next ${JSON.stringify(w.event_next)}, stall money ${s.money}, worth ${s.worth}`)
  if (acts.length) await act(`night ${w.night}: ${acts.length} actions`, acts)
  await waitDue()
  const done = await advance(`advance_night night ${w.night}`)
  let log = null
  while (!log || log.night < done.night - 1) {
    await sleep(800)
    log = await view(contract, 'night_log', {})
  }
  const sold = log.sales.filter((x) => x[1] === id).length
  console.log(`  ${log.sales.length} sales on the row, ${sold} at my stall, ${log.restocks.length} restocks, wages ${log.wages}, tax ${log.tax}`)
}

if (catchUp > 0) {
  console.log(`waiting ${catchUp} nights without calling advance_night...`)
  await sleep(catchUp * cfg.night_ms + 2000)
  await advance('advance_night catch-up')
}

const audit = await view(contract, 'audit')
console.log('audit', JSON.stringify(audit))
console.log(audit.total === audit.founding ? 'conservation holds on chain' : 'CONSERVATION BROKEN')
const board = await view(contract, 'leaderboard', { limit: 8 })
for (const r of board) console.log(`#${r.rank} ${r.name}${r.npc ? ' (npc)' : ''} worth ${r.worth}, spot ${r.spot}`)
const adv = results.filter((r) => r.label.startsWith('advance'))
const acts = results.filter((r) => !r.label.startsWith('advance'))
const stat = (xs) => (xs.length ? `${tgas(Math.min(...xs))} to ${tgas(Math.max(...xs))} Tgas over ${xs.length}` : 'none')
console.log(`act: ${stat(acts.map((r) => r.gas))}`)
console.log(`advance_night: ${stat(adv.map((r) => r.gas))}`)

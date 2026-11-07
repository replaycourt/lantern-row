#!/usr/bin/env node
// House bots and a keeper for Lantern Row, so the row stays alive while nobody plays.
//
// Five stalls named "Bot - ..." trade by fixed, readable rules (STRATEGIES below), and a keeper calls
// `advance_night` whenever a night is due, often enough that no call has more than the contract's
// 30-night catch-up to do. To the contract the bots are ordinary players: each is the implicit
// account of its own key, founded its stall with `found` and the same starter grant, and signs `act`
// exactly like a browser does. The public gas keys in web/js/gas-keys.js relay it.
//
// They are meant to be beaten. They look at their stall only every few minutes (about every 36
// nights), never grow, never move up the row, never sell their stall, and leave a quarter of the
// Dock to others. A player who watches the row night by night can out-trade them.
//
//   LANTERN_ROW_BOTS='["<64 hex seed>", ...]' node scripts/house-bots.mjs --minutes 350
//   node scripts/house-bots.mjs --dry-run        reads the chain, prints the plan, sends nothing
//
// Options: --minutes M (default 10), --keeper-every MIN (5), --bot-every MIN (12), --floor NEAR (3:
// stop when the gas account holds less, the rest is for players), --key-reserve NEAR (0.2: never
// use a gas key whose allowance is lower), --dry-run.
//
// The bot keys come only from the environment variable LANTERN_ROW_BOTS, a JSON array of hex seeds,
// never from a file in the repository. Without it the script does nothing. Each seed must belong to
// an account listed in web/js/house-bots.js, so every stall it runs is labelled on the page.
// .github/workflows/town.yml runs it on a schedule.
import { pathToFileURL } from 'node:url'
import { appendFileSync } from 'node:fs'
import { Signer, hex, keyFromNearString, keyFromSeed, rpc, sign, tgas, view } from './near-lite.mjs'
import { CONTRACT, GAS_ACCOUNT, GAS_KEYS } from '../web/js/gas-keys.js'
import { HOUSE_BOTS } from '../web/js/house-bots.js'
import { GOOD_SHORT, affordable, dockCost, validName } from '../web/js/logic.js'

const ACT_GAS = 20_000_000_000_000n // SPEC 12.1; measured 2.6 to 3.8 Tgas
const KEEPER_GAS = 30_000_000_000_000n // measured worst case: 15.4 Tgas for 30 nights on a full row
const KEEPER_GAS_RETRY = 100_000_000_000_000n
// Never spend below this. Rent never takes the last 500 coins and no rule evicts a stall for being
// poor, so a reserve above that floor stranded broke bots with no stock and no way to restock. It
// stays above the player relief threshold (100), so the bots never draw Treasury relief.
export const RESERVE_COIN = 150
const SPEND_PCT = 30 // at most this share of the stall's coin on one good per visit
const DOCK_LEAVE_PCT = 25 // leave at least this share of what the Dock has left of a good tonight
const KEEP_ALIVE_NIGHTS = 30 // act even with nothing to change once the last action is this old
const IDLE_MARGIN = 15 // act before the keeper's call would bring a stall this close to eviction
const NIGHTS_PER_FOUNDING = 1 // at most one bot founds per night, and only while 3+ licences are left
const FOUNDING_LICENCES_MIN = 3

const pct = (n, p) => Math.floor((n * p) / 100)
const pctUp = (n, p) => Math.ceil((n * p) / 100)
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi)

/**
 * The bots' rules, named after the strategies in docs/ECONOMY.md. `mix` is how many units of each
 * good (tea, lamp oil, dumplings, silk, charms) the stall refills to; `price` sets the asking price
 * from the good's fair price, tonight's Dock unit price, and the prices of the other stalls on the
 * row that have the good in stock (`rivals`, and `merchants` among them).
 */
export const STRATEGIES = {
  // Restocker: a fixed mix at the fair price.
  restocker: { mix: [10, 8, 6, 2, 4], price: ({ fair }) => fair },
  // Fixed(90): the cheap goods at 90% of fair, the best fixed level in the league table.
  discounter: { mix: [12, 8, 10, 0, 0], price: ({ fair }) => pct(fair, 90) },
  // Watcher: 3% under the cheapest rival, not below 95% of fair or 125% of the Dock, at most 140% of fair.
  watcher: {
    mix: [8, 5, 10, 2, 3],
    price: ({ fair, unit, rivals }) => {
      const floor = Math.max(pct(fair, 95), pctUp(unit, 125))
      const cap = Math.max(floor, pct(fair, 140))
      return rivals.length ? clamp(pct(Math.min(...rivals), 97), floor, cap) : cap
    },
  },
  // Shadow: 10% under the cheapest merchant that has the good, not below 110% of the Dock; the fair
  // price when no merchant has it. Players' prices do not move it.
  shadow: {
    mix: [10, 6, 6, 2, 4],
    price: ({ fair, unit, merchants }) => Math.max(merchants.length ? pct(Math.min(...merchants), 90) : fair, pctUp(unit, 110)),
  },
  // Fixed(125): the dear goods at 125% of fair.
  premium: { mix: [6, 6, 0, 3, 5], price: ({ fair }) => pct(fair, 125) },
}

/**
 * One visit of a bot to its stall: the actions it sends, in order (back onto the row if it lost its
 * spot, then prices, then Dock purchases). Pure: it reads the stall view, world() and config().
 * Empty when there is nothing to change, unless `keepAlive`, which re-sends one price so the stall
 * counts as tended and keeps its spot.
 */
export function planTurn(strategyId, stall, world, cfg, { keepAlive = false } = {}) {
  const st = STRATEGIES[strategyId]
  if (!st) throw new Error(`unknown strategy ${strategyId}`)
  const id = stall.id
  const moves = []
  const prices = []
  const buys = []
  let money = stall.money
  if (stall.spot == null) {
    const taken = new Set(world.row.map((s) => s.spot))
    const free = cfg.spots.filter((s) => !taken.has(s.spot))
    const back = free.length ? free[free.length - 1] : null // the worst free spot: the cheapest
    if (back && back.fee + RESERVE_COIN <= money) {
      moves.push({ move: { stall: id, spot: back.spot, max_fee: back.fee } })
      money -= back.fee
    }
  }
  let room = stall.capacity - stall.stock.reduce((a, b) => a + b, 0)
  cfg.goods.forEach((good, g) => {
    if (!st.mix[g]) return
    const dock = world.dock[g]
    const others = world.row.filter((s) => s.id !== id && s.stock[g] > 0 && s.price[g] > 0)
    const price = clamp(
      Math.round(st.price({ fair: good.fair, unit: dock.price, rivals: others.map((s) => s.price[g]), merchants: others.filter((s) => s.npc).map((s) => s.price[g]) })),
      1,
      good.max_price ?? good.fair * 10,
    )
    if (price !== stall.price[g]) prices.push({ price: { stall: id, good: g, price } })
    const want = st.mix[g] - stall.stock[g]
    // Buy only with a margin at tonight's Dock price, and leave part of the Dock to others.
    if (want <= 0 || room <= 0 || dock.price * 110 >= price * 100) return
    const take = Math.min(want, room, dock.left - pctUp(dock.left, DOCK_LEAVE_PCT))
    const budget = Math.min(pct(stall.money, SPEND_PCT), money - RESERVE_COIN)
    const qty = take > 0 && budget > 0 ? affordable(good, dock, budget, take) : 0
    if (qty <= 0) return
    const cost = dockCost(good, dock, qty)
    buys.push({ buy: { stall: id, good: g, qty, max_cost: pctUp(cost, 115) + 2 } })
    room -= qty
    money -= cost
  })
  const acts = [...moves, ...prices, ...buys]
  if (!acts.length && keepAlive) {
    const g = st.mix.findIndex((n) => n > 0)
    acts.push({ price: { stall: id, good: g, price: stall.price[g] || cfg.goods[g].fair } })
  }
  return acts.slice(0, cfg.max_actions_per_call ?? 16)
}

/** "price tea 60, oil 90 · buy tea 6, oil 3" */
export function describe(actions) {
  const parts = { move: [], price: [], buy: [], found: [] }
  for (const a of actions) {
    if (a.found) parts.found.push(`"${a.found.name}"`)
    if (a.move) parts.move.push(`spot ${a.move.spot}`)
    if (a.price) parts.price.push(`${GOOD_SHORT[a.price.good].toLowerCase()} ${a.price.price}`)
    if (a.buy) parts.buy.push(`${GOOD_SHORT[a.buy.good].toLowerCase()} ${a.buy.qty}`)
  }
  return Object.entries(parts)
    .filter(([, v]) => v.length)
    .map(([k, v]) => `${k} ${v.join(', ')}`)
    .join(' · ')
}

/**
 * The bots from the secret: a JSON array of 64-character hex seeds. Every seed must be the key of an
 * account listed in web/js/house-bots.js. Error messages never contain a seed.
 */
export function loadBots(text) {
  let seeds
  try {
    seeds = JSON.parse(text)
  } catch {
    throw new Error('LANTERN_ROW_BOTS is not valid JSON (expected an array of hex seeds)')
  }
  if (!Array.isArray(seeds) || !seeds.length) throw new Error('LANTERN_ROW_BOTS must be a non-empty JSON array of hex seeds')
  const bots = []
  seeds.forEach((s, i) => {
    if (typeof s !== 'string' || !/^[0-9a-fA-F]{64}$/.test(s)) throw new Error(`LANTERN_ROW_BOTS[${i}] is not a 64-character hex seed`)
    const key = keyFromSeed(Buffer.from(s, 'hex'))
    const account = hex(key.publicKey)
    const listed = HOUSE_BOTS.find((b) => b.account === account)
    if (!listed) throw new Error(`LANTERN_ROW_BOTS[${i}] belongs to ${account}, which is not in web/js/house-bots.js: refusing to run an unlabelled bot`)
    if (!bots.some((b) => b.account === account)) bots.push({ ...listed, key })
  })
  return bots
}

/** Expected NEAR per day for a pacing, from the cost of one keeper call and one bot visit. */
export function dailyCost({ keeperEvery, botEvery, bots, keeperNear, actNear }) {
  const keeperCalls = 1440 / keeperEvery
  const acts = (1440 / botEvery) * bots
  return { keeperCalls, acts, near: keeperCalls * keeperNear + acts * actNear }
}

// ---- running against the chain ------------------------------------------------------------------

class Stop extends Error {}

const sleep = (ms) => new Promise((s) => setTimeout(s, ms))
const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ')
const toNear = (yocto) => (yocto == null ? Infinity : Number(BigInt(yocto) / 10n ** 18n) / 1e6)
const fmtNear = (n) => (Number.isFinite(n) ? n.toFixed(4) : 'unlimited')

function parseArgs(argv) {
  const o = { minutes: 10, keeperEvery: 5, botEvery: 12, floor: 3, keyReserve: 0.2, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const num = () => {
      const v = Number(argv[++i])
      if (!Number.isFinite(v) || v <= 0) throw new Error(`${a} needs a positive number`)
      return v
    }
    if (a === '--dry-run') o.dryRun = true
    else if (a === '--minutes') o.minutes = num()
    else if (a === '--keeper-every') o.keeperEvery = num()
    else if (a === '--bot-every') o.botEvery = num()
    else if (a === '--floor') o.floor = num()
    else if (a === '--key-reserve') o.keyReserve = num()
    else throw new Error(`unknown option ${a}`)
  }
  return o
}

/** The public gas keys, used in turn, skipping any whose allowance is below the reserve. */
class GasPool {
  constructor(reserve) {
    this.reserve = reserve
    this.keys = GAS_KEYS.map((k) => ({ pub: k.public_key, signer: new Signer(GAS_ACCOUNT, keyFromNearString(k.private_key)), allowance: 0, start: null, burnt: 0, txs: 0, dead: false }))
    this.cursor = Math.floor(Math.random() * this.keys.length)
    this.balance = 0
  }

  async refresh() {
    const list = await rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: GAS_ACCOUNT })
    const perm = new Map(list.keys.map((k) => [k.public_key, k.access_key.permission]))
    for (const k of this.keys) {
      const p = perm.get(k.pub)
      k.allowance = p?.FunctionCall ? toNear(p.FunctionCall.allowance) : 0
      if (k.start === null) k.start = k.allowance
    }
    const acc = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: GAS_ACCOUNT })
    this.balance = toNear(acc.amount)
  }

  usable() {
    return this.keys.filter((k) => !k.dead && k.allowance >= this.reserve)
  }

  pick() {
    const n = this.keys.length
    for (let i = 0; i < n; i++) {
      const k = this.keys[(this.cursor + i) % n]
      if (!k.dead && k.allowance >= this.reserve) {
        this.cursor = (this.cursor + i + 1) % n
        return k
      }
    }
    return null
  }

  /** Sends one function call to the contract, trying another key on a nonce clash or an empty allowance. */
  async relay(method, args, gas) {
    let lastErr
    for (let attempt = 0; attempt < 4; attempt++) {
      const k = this.pick()
      if (!k) throw new Stop(`every gas key on ${GAS_ACCOUNT} has less than ${this.reserve} NEAR of allowance left: refill the pool (scripts/setup-gas-pool.mjs)`)
      // The keys are shared with players' browsers: read the key's nonce fresh for every transaction.
      k.signer.nonce = null
      try {
        const r = await k.signer.call(CONTRACT, method, args, { gas })
        k.allowance -= r.near
        k.burnt += r.near
        k.txs++
        return { ...r, key: k.pub }
      } catch (e) {
        lastErr = e
        const t = String(e?.message ?? e)
        if (/NotEnoughAllowance|AccessKeyDoesNotExist/.test(t)) k.dead = true
        else if (!/InvalidNonce|Expired|TIMEOUT|fetch failed|ECONNRESET|ETIMEDOUT|aborted|timeout/i.test(t)) throw e
        await sleep(600 + attempt * 900)
      }
    }
    throw lastErr
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv)
  const secret = (env.LANTERN_ROW_BOTS ?? '').trim()
  if (!secret && !opts.dryRun) {
    console.log('no bot keys, nothing to do')
    return 0
  }
  const bots = secret ? loadBots(secret) : HOUSE_BOTS.map((b) => ({ ...b, key: null }))
  for (const b of bots) if (!validName(b.name) || !b.name.startsWith('Bot - ')) throw new Error(`bad bot name "${b.name}"`)
  if (opts.keeperEvery * 60 > 30 * 20 * 0.9) throw new Error('--keeper-every must stay under 9 minutes: 30 nights of catch-up are 10 minutes')

  const cfg = await view(CONTRACT, 'config')
  const nightMs = cfg.night_ms
  const evictAfter = cfg.idle_evict_nights
  const pool = new GasPool(opts.keyReserve)
  await pool.refresh()
  const totalAllowance = pool.keys.reduce((a, k) => a + (Number.isFinite(k.allowance) ? k.allowance : 0), 0)
  console.log(`${stamp()} Lantern Row house bots on ${CONTRACT}${opts.dryRun ? ' (dry run: nothing is sent)' : ''}`)
  console.log(`${stamp()} gas account ${GAS_ACCOUNT}: ${fmtNear(pool.balance)} NEAR, ${pool.usable().length} of ${pool.keys.length} keys usable, allowances ${fmtNear(totalAllowance)} NEAR in total`)
  for (const b of bots) {
    const p = await view(CONTRACT, 'player', { account: b.account })
    b.nonce = p?.nonce ?? 0
    b.stall = p?.stalls?.[0] ?? null
    b.next = 0
    console.log(`${stamp()} ${b.name.padEnd(18)} ${b.strategy.padEnd(10)} ${b.account}  ${b.stall ? `stall ${b.stall.id}, ${b.stall.spot == null ? 'off the row' : `spot ${b.stall.spot}`}, ${b.stall.money} coin, worth ${b.stall.worth}` : 'no stall yet'}`)
  }

  // Cost per call, until measured in this run. Measured on testnet with 12 stalls on the row: a bot
  // visit 2.7 to 3.0 Tgas, a keeper call about 4.6 Tgas plus 0.3 per night (11 Tgas for 30 nights
  // with 8 stalls). The allowance is charged exactly the NEAR burnt, at 0.0001 NEAR per Tgas.
  const tgasNear = 1e-4
  const nightsPerKeeper = (opts.keeperEvery * 60_000) / nightMs
  const keeperNearGuess = (4.6 + 0.3 * nightsPerKeeper) * tgasNear
  const actNearGuess = 2.9 * tgasNear
  const est = (keeperNear, actNear) => dailyCost({ keeperEvery: opts.keeperEvery, botEvery: opts.botEvery, bots: bots.length, keeperNear, actNear })
  const plan = est(keeperNearGuess, actNearGuess)
  console.log(`${stamp()} pacing: keeper every ${opts.keeperEvery} min (about ${Math.round(nightsPerKeeper)} nights a call), each bot every ${opts.botEvery} min; expected ${Math.round(plan.keeperCalls)} keeper calls and ${Math.round(plan.acts)} bot visits a day, about ${plan.near.toFixed(2)} NEAR a day`)

  const checkBudget = () => {
    if (pool.balance < opts.floor) throw new Stop(`${GAS_ACCOUNT} holds ${fmtNear(pool.balance)} NEAR, below the floor of ${opts.floor}: the rest is left for players. Refill the gas account to start the bots again.`)
    if (!pool.usable().length) throw new Stop(`every gas key on ${GAS_ACCOUNT} has less than ${opts.keyReserve} NEAR of allowance left: refill the pool (scripts/setup-gas-pool.mjs)`)
  }

  const nightsDue = (w) => (w.due ? Math.floor((w.now_ms - (w.ends_ms - nightMs)) / nightMs) : 0)

  if (opts.dryRun) {
    const w = await view(CONTRACT, 'world')
    const due = nightsDue(w)
    console.log(`${stamp()} night ${w.night}, ${w.row.length} stalls on the row, licences: ${w.licences_tonight} tonight, ${w.licences_left} left`)
    console.log(`${stamp()} keeper: ${due ? `would call advance_night now: ${Math.min(due, cfg.max_catchup_nights)} nights${due > cfg.max_catchup_nights ? `, ${due - cfg.max_catchup_nights} slept` : ''}` : 'no night is due'}`)
    const free = cfg.spots.filter((s) => !w.row.some((x) => x.spot === s.spot))
    for (const b of bots) {
      if (!b.stall) {
        const fresh = { id: 0, money: cfg.starter_grant, stock: [0, 0, 0, 0, 0], price: [0, 0, 0, 0, 0], capacity: cfg.tier_capacity[0], spot: free.length ? free[free.length - 1].spot : null, last_action: w.night }
        const ok = w.licences_tonight >= FOUNDING_LICENCES_MIN
        console.log(`${stamp()} ${b.name.padEnd(18)} would found "${b.name}"${ok ? '' : ' after the next night (licences tonight are left for players)'}, then: ${describe(planTurn(b.strategy, fresh, w, cfg)) || 'nothing'}`)
      } else {
        const acts = planTurn(b.strategy, b.stall, w, cfg, { keepAlive: w.night - b.stall.last_action >= KEEP_ALIVE_NIGHTS })
        console.log(`${stamp()} ${b.name.padEnd(18)} stall ${b.stall.id}: would send ${acts.length ? describe(acts) : 'nothing'}`)
      }
    }
    try {
      checkBudget()
    } catch (e) {
      if (!(e instanceof Stop)) throw e
      console.log(`${stamp()} STOP: ${e.message}`)
      return 2
    }
    console.log(`${stamp()} dry run done, nothing sent`)
    return 0
  }

  let stopping = false
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (stopping = true))
  const started = Date.now()
  const deadline = started + opts.minutes * 60_000
  const txs = []
  let foundedAt = -1

  const logTx = (who, what, r) => {
    txs.push({ who, ...r })
    console.log(`${stamp()} ${who.padEnd(18)} ${what} | ${tgas(r.gas)} Tgas | ${r.near.toFixed(5)} NEAR | key ${r.key.slice(8, 16)} | ${r.hash}${r.failure ? ` | FAILED ${r.failure.slice(0, 200)}` : ''}`)
  }

  const act = async (b, actions) => {
    const nonce = Math.max(Date.now(), b.nonce + 1) // time-based: stays above every earlier nonce, across runs
    b.nonce = nonce
    const action = JSON.stringify(actions)
    const signature = hex(sign(b.key, Buffer.from(`lantern-row:v1:${CONTRACT}:${nonce}:${action}`, 'utf8')))
    return pool.relay('act', { player_pubkey: b.account, nonce, action, signature }, ACT_GAS)
  }

  const guarded = async (who, fn, onError) => {
    try {
      await fn()
    } catch (e) {
      if (e instanceof Stop) throw e
      console.log(`${stamp()} ${who.padEnd(18)} error: ${String(e?.message ?? e).slice(0, 300)}`)
      onError?.()
    }
  }

  const stallOf = async (b) => (await view(CONTRACT, 'player', { account: b.account }))?.stalls?.[0] ?? null

  const botTurn = async (b) => {
    let w = await view(CONTRACT, 'world')
    let stall = await stallOf(b)
    if (!stall) {
      if (w.licences_left <= 0) return console.log(`${stamp()} ${b.name.padEnd(18)} no stall licences left on the row`)
      if (w.licences_tonight < FOUNDING_LICENCES_MIN || foundedAt + NIGHTS_PER_FOUNDING > w.night) {
        b.waiting = true
        return console.log(`${stamp()} ${b.name.padEnd(18)} waits for the next night to found its stall (${w.licences_tonight} licences tonight, kept for players)`)
      }
      const r = await act(b, [{ found: { name: b.name } }])
      const id = r.value?.minted?.[0]
      logTx(b.name, `found "${b.name}"${id ? ` -> stall ${id}` : ''}${r.value?.error ? `, refused: ${r.value.error}` : ''}`, r)
      b.waiting = !id
      if (!id) return
      foundedAt = w.night
      for (let i = 0; i < 8 && !stall; i++) {
        await sleep(1500)
        stall = await view(CONTRACT, 'stall', { id })
      }
      if (!stall) return
      w = await view(CONTRACT, 'world')
    }
    b.stall = stall
    const acts = planTurn(b.strategy, stall, w, cfg, { keepAlive: w.night - stall.last_action >= KEEP_ALIVE_NIGHTS })
    if (!acts.length) return console.log(`${stamp()} ${b.name.padEnd(18)} stall ${stall.id}: nothing to change`)
    const r = await act(b, acts)
    const v = r.value
    logTx(b.name, `stall ${stall.id}: ${describe(acts)}${v?.error ? ` (applied ${v.applied} of ${v.total}: ${v.error})` : ''}`, r)
  }

  const keeperTick = async () => {
    await pool.refresh()
    checkBudget()
    const w = await view(CONTRACT, 'world')
    const due = nightsDue(w)
    if (!due) return console.log(`${stamp()} ${'keeper'.padEnd(18)} night ${w.night} is not over yet (someone is playing)`)
    const run = Math.min(due, cfg.max_catchup_nights)
    // A bot whose stall would come close to idle eviction after this call tends it first.
    for (const b of bots) {
      const s = w.row.find((x) => x.owner === b.account)
      if (s && w.night + run - s.last_action >= evictAfter - IDLE_MARGIN) {
        await guarded(b.name, () => botTurn(b))
        b.next = Date.now() + opts.botEvery * 60_000
      }
    }
    let r = await pool.relay('advance_night', {}, KEEPER_GAS)
    if (r.failure && /Exceeded|GasExceeded|prepaid gas/i.test(r.failure)) {
      logTx('keeper', 'advance_night ran out of gas, retrying with more', r)
      r = await pool.relay('advance_night', {}, KEEPER_GAS_RETRY)
    }
    const v = r.value ?? {}
    logTx('keeper', `advance_night +${v.advanced ?? '?'} nights${v.slept ? `, slept ${v.slept}` : ''}, now night ${v.night ?? '?'}`, r)
    if (v.advanced > 0) for (const b of bots) if (b.waiting) b.next = 0 // a new night brings new licences
  }

  let exitCode = 0
  try {
    checkBudget()
    // First every bot tends its stall (or founds it), so a long pause cannot cost it its spot, then the keeper.
    for (const b of bots) await guarded(b.name, () => botTurn(b), () => (b.next = Date.now() + 60_000))
    const t0 = Date.now()
    bots.forEach((b, i) => (b.next = Math.max(b.next, t0 + ((i + 1) * opts.botEvery * 60_000) / bots.length)))
    let nextKeeper = t0
    while (!stopping && Date.now() < deadline) {
      const now = Date.now()
      const next = Math.min(nextKeeper, ...bots.map((b) => b.next))
      if (next > now) {
        await sleep(Math.min(next - now, deadline - now, 5000))
        continue
      }
      if (nextKeeper <= now) {
        let failed = false
        await guarded('keeper', keeperTick, () => (failed = true))
        nextKeeper = Date.now() + (failed ? 60_000 : opts.keeperEvery * 60_000) // a failed call is retried in a minute
      }
      for (const b of bots) {
        if (stopping || b.next > Date.now() || Date.now() >= deadline) continue
        b.next = Date.now() + opts.botEvery * 60_000
        await guarded(b.name, () => botTurn(b), () => (b.next = Date.now() + 60_000))
      }
    }
  } catch (e) {
    if (!(e instanceof Stop)) throw e
    console.log(`${stamp()} STOP: ${e.message}`)
    if (env.GITHUB_ACTIONS) console.log(`::warning title=House bots stopped::${e.message}`)
    exitCode = 2
  }

  // Summary: what this run spent, measured, and what that means per day.
  await pool.refresh().catch(() => {})
  const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0)
  const keeperTxs = txs.filter((t) => t.who === 'keeper')
  const actTxs = txs.filter((t) => t.who !== 'keeper')
  const avg = (xs, fallback) => (xs.length ? sum(xs, (t) => t.near) / xs.length : fallback)
  const burnt = sum(txs, (t) => t.near)
  const used = pool.keys.filter((k) => k.txs > 0)
  const allowanceUsed = sum(used, (k) => k.start - k.allowance)
  const ran = (Date.now() - started) / 60_000
  const measured = est(avg(keeperTxs, keeperNearGuess), avg(actTxs, actNearGuess))
  const lines = [
    `ran ${ran.toFixed(1)} min: ${actTxs.length} bot transactions, ${keeperTxs.length} keeper calls, ${tgas(sum(txs, (t) => t.gas))} Tgas, ${burnt.toFixed(5)} NEAR burnt`,
    `allowance used on the ${used.length} keys this run touched: ${allowanceUsed.toFixed(5)} NEAR (players may have used the same keys)`,
    `gas account now holds ${fmtNear(pool.balance)} NEAR; at this pacing about ${measured.near.toFixed(2)} NEAR a day (keeper ${avg(keeperTxs, 0).toFixed(5)}, bot visit ${avg(actTxs, 0).toFixed(5)} NEAR on average)`,
  ]
  for (const l of lines) console.log(`${stamp()} ${l}`)
  const world = await view(CONTRACT, 'world').catch(() => null)
  const board = []
  for (const b of bots) {
    const s = world?.row.find((x) => x.owner === b.account) ?? (await stallOf(b).catch(() => null))
    const line = `${b.name}: ${s ? `stall ${s.id}, ${s.spot == null ? 'off the row' : `spot ${s.spot}`}, ${s.money} coin, worth ${s.worth}, stock ${s.stock.join('/')}` : 'no stall yet'}`
    board.push(line)
    console.log(`${stamp()} ${line}`)
  }
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, ['### Lantern Row house bots', '', ...lines.map((l) => `- ${l}`), '', ...board.map((l) => `- ${l}`), ''].join('\n'))
  }
  return exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`house-bots: ${e?.message ?? e}`)
      process.exit(1)
    },
  )
}

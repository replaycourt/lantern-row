// The client logic added for watching the row, goals, ranks, price notes, refusal reasons and the
// live proof. Pure functions, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as L from '../js/logic.js'
import { Client, codeHashHex } from '../js/chain.js'

const cfg = {
  starter_grant: 3000,
  max_catchup_nights: 30,
  sales_tax_pct: 5,
  tier_cost: [0, 5000, 14000, 36000],
  spots: [{ spot: 0, fee: 6912 }],
  goods: [
    { name: 'tea', fair: 60, dock_base: 30, heat_slope: 120, need_period: 2, max_price: 600 },
    { name: 'lamp oil', fair: 90, dock_base: 46, heat_slope: 80, need_period: 3, max_price: 900 },
    { name: 'dumplings', fair: 40, dock_base: 20, heat_slope: 180, need_period: 1, max_price: 400 },
    { name: 'silk', fair: 350, dock_base: 170, heat_slope: 24, need_period: 8, max_price: 3500 },
    { name: 'charms', fair: 180, dock_base: 90, heat_slope: 45, need_period: 5, max_price: 1800 },
  ],
}
const dock = [
  { price: 36, left: 12, heat: 22, factor_pct: 100 },
  { price: 52, left: 7, heat: 9, factor_pct: 100 },
  { price: 23, left: 18, heat: 21, factor_pct: 100 },
  { price: 178, left: 3, heat: 1, factor_pct: 100 },
  { price: 104, left: 5, heat: 7, factor_pct: 100 },
]
const kettle = { id: 1, name: 'The Quiet Kettle', npc: true, spot: 1, stock: [9, 2, 0, 0, 1], price: [99, 127, 0, 0, 258], rep: 511 }
const uncle = { id: 6, name: "Uncle's Everything", npc: true, spot: 20, stock: [0, 2, 5, 1, 0], price: [104, 116, 57, 387, 273], rep: 463 }
const me = { id: 14, name: 'My Stall', npc: false, spot: 14, stock: [3, 0, 0, 0, 0], price: [95, 0, 0, 0, 0], rep: 200 }
// Bao after night 40: he bought dumplings at Uncle's for 57, and found tea too dear at My Stall.
const bao = { id: 1, name: 'Bao', wallet: 2000, wage: 220, taste: [90, 150, 100, 0, 60], unmet: [2, 0, 0, 30, 4], memory: [[14, 3]] }
const log = { night: 40, event: 'quiet', sales: [[1, 6, 2, 57]], refusals: [[1, 14, 0], [1, 6, 1]], missed: [[1, 4]] }
const world = { night: 41, now_ms: 1_000_000, ends_ms: 990_000, due: true, event: 'quiet', dock, row: [kettle, uncle, me], villagers: [bao] }

test('the refusal reason is worked out the way the contract decides', () => {
  // Rebuild Bao as he walked: wallet 2000 + 57 spent = 2057, wealth min(150, 60 + 2057*40/1100) = 134,
  // one spare night; tea unmet 2 - 1 = 1, + 1 spare = 2 against a period of floor(2*100/90) = 2: 0 overdue.
  // willingness floor(60 * 90 * 100 * 134 * 100 / 1e8) = 72; at My Stall (rep 200 -> +2, memory 3 + 1 faded -> +4): floor(72 * 106 / 100) = 76
  assert.equal(L.wealthPct(2057, 220), 134)
  const r = L.refusalReason({ log, world, cfg, villager: 1, stall: 14, good: 0 })
  assert.deepEqual(r, { kind: 'wtp', max: 76 })
  assert.ok(r.max < me.price[0], 'the reason never contradicts the price on show')
  assert.equal(L.refusalWords(r), 'pays 76 at most')
  // bought the same good elsewhere that night: exact, from the log alone
  const log2 = { ...log, sales: [[1, 1, 0, 90]], refusals: [[1, 14, 0]] }
  assert.deepEqual(L.refusalReason({ log: log2, world: null, cfg, villager: 1, stall: 14, good: 0 }), { kind: 'elsewhere', price: 90, at: 1 })
  assert.equal(L.refusalWords({ kind: 'elsewhere', price: 90, at: 1 }), 'paid 90 elsewhere')
  // a wallet thinner than the willingness is the reason
  const poor = { ...world, villagers: [{ ...bao, wallet: 3 }] }
  assert.deepEqual(L.refusalReason({ log: { ...log, sales: [] }, world: poor, cfg, villager: 1, stall: 14, good: 0 }), { kind: 'wallet', max: 3 })
  assert.equal(L.refusalWords({ kind: 'wallet', max: 3 }), 'has only 3 coin')
  // an older night cannot be rebuilt from today's villagers: no guess
  assert.equal(L.refusalReason({ log: { ...log, night: 38 }, world, cfg, villager: 1, stall: 14, good: 0 }), null)
  // a price on show at or below the rebuilt willingness (a merchant repriced since): no reason given
  const cheap = { ...world, row: [kettle, uncle, { ...me, price: [70, 0, 0, 0, 0] }] }
  assert.equal(L.refusalReason({ log, world: cheap, cfg, villager: 1, stall: 14, good: 0 }), null)
  assert.equal(L.refusalWords(null), null)
})

test('the ticker tells a night in sentences, in walking order', () => {
  const items = L.tickerItems(log, { world, cfg })
  assert.deepEqual(
    items.map((i) => i.kind),
    ['buy', 'refuse', 'refuse', 'miss'],
  )
  assert.equal(items[0].text, "Bao bought dumplings at Uncle's Everything for 57")
  assert.equal(items[1].text, 'Bao found tea too dear at My Stall: pays 76 at most')
  assert.match(items[3].text, /Bao wanted charms; nobody on the row had any/)
  assert.equal(L.nightTally(log), 'Night 40: 1 sale, 2 too dear, 1 found nothing')
  assert.equal(L.nightTally({ night: 7, sales: [], refusals: [], missed: [] }), 'Night 7: 0 sales')
  assert.deepEqual(L.tickerItems(null), [])
})

test('an idle town says plainly that the next player catches it up', () => {
  assert.equal(L.idleNotice(world, cfg), null) // 10 s late: normal
  const idle = { ...world, now_ms: 990_000 + 19 * 3600_000 }
  assert.equal(L.idleNotice(idle, cfg), 'The row has been quiet for 19 hours. The next player to act catches it up, up to 30 nights at once.')
  assert.equal(L.idleNotice({ ...idle, due: false }, cfg), null)
  assert.equal(L.roughDuration(5 * 60_000), '5 minutes')
  assert.equal(L.roughDuration(60_000), '1 minute')
  assert.equal(L.roughDuration(3 * 24 * 3600_000), '3 days')
})

test('milestones come from the contract numbers and toast once each', () => {
  const m = L.milestones(cfg)
  assert.deepEqual(
    m.map((x) => x.at),
    [3000, 3500, 4000, 5000, 6912, 10000, 14000, 20000, 36000, 50000, 100000],
  )
  assert.equal(m.find((x) => x.at === 5000).label, 'what a size-2 stall costs')
  assert.equal(m.find((x) => x.at === 6912).label, 'what the front spot costs')
  const g = L.goalProgress(3006, m)
  assert.equal(g.text, '3,006 → 3,500')
  assert.equal(g.next.at, 3500)
  assert.ok(Math.abs(g.frac - 6 / 500) < 1e-9)
  assert.equal(L.goalProgress(6515, m).text, '6,515 → 6,912')
  assert.equal(L.goalProgress(250000, m).text, '250,000')
  assert.equal(L.goalProgress(250000, m).frac, 1)
  assert.equal(L.goalProgress(1200, m).prev.at, 0) // below the grant, the climb starts at 0
  assert.deepEqual(L.crossedMilestones(3400, 5100, m).map((x) => x.at), [3500, 4000, 5000])
  assert.deepEqual(L.crossedMilestones(5100, 4000, m), [])
  assert.deepEqual(L.crossedMilestones(null, 4000, m), [])
  assert.equal(L.milestoneText(m.find((x) => x.at === 5000)), 'Milestone: worth 5,000, what a size-2 stall costs. Grow the stall from the Deed.')
  assert.equal(L.milestoneText(m.find((x) => x.at === 3500)), 'Milestone: worth 3,500, your first 500 coin of profit.')
})

const board = [
  { rank: 1, id: 1, name: 'The Quiet Kettle', npc: true, spot: 1, worth: 61316 },
  { rank: 2, id: 6, name: "Uncle's Everything", npc: true, spot: 20, worth: 47972 },
  { rank: 3, id: 5, name: 'Seven Knots', npc: true, spot: 16, worth: 33430 },
  { rank: 4, id: 25, name: 'Honey Lantern', npc: false, spot: 23, worth: 6515 },
  { rank: 5, id: 24, name: 'Bobs Dumplings', npc: false, spot: null, worth: 3289 },
  { rank: 6, id: 30, name: 'Mine', npc: false, spot: 22, worth: 3006 },
  { rank: 7, id: 23, name: 'Alice Teahouse', npc: false, spot: null, worth: 3219 },
]

test('ranks: players first, merchants next, closed stalls folded, nothing dropped', () => {
  const g = L.rankGroups(board, 30)
  assert.deepEqual(g.players.map((r) => [r.id, r.place]), [[25, 1], [30, 2]])
  assert.deepEqual(g.merchants.map((r) => r.id), [1, 6, 5])
  assert.deepEqual(g.closed.map((r) => [r.id, r.place]), [[24, 1], [23, 2]]) // sorted by worth
  assert.equal(g.players.length + g.merchants.length + g.closed.length, board.length)
  // the player's own stall stays among the players even when it lost its spot
  const off = L.rankGroups(board.map((r) => (r.id === 30 ? { ...r, spot: null } : r)), 30)
  assert.ok(off.players.some((r) => r.id === 30))
  assert.ok(!off.closed.some((r) => r.id === 30))
})

test('standing: place among players, the player ahead, the next merchant to beat', () => {
  const st = L.standing(board, 30)
  assert.equal(st.place, 2)
  assert.equal(st.of, 2)
  assert.equal(st.ahead.id, 25)
  assert.equal(st.merchant.name, 'Seven Knots')
  assert.equal(st.below, 0)
  assert.deepEqual(L.standingText(st), { place: '#2 of 2 players', next: 'beat Seven Knots, 33,430' })
  const top = L.standing(board.map((r) => (r.id === 30 ? { ...r, worth: 70000 } : r)), 30)
  assert.equal(top.place, 1)
  assert.equal(top.merchant, null)
  assert.equal(top.below, 3)
  assert.equal(L.standingText(top).next, 'ahead of every merchant')
  assert.equal(L.standing(board, 999).place, null)
  assert.equal(L.standingText({ place: null }), null)
  // toasts: passing a player, passing a merchant, nothing when nothing changed
  const passed = L.standing(board.map((r) => (r.id === 30 ? { ...r, worth: 7000 } : r)), 30)
  assert.equal(L.passedText(st, passed), 'You passed Honey Lantern: #1 of 2 players.')
  const pastKnots = L.standing(board.map((r) => (r.id === 30 ? { ...r, worth: 40000 } : r)), 30)
  assert.equal(L.passedText(passed, pastKnots), 'You passed the merchant Seven Knots: 1 of the merchants are behind you.')
  assert.equal(L.passedText(st, st), null)
  assert.equal(L.passedText(null, st), null)
})

test('price cards speak in short sentences', () => {
  const fc = L.forecast({ ...world, event: 'quiet', villagers: [{ ...bao, unmet: [5, 0, 0, 30, 0] }] }, cfg, me)
  assert.equal(fc[0].wanted, 1)
  const tea = L.priceNote({ fc, g: 0, price: 70, stock: 3, world, stallId: 14, cfg })
  assert.match(tea.long, /^1 want it, (about \d may buy here|few will buy here)\. Cheapest elsewhere: 99\.$/)
  assert.match(tea.full, /^Tea at 70: .* The Dock sells it at 36\.$/)
  const off = L.priceNote({ fc, g: 0, price: 0, stock: 3, world, stallId: 14, cfg })
  assert.deepEqual([off.long, off.short], ['Not for sale. Tap + to price it.', 'not for sale'])
  const empty = L.priceNote({ fc, g: 0, price: 70, stock: 0, world, stallId: 14, cfg })
  assert.deepEqual([empty.long, empty.short], ['1 want it tonight. Restock to sell.', 'restock it'])
  const silk = L.priceNote({ fc, g: 3, price: 400, stock: 1, world, stallId: 14, cfg })
  assert.equal(silk.long, 'Nobody needs it tonight. Cheapest elsewhere: 387.')
  assert.equal(silk.short, 'not needed')
  // nobody else on the row sells charms with stock: say so
  const alone = L.priceNote({ fc, g: 4, price: 200, stock: 1, world: { ...world, row: [uncle, me] }, stallId: 14, cfg })
  assert.match(alone.long, /Nobody else sells it\.$/)
  // no forecast yet: just the rival's price
  assert.equal(L.priceNote({ g: 0, price: 70, stock: 3, world, stallId: 14, cfg }).long, 'Cheapest elsewhere: 99.')
})

test('proof facts: keys and code hash, read live, compared with the repository', () => {
  assert.equal(L.WASM_SHA256, readFileSync(new URL('../../contract/WASM_SHA256', import.meta.url), 'utf8').trim())
  // the deployed code hash as NEAR shows it (base58) is the sha256 in contract/WASM_SHA256 (hex)
  assert.equal(codeHashHex('2stLGPk5Xvc79X21CkHtyQ5XTigVeRagB3EqZdx9ZtCJ'), L.WASM_SHA256)
  const good = L.proofFacts({ keyCount: 0, codeHashHex: L.WASM_SHA256 })
  assert.equal(good.keys.ok, true)
  assert.match(good.keys.text, /^none/)
  assert.equal(good.code.ok, true)
  assert.match(good.code.text, /^1be4c4d2…2b4e9b, the same as contract\/WASM_SHA256/)
  const bad = L.proofFacts({ keyCount: 1, codeHashHex: 'ab'.repeat(32) })
  assert.equal(bad.keys.ok, false)
  assert.match(bad.keys.text, /1 key/)
  assert.equal(bad.code.ok, false)
  const unknown = L.proofFacts({ keyCount: null, codeHashHex: null })
  assert.equal(unknown.keys.ok, null)
  assert.equal(unknown.code.ok, null)
})

test('the client reads the contract facts with two views and no transaction', async () => {
  const calls = []
  const rpc = {
    async accessKeyList(account) {
      calls.push(['keys', account])
      return { keys: [] }
    },
    async viewAccount(account) {
      calls.push(['account', account])
      return { code_hash: '2stLGPk5Xvc79X21CkHtyQ5XTigVeRagB3EqZdx9ZtCJ' }
    },
  }
  const c = new Client({ rpc, contract: 'lantern-row.testnet', pool: {} })
  assert.deepEqual(await c.contractFacts(), { keyCount: 0, codeHashHex: L.WASM_SHA256 })
  assert.deepEqual(calls.sort(), [['account', 'lantern-row.testnet'], ['keys', 'lantern-row.testnet']])
})

test('the night report says what a refusing villager would have paid', () => {
  const before = { ...me, money: 3000, rent_paid: 0, sold_last: [0, 0, 0, 0, 0] }
  const after = { ...before }
  const s = L.summariseNight({ log, stall: after, before, world, cfg, villagers: [{ name: 'Ansel' }, { name: 'Bao' }] })
  assert.match(s.lines.map((l) => l.text).join('\n'), /Bao found your tea too dear at 95\. Bao would pay 76 at most\./)
})

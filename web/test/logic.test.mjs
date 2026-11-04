import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as L from '../js/logic.js'

const cfg = {
  night_ms: 20000,
  sales_tax_pct: 5,
  goods: [
    { name: 'tea', fair: 60, dock_base: 30, dock_supply: 12, heat_slope: 120, spoil_pct: 2, need_period: 2, max_price: 600 },
    { name: 'lamp oil', fair: 90, dock_base: 46, dock_supply: 7, heat_slope: 80, spoil_pct: 1, need_period: 3, max_price: 900 },
    { name: 'dumplings', fair: 40, dock_base: 20, dock_supply: 18, heat_slope: 180, spoil_pct: 15, need_period: 1, max_price: 400 },
    { name: 'silk', fair: 350, dock_base: 170, dock_supply: 3, heat_slope: 24, spoil_pct: 0, need_period: 8, max_price: 3500 },
    { name: 'charms', fair: 180, dock_base: 90, dock_supply: 5, heat_slope: 45, spoil_pct: 0, need_period: 5, max_price: 1800 },
  ],
  tier_cost: [0, 5000, 14000, 36000],
  tier_capacity: [40, 80, 140, 220],
}

const dock = [
  { price: 36, left: 12, heat: 22, factor_pct: 100 },
  { price: 52, left: 7, heat: 9, factor_pct: 100 },
  { price: 23, left: 18, heat: 21, factor_pct: 100 },
  { price: 178, left: 3, heat: 1, factor_pct: 100 },
  { price: 104, left: 5, heat: 7, factor_pct: 100 },
]

const kettle = { id: 1, name: 'The Quiet Kettle', npc: true, spot: 1, footfall: 97, stock: [9, 2, 0, 0, 1], price: [99, 127, 0, 0, 258], rep: 511, tier: 1, money: 17489 }
const uncle = { id: 6, name: "Uncle's Everything", npc: true, spot: 20, footfall: 40, stock: [0, 2, 5, 1, 0], price: [104, 116, 57, 387, 273], rep: 463, tier: 1, money: 16815 }
const me = { id: 14, name: 'My Stall', npc: false, spot: 14, footfall: 58, money: 3000, stock: [0, 0, 0, 0, 0], price: [0, 0, 0, 0, 0], rep: 200, tier: 0, capacity: 40, rent_paid: 0, customers: 0, earned: 0, listed: null }
const world = { night: 41, event: { festival: { good: 0 } }, event_left: 1, event_next: { bumper: { good: 2 } }, dock, row: [kettle, uncle, me], villagers: [] }

test('dock cost matches the contract formula', () => {
  // one unit at heat 0: ceil(base * (s + 0 + 0) / s) = base
  assert.equal(L.dockCost(cfg.goods[0], { heat: 0, factor_pct: 100 }, 1), 30)
  // the quoted single-unit price on the live world: ceil(30 * (120 + 22) / 120) = 36
  assert.equal(L.dockCost(cfg.goods[0], dock[0], 1), 36)
  // one big order costs the same as the sum of singles would, give or take rounding up
  const bulk = L.dockCost(cfg.goods[2], { heat: 0, factor_pct: 100 }, 5)
  assert.equal(bulk, Math.ceil((20 * (5 * 180 + 10)) / 180))
  assert.equal(L.dockCost(cfg.goods[0], dock[0], 0), 0)
  // a storm factor of 150% raises the price
  assert.ok(L.dockCost(cfg.goods[3], { heat: 0, factor_pct: 150 }, 1) > L.dockCost(cfg.goods[3], { heat: 0, factor_pct: 100 }, 1))
})

test('affordable never exceeds money or max', () => {
  assert.equal(L.affordable(cfg.goods[0], dock[0], 100, 10), 2)
  assert.equal(L.affordable(cfg.goods[0], dock[0], 100000, 4), 4)
  assert.equal(L.affordable(cfg.goods[0], dock[0], 0, 4), 0)
})

test('suggested prices undercut the cheapest rival with stock and respect floors', () => {
  const s = L.suggestPrices(world, cfg, me)
  // tea: cheapest rival 99 -> 96, capped at 140% of fair = 84, festival on tea -> +25% = 105
  assert.equal(s[0].price, 105)
  assert.match(s[0].reason, /festival/)
  // a new stall (rep 200) undercuts by 12%: lamp oil rivals 127 and 116 -> 116*0.88 = 102, floor max(65, 85) = 85
  assert.equal(s[1].price, 102)
  assert.match(s[1].reason, /until villagers know you/)
  // dumplings: Uncle sells at 57 -> 50; floor max(28, 38) = 38; ceiling 56
  assert.equal(s[2].price, 50)
  // silk: rival 387 -> 340, floor max(222, 332) = 332, ceiling 490
  assert.equal(s[3].price, 340)
  // charms: rivals 258, 273 -> 227, ceiling 252
  assert.equal(s[4].price, 227)
  for (let g = 0; g < 5; g++) assert.ok(s[g].price <= cfg.goods[g].max_price)
  // an established stall (rep 600) only shaves 3% off
  const est = L.suggestPrices(world, cfg, { ...me, rep: 600 })
  assert.equal(est[1].price, 112)
  assert.equal(est[4].price, 250)
})

test('suggested prices without rivals fall back to a fair price', () => {
  const lonely = { ...world, row: [me], event: 'quiet' }
  const s = L.suggestPrices(lonely, cfg, me)
  assert.equal(s[0].price, 84) // 140% of 60
  assert.match(s[0].reason, /nobody else/)
})

test('restock plan fits money, capacity and Dock supply', () => {
  const plan = L.suggestRestock(world, cfg, me)
  assert.ok(plan.items.length >= 3)
  const units = plan.items.reduce((a, i) => a + i.qty, 0)
  assert.ok(units <= me.capacity)
  assert.ok(plan.total <= me.money)
  for (const i of plan.items) assert.ok(i.qty <= dock[i.good].left, `good ${i.good} within supply`)
  // festival on tea tonight: tea target doubles to 16, but Dock has only 12
  const tea = plan.items.find((i) => i.good === 0)
  assert.ok(tea.qty <= 12)
  const acts = L.restockActions(me.id, plan)
  assert.equal(acts.length, plan.items.length)
  for (const a of acts) assert.ok(a.buy.max_cost >= plan.items.find((i) => i.good === a.buy.good).cost)
})

test('restock plan is empty when the counter is full or the purse is empty', () => {
  const full = { ...me, stock: [10, 10, 10, 5, 5] }
  assert.equal(L.suggestRestock(world, cfg, full).items.length, 0)
  const broke = { ...me, money: 10 }
  assert.equal(L.suggestRestock(world, cfg, broke).items.length, 0)
})

test('coalesce keeps the last price per good and merges buys', () => {
  const out = L.coalesce([
    { price: { stall: 1, good: 0, price: 50 } },
    { buy: { stall: 1, good: 2, qty: 3, max_cost: 100 } },
    { price: { stall: 1, good: 0, price: 55 } },
    { buy: { stall: 1, good: 2, qty: 2, max_cost: 70 } },
    { list: { stall: 1, price: 999 } },
  ])
  assert.deepEqual(out, [{ price: { stall: 1, good: 0, price: 55 } }, { buy: { stall: 1, good: 2, qty: 5, max_cost: 170 } }, { list: { stall: 1, price: 999 } }])
  assert.equal(L.coalesce(Array.from({ length: 30 }, (_, i) => ({ price: { stall: 1, good: i, price: 1 } }))).length, 16)
})

test('project applies actions optimistically', () => {
  const s = L.project(me, [{ buy: { stall: 14, good: 0, qty: 2, max_cost: 100 } }, { price: { stall: 14, good: 0, price: 58 } }, { upgrade: { stall: 14, max_cost: 5000 } }], world, cfg)
  assert.equal(s.stock[0], 2)
  assert.equal(s.price[0], 58)
  assert.equal(s.tier, 1)
  assert.equal(s.capacity, 80)
  assert.equal(s.money, 3000 - L.dockCost(cfg.goods[0], dock[0], 2) - 5000)
  assert.equal(me.stock[0], 0, 'the original is untouched')
})

test('signing text has the exact contract shape', () => {
  assert.equal(L.signingText('lantern-row.testnet', 7, '[{"found":{"name":"X"}}]'), 'lantern-row:v1:lantern-row.testnet:7:[{"found":{"name":"X"}}]')
})

test('buildWalk groups sales and refusals per villager in walking order', () => {
  const log = {
    night: 40,
    sales: [[1, 1, 0, 92], [1, 3, 1, 108], [5, 1, 0, 92]],
    refusals: [[1, 6, 0], [5, 3, 2], [7, 1, 1]],
    missed: [[4, 0]],
  }
  const w = L.buildWalk(log)
  assert.deepEqual(w.map((x) => x.villager), [1, 5, 7, 4])
  assert.deepEqual(w[0].stops.map((s) => `${s.kind}:${s.stall}:${s.good}`), ['refuse:6:0', 'buy:1:0', 'buy:3:1'])
  assert.deepEqual(w[1].stops.map((s) => s.kind), ['buy', 'refuse'])
  assert.deepEqual(w[2].stops.map((s) => s.kind), ['refuse'])
  assert.deepEqual(w[3].missed, [0])
  assert.deepEqual(L.buildWalk({ sales: [], refusals: [], missed: [] }), [])
})

test('bubble text has a line for every good and kind', () => {
  for (let g = 0; g < 5; g++) {
    assert.ok(L.bubbleText('buy', g, () => 0).length > 0)
    assert.ok(L.bubbleText('miss', g).length > 0)
  }
  assert.ok(L.bubbleText('refuse', 0, () => 0.99).length > 0)
})

test('summary explains sales, refusals and rent', () => {
  const before = { ...me, stock: [5, 0, 4, 0, 0], price: [95, 0, 50, 0, 0], rent_paid: 100 }
  const after = { ...me, stock: [3, 0, 0, 0, 0], price: [95, 0, 50, 0, 0], rent_paid: 121, money: 3200 }
  const log = { night: 41, sales: [[1, 14, 0, 95], [2, 14, 0, 95], [3, 14, 2, 50], [4, 14, 2, 50], [5, 14, 2, 50], [6, 14, 2, 50], [7, 1, 0, 99]], refusals: [[8, 14, 0]], missed: [] }
  const villagers = Array.from({ length: 12 }, (_, i) => ({ name: `V${i}`, wants: [] }))
  const s = L.summariseNight({ log, stall: after, before, world: { ...world, villagers }, cfg, villagers })
  assert.equal(s.sold, 6)
  assert.equal(s.revenue, 2 * 95 + 4 * 50)
  assert.equal(s.mood, 'good')
  assert.match(s.headline, /6 sales/)
  const text = s.lines.map((l) => l.text).join('\n')
  assert.match(text, /Sold 2 tea for 190, 4 dumplings for 200/)
  assert.match(text, /Sold out of dumplings/)
  assert.match(text, /V8 found your tea too dear at 95/)
  assert.match(text, /Rent 21 for spot 15\./)
  const caught = L.summariseNight({ log, stall: { ...after, rent_paid: 730 }, before, world: { ...world, villagers }, cfg, villagers, nights: 30 })
  assert.match(caught.lines.map((l) => l.text).join('\n'), /Rent 630 for spot 15, over the 30 nights/)
})

test('summary explains a night with no sales, for each reason', () => {
  const log = { night: 41, sales: [[1, 1, 0, 99]], refusals: [], missed: [] }
  const base = { log, world, cfg, villagers: [] }
  const empty = L.summariseNight({ ...base, stall: me, before: me })
  assert.equal(empty.sold, 0)
  assert.match(empty.lines[0].text, /counter was empty/)
  assert.equal(empty.headline, 'No sales tonight')

  const unpriced = { ...me, stock: [3, 0, 0, 0, 0] }
  assert.match(L.summariseNight({ ...base, stall: unpriced, before: unpriced }).lines[0].text, /no prices/)

  const dear = { ...me, stock: [3, 0, 0, 0, 0], price: [150, 0, 0, 0, 0] }
  assert.match(L.summariseNight({ ...base, stall: dear, before: dear }).lines[0].text, /above the merchants'. The Quiet Kettle sells tea at 99; you asked 150/)

  const off = { ...me, spot: null }
  const s = L.summariseNight({ ...base, stall: off, before: off })
  assert.equal(s.mood, 'bad')
  assert.match(s.lines[0].text, /off the row/)

  const unwanted = { ...me, stock: [0, 0, 0, 2, 0], price: [0, 0, 0, 300, 0] }
  assert.match(L.summariseNight({ ...base, stall: unwanted, before: unwanted }).lines[0].text, /Nobody wanted silk/)

  const back = { ...me, spot: 20, footfall: 40, stock: [3, 0, 0, 0, 0], price: [90, 0, 0, 0, 0] }
  assert.match(L.summariseNight({ ...base, stall: back, before: back }).lines[0].text, /40% of villagers walk as far as spot 21/)
})

test('event info and forecast read well', () => {
  assert.equal(L.eventInfo('quiet', cfg).kind, 'quiet')
  assert.equal(L.eventInfo('payday', cfg).title, 'Payday')
  assert.equal(L.eventInfo({ festival: { good: 3 } }, cfg).title, 'Festival of silk')
  assert.equal(L.eventInfo({ storm: { good: 1 } }, cfg).good, 1)
  assert.equal(L.forecastLine(world, cfg), 'Bumper dumplings next night.')
  assert.equal(L.forecastLine({ ...world, event_left: 3, event_next: 'quiet' }, cfg), 'Quiet nights ahead (in 3 nights).')
})

test('catch-up text only when several nights passed', () => {
  assert.equal(L.catchUpText(1, 0), null)
  assert.match(L.catchUpText(7, 0), /7 nights/)
  assert.match(L.catchUpText(30, 4), /slept through 4/)
})

test('names: validation, cleaning, generation', () => {
  assert.ok(L.validName("Uncle's Everything"))
  assert.ok(L.validName('Stall-1'))
  assert.ok(!L.validName(''))
  assert.ok(!L.validName('a'.repeat(25)))
  assert.ok(!L.validName('<script>'))
  assert.equal(L.cleanName('  <b>Silk</b>  Lantern!! '), 'bSilkb Lantern')
  for (let i = 0; i < 50; i++) assert.ok(L.validName(L.randomStallName()))
  assert.equal(L.randomStallName(() => 0), 'Amber Teapot')
})

test('escapeHtml neutralises chain data', () => {
  assert.equal(L.escapeHtml(`<img src=x onerror="alert('x')">&`), '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;')
  assert.equal(L.escapeHtml(null), '')
})

test('tutorial advances step by step', () => {
  const p = { restocked: false, priced: false, walked: 0, firstSale: null, openedDeed: false }
  assert.equal(L.tutorialStep(p).id, 'restock')
  p.restocked = true
  assert.equal(L.tutorialStep(p).id, 'price')
  p.priced = true
  assert.equal(L.tutorialStep(p).id, 'wait')
  p.walked = 1
  const first = L.tutorialStep(p)
  assert.equal(first.id, 'first')
  assert.match(first.text(p), /Nobody bought/)
  p.firstSale = 'tea'
  assert.match(first.text(p), /first tea/)
  p.walked = 4
  assert.equal(L.tutorialStep(p).id, 'deed')
  p.openedDeed = true
  assert.equal(L.tutorialStep(p), null)
})

test('misc helpers', () => {
  assert.equal(L.shortAccount('b24fee99dde41a67f6729d08ce32b26a25dae2677de803af0d3ce00b74997dc2'), 'b24fee…7dc2')
  assert.equal(L.shortAccount('bob.testnet'), 'bob.testnet')
  assert.equal(L.fmt(12345), '12,345')
  assert.equal(L.rankOf([{ id: 3, rank: 2 }], 3), 2)
  assert.equal(L.rankOf([], 3), null)
  assert.notEqual(L.stallHue(1), L.stallHue(2))
  assert.equal(L.cheapestRival(world, 14, 1).id, 6)
})

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
const me = { id: 14, name: 'My Stall', npc: false, spot: 14, footfall: 58, money: 3000, stock: [0, 0, 0, 0, 0], price: [0, 0, 0, 0, 0], rep: 200, tier: 0, capacity: 40, service: 10, rent_paid: 0, customers: 0, earned: 0, listed: null, sold_last: [0, 0, 0, 0, 0] }
// Two villagers as the live world shows them: Ansel wants charms, tea and dumplings tonight (checked against testnet), Ines only oil and dumplings.
const ansel = { id: 0, name: 'Ansel', trade: 'dock hand', wallet: 2290, wage: 200, taste: [100, 70, 120, 0, 40], unmet: [1, 1, 0, 30, 13], wants: [4, 0, 2], memory: [[2, 8], [14, 3]] }
const ines = { id: 8, name: 'Ines', trade: 'card player', wallet: 2247, wage: 220, taste: [60, 40, 90, 40, 170], unmet: [0, 11, 0, 17, 0], wants: [1, 2], memory: [[2, 8]] }
const world = { night: 41, event: { festival: { good: 0 } }, event_left: 1, event_next: { bumper: { good: 2 } }, dock, row: [kettle, uncle, me], villagers: [ansel, ines] }
const quiet = { ...world, event: 'quiet', event_left: 2, event_next: 'quiet' }

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

test('villager minds match the contract: wealth, wants, willingness', () => {
  // Ansel: wealth min(150, 60 + floor(2290*40/1000)) = 150, two spare nights
  assert.equal(L.wealthPct(2290, 200), 150)
  assert.equal(L.spareNights(150), 2)
  assert.equal(L.needPeriod(cfg.goods[1], 70), 4)
  assert.equal(L.needPeriod(cfg.goods[2], 120), 1)
  // tea 1+2 >= 2 (over 1), oil 3 < 4, dumplings 2 >= 1 (over 1), silk no taste, charms 15 >= 12 (over 3)
  assert.deepEqual(L.villagerWants(ansel, cfg, 'quiet').map((w) => w.good), [4, 0, 2])
  assert.deepEqual(L.villagerWants(ansel, cfg, 'quiet').map((w) => w.over), [3, 1, 1])
  // a festival on oil makes him want it too: max(3, 4) + 1 - 4 = 1 overdue
  assert.ok(L.villagerWants(ansel, cfg, { festival: { good: 1 } }).some((w) => w.good === 1 && w.over === 1))
  // tea: 60 * 100 * 115 * 150 * 100 / 1e8 = 103; at a rep-200 stall with memory 3: floor(103 * 105 / 100) = 108
  assert.equal(L.willingness(cfg.goods[0], 100, 1, 150, 'quiet', 0), 103)
  assert.equal(L.stallWtp(103, 200, 3), 108)
  assert.equal(L.willingness(cfg.goods[0], 100, 1, 150, 'payday', 0), 113)
  assert.equal(L.willingness(cfg.goods[0], 100, 1, 150, { festival: { good: 0 } }, 0), 134)
})

test('forecast counts who wants what and what each would pay here', () => {
  const fc = L.forecast(quiet, cfg, me)
  assert.equal(fc[0].wanted, 1) // only Ansel wants tea
  assert.equal(fc[2].wanted, 2) // both want dumplings
  assert.equal(fc[1].wanted, 1) // Ines wants oil, 11 nights overdue
  assert.equal(fc[3].wanted, 0)
  assert.equal(fc[0].rivalStock, 9)
  assert.equal(fc[0].rivalMin, 99)
  const tea = fc[0].buyers[0]
  assert.equal(tea.name, 'Ansel')
  assert.equal(tea.eff, 108)
  assert.equal(tea.reach, (58 + 25) / 100) // he remembers this stall
  // Kettle asks 99 for tea; Ansel would pay floor(103 * 105/100) = 108 there (rep 511 -> +5, no memory): surplus 9
  assert.equal(tea.rivals.length, 1)
  assert.equal(tea.rivals[0].surplus, 9)
  // at 95 our surplus is 13 > 9: only the walk-by chance is left; at 105 the Kettle wins when he passes it
  assert.ok(Math.abs(L.expectSales(fc, 0, 95) - 0.83) < 1e-9)
  assert.ok(Math.abs(L.expectSales(fc, 0, 105) - 0.83 * (1 - 0.97)) < 1e-9)
  assert.equal(L.expectSales(fc, 0, 200), 0)
  assert.equal(L.expectSales(fc, 0, 95, { stock: 0 }), 0)
})

test('suggested prices follow the villagers and stay within the band', () => {
  const s = L.suggestPrices(quiet, cfg, me)
  // tea: floor max(45, 57) = 57, ceiling 84; Ansel pays up to 108, Kettle's surplus 9: 84 earns the most
  assert.equal(s[0].price, 84)
  assert.match(s[0].reason, /would buy|would pay it/)
  // silk: nobody wants it tonight: just under Uncle's 387, capped at 140% of fair = 490 -> 386
  assert.equal(s[3].price, 386)
  assert.match(s[3].reason, /nobody wants it/)
  for (let g = 0; g < 5; g++) assert.ok(s[g].price <= cfg.goods[g].max_price && s[g].price > 0)
  // a festival on tea: Ines wants it too but can pay only 76, and two units each beat Ansel alone at 105
  assert.equal(L.suggestPrices(world, cfg, me)[0].price, 76)
  assert.match(L.suggestPrices(world, cfg, me)[0].reason, /festival: ~3 would pay it/)
  // with Ansel alone the ceiling rises to 175% of fair, and the Kettle's surplus (41) beats ours at 105, so 76 it stays
  assert.equal(L.suggestPrices({ ...world, villagers: [ansel] }, cfg, { ...me, rep: 900 })[0].price, 105)
})

test('suggested prices without rivals or villagers fall back to a fair price', () => {
  const lonely = { ...quiet, row: [me], villagers: [] }
  const s = L.suggestPrices(lonely, cfg, me)
  assert.equal(s[0].price, 96) // 160% of 60: nobody else sells it
  assert.match(s[0].reason, /nobody wants it/)
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
  const moved = L.project(me, [{ move: { stall: 14, spot: 3, max_fee: 100 } }], world, cfg)
  assert.equal(moved.spot, 3)
  assert.equal(moved.footfall, 91)
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
  assert.match(text, /Sold 2 tea for 190 and 4 dumplings for 200/)
  assert.match(text, /Sold out of dumplings/)
  assert.match(text, /V8 found your tea too dear at 95\. Nobody on the row was cheap enough for V8\./)
  assert.match(text, /Sold out of dumplings after 4\. Stock more next time\./)
  assert.match(text, /Rent 21 for spot 14\./)
  const caught = L.summariseNight({ log, stall: { ...after, rent_paid: 730 }, before, world: { ...world, villagers }, cfg, villagers, nights: 30 })
  assert.match(caught.lines.map((l) => l.text).join('\n'), /Rent 630 for spot 14, over the 30 nights/)
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
  assert.match(L.summariseNight({ ...base, stall: back, before: back }).lines[0].text, /40% of villagers walk as far as spot 20/)
})

test('event info and forecast read well', () => {
  assert.equal(L.eventInfo('quiet', cfg).kind, 'quiet')
  assert.equal(L.eventInfo('payday', cfg).title, 'Payday')
  assert.equal(L.eventInfo({ festival: { good: 3 } }, cfg).title, 'Festival of silk')
  assert.equal(L.eventInfo({ storm: { good: 1 } }, cfg).good, 1)
  assert.equal(L.forecastLine(world, cfg), 'Bumper dumplings next night.')
  assert.deepEqual(L.bannerText(world, cfg), { title: 'Festival of tea', detail: 'ends tonight · then Bumper dumplings', kind: 'festival', good: 0, next: L.eventInfo(world.event_next, cfg) })
  assert.equal(L.bannerText({ ...quiet, event_next: { storm: { good: 1 } } }, cfg).detail, 'then Storm on lamp oil')
  assert.equal(L.eventInfo({ storm: { good: 1 } }, cfg).title, 'Storm: little lamp oil')
  assert.equal(L.forecastLine({ ...world, event_left: 3, event_next: 'quiet' }, cfg), 'Quiet nights in 3 nights.')
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
  assert.equal(L.listWords(['tea', 'oil', 'silk']), 'tea, oil and silk')
  assert.equal(L.listWords(['tea']), 'tea')
  assert.equal(L.spotLabel(0), 'spot 0')
  assert.equal(L.spotLabel(null), 'off the row')
  const board = [{ id: 1, rank: 1, spot: 1 }, { id: 9, rank: 2, spot: null }, { id: 14, rank: 3, spot: null }, { id: 6, rank: 4, spot: 20 }]
  assert.deepEqual(L.visibleBoard(board, 14).map((r) => [r.id, r.rank]), [[1, 1], [14, 2], [6, 3]])
})

test('tonight\'s call: one decision a night, from the rules', () => {
  // the festival on tea is tonight: price for it and fill up
  const fest = L.nightlyCall({ world: { ...world, event_left: 2, event_next: 'quiet' }, cfg, stall: { ...me, stock: [2, 0, 0, 0, 0], price: [60, 0, 0, 0, 0] } })
  assert.equal(fest.kind, 'festival-price')
  assert.equal(fest.good, 0)
  assert.ok(fest.accept.actions.some((a) => a.buy?.good === 0))
  assert.ok(fest.accept.actions.some((a) => a.price?.good === 0 && a.price.price === 76))
  assert.match(fest.accept.label, /Stock 2 and price at 76/)
  assert.match(fest.expect, /About 3 sales at 76/)

  // a festival of silk starts next night: stock silk now
  const before = L.nightlyCall({ world: { ...quiet, event_left: 1, event_next: { festival: { good: 3 } } }, cfg, stall: me })
  assert.equal(before.kind, 'festival-stock')
  assert.equal(before.good, 3)
  assert.equal(before.accept.actions[0].buy.good, 3)
  assert.equal(before.accept.actions[0].buy.qty, 3) // the Dock only has 3
  assert.ok(before.accept.cost >= L.dockCost(cfg.goods[3], dock[3], 3))
  assert.match(before.expect, /Could sell for about 525 each/)

  // a storm on oil next night
  const storm = L.nightlyCall({ world: { ...quiet, event_left: 1, event_next: { storm: { good: 1 } } }, cfg, stall: me })
  assert.equal(storm.kind, 'storm-stock')
  assert.equal(storm.accept.actions[0].buy.qty, 7)

  // bumper dumplings next night: wait
  const wait = L.nightlyCall({ world: { ...quiet, event_left: 1, event_next: { bumper: { good: 2 } } }, cfg, stall: me })
  assert.equal(wait.kind, 'bumper-wait')
  assert.equal(wait.accept.skip, 2)
  assert.equal(wait.priceThen, 23)

  // payday: raise prices
  const pay = L.nightlyCall({ world: { ...quiet, event: 'payday' }, cfg, stall: { ...me, stock: [5, 0, 5, 0, 0], price: [80, 0, 50, 0, 0] } })
  assert.equal(pay.kind, 'payday-price')
  assert.deepEqual(pay.accept.actions.map((a) => a.price.price), [86, 54])

  // sold out last night with buyers left over
  const log = { night: 40, sales: [[1, 14, 2, 50], [2, 14, 2, 50], [3, 2, 2, 60], [4, 1, 0, 99]], refusals: [], missed: [[5, 2]] }
  const soldOut = L.nightlyCall({ world: quiet, cfg, stall: { ...me, stock: [0, 0, 0, 0, 0], price: [0, 0, 50, 0, 0], sold_last: [0, 0, 2, 0, 0] }, log })
  assert.equal(soldOut.kind, 'sold-out')
  assert.equal(soldOut.good, 2)
  assert.match(soldOut.text, /2 sold last night and 2 more/)

  // two refusals on tea while the Kettle is cheaper: cut
  const refusedLog = { night: 40, sales: [], refusals: [[1, 14, 0], [2, 14, 0]], missed: [] }
  const cut = L.nightlyCall({ world: quiet, cfg, stall: { ...me, stock: [5, 0, 0, 0, 0], price: [150, 0, 0, 0, 0] }, log: refusedLog })
  assert.equal(cut.kind, 'price-cut')
  assert.equal(cut.accept.actions[0].price.price, 84)
  assert.match(cut.decline.label, /Hold at 150/)

  // a quiet night with nothing short: undercut on the most wanted good (dumplings, 2 want it)
  const plain = L.nightlyCall({ world: quiet, cfg, stall: { ...me, stock: [0, 0, 1, 0, 0], price: [0, 0, 57, 0, 0] } })
  assert.ok(plain, 'there is always something to say on a quiet night with demand')
  assert.ok(['gap', 'undercut'].includes(plain.kind))

  // no call off the row, while listed, or with no demand at all
  assert.equal(L.nightlyCall({ world: quiet, cfg, stall: { ...me, spot: null } }), null)
  assert.equal(L.nightlyCall({ world: quiet, cfg, stall: { ...me, listed: 500 } }), null)
  assert.equal(L.nightlyCall({ world: { ...quiet, villagers: [] }, cfg, stall: me }), null)
})

test('the call is judged by what the night log says', () => {
  const call = { kind: 'gap', good: 2, accept: { cost: 120, actions: [{ buy: { stall: 14, good: 2, qty: 6, max_cost: 200 } }] } }
  const won = { night: 41, sales: [[1, 14, 2, 50], [2, 14, 2, 50], [3, 14, 2, 50], [4, 2, 2, 60]], refusals: [], missed: [] }
  const j = L.judgeCall(call, { log: won, stall: me, cfg, accepted: true })
  assert.equal(j.met, true)
  assert.match(j.text, /paid off: 3 dumplings sold for 150 \(stock cost 120\)/)
  const lost = { night: 41, sales: [[4, 2, 2, 60]], refusals: [[5, 14, 2]], missed: [] }
  const k = L.judgeCall(call, { log: lost, stall: me, cfg, accepted: true })
  assert.equal(k.met, false)
  assert.match(k.text, /none of the dumplings sold tonight, 1 found it too dear/)
  const skipped = L.judgeCall(call, { log: lost, stall: me, cfg, accepted: false })
  assert.equal(skipped.met, null)
  assert.match(skipped.text, /You skipped dumplings: 1 bought it from the merchants/)
  const wait = L.judgeCall({ kind: 'bumper-wait', good: 2, priceThen: 23 }, { log: lost, stall: me, cfg, accepted: true, world: { dock: [{}, {}, { price: 16 }] } })
  assert.equal(wait.met, true)
  assert.match(wait.text, /fell from 23 to 16/)
  assert.equal(L.judgeCall(null, { log: lost }), null)
})

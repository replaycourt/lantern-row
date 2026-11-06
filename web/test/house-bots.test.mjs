// The house bots: their labels on the page, and the rules of scripts/house-bots.mjs. Pure functions,
// no network, no keys.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { HOUSE_BOTS, houseBot, isHouseBot } from '../js/house-bots.js'
import * as L from '../js/logic.js'
import * as U from '../js/ui.js'
import { STRATEGIES, dailyCost, describe, loadBots, main, planTurn } from '../../scripts/house-bots.mjs'

const goods = [
  { name: 'tea', fair: 60, dock_base: 30, heat_slope: 120, max_price: 600 },
  { name: 'lamp oil', fair: 90, dock_base: 46, heat_slope: 80, max_price: 900 },
  { name: 'dumplings', fair: 40, dock_base: 20, heat_slope: 180, max_price: 400 },
  { name: 'silk', fair: 350, dock_base: 170, heat_slope: 24, max_price: 3500 },
  { name: 'charms', fair: 180, dock_base: 90, heat_slope: 45, max_price: 1800 },
]
const spots = Array.from({ length: 24 }, (_, spot) => ({ spot, fee: 12 * (24 - spot) ** 2 }))
const cfg = { goods, spots, max_actions_per_call: 16, tier_cost: [0, 5000, 14000, 36000], tier_capacity: [40, 80, 140, 220], tier_service: [10, 14, 18, 24] }
const dock = [
  { price: 31, left: 12, heat: 2, factor_pct: 100 },
  { price: 47, left: 7, heat: 1, factor_pct: 100 },
  { price: 21, left: 18, heat: 3, factor_pct: 100 },
  { price: 178, left: 3, heat: 1, factor_pct: 100 },
  { price: 92, left: 5, heat: 1, factor_pct: 100 },
]
const kettle = { id: 1, name: 'The Quiet Kettle', npc: true, owner: 'lantern-row.testnet', spot: 1, stock: [9, 2, 0, 0, 1], price: [99, 127, 0, 0, 258], rep: 511 }
const honey = { id: 25, name: 'Honey Lantern', npc: false, owner: '2fad929bc7'.padEnd(64, '0'), spot: 23, stock: [4, 0, 0, 0, 0], price: [70, 0, 0, 0, 0], rep: 200 }
const kettleBot = HOUSE_BOTS[0]
const botStall = (over = {}) => ({ id: 30, name: kettleBot.name, npc: false, owner: kettleBot.account, founder: kettleBot.account, spot: 22, money: 3000, stock: [0, 0, 0, 0, 0], price: [0, 0, 0, 0, 0], capacity: 40, tier: 0, rep: 200, worth: 3000, last_action: 40, ...over })
const world = (row) => ({ night: 41, event: 'quiet', event_left: 1, event_next: 'quiet', dock, row, villagers: [] })

test('the house bots are listed with a valid name, an implicit account and a known strategy', () => {
  assert.equal(HOUSE_BOTS.length, 5)
  assert.equal(new Set(HOUSE_BOTS.map((b) => b.account)).size, 5)
  for (const b of HOUSE_BOTS) {
    assert.match(b.account, /^[0-9a-f]{64}$/)
    assert.ok(b.name.startsWith('Bot - ') && b.name.length <= 24, b.name)
    assert.ok(L.validName(b.name), `the contract accepts "${b.name}"`)
    assert.ok(STRATEGIES[b.strategy], b.strategy)
    assert.ok(b.rule.length > 10)
  }
  assert.equal(houseBot(kettleBot.account), kettleBot)
  assert.equal(houseBot('someone.testnet'), null)
  assert.equal(houseBot(undefined), null)
  assert.ok(isHouseBot(botStall()))
  assert.ok(!isHouseBot(honey))
  assert.ok(!isHouseBot(kettle))
  assert.ok(!isHouseBot(null))
})

test('the title counts house bots apart from player stalls', () => {
  const line = (w) => L.titleLine(w, { goods }).replaceAll(' ', ' ')
  assert.equal(line(world([kettle, honey])), 'Night 41 · no villagers shopping · 1 merchant · 1 player stall')
  assert.equal(line(world([kettle, honey, botStall(), botStall({ id: 31, owner: HOUSE_BOTS[1].account })])), 'Night 41 · no villagers shopping · 1 merchant · 1 player stall · 2 house bots')
  assert.equal(line(world([kettle, botStall()])), 'Night 41 · no villagers shopping · 1 merchant · no player stalls yet · 1 house bot')
})

test('ranks, the stall peek and the deed card tag house-bot stalls', () => {
  const board = [
    { rank: 1, id: 1, name: 'The Quiet Kettle', npc: true, owner: 'lantern-row.testnet', worth: 61000, spot: 1, tier: 1 },
    { rank: 2, id: 30, name: kettleBot.name, npc: false, owner: kettleBot.account, worth: 3400, spot: 22, tier: 0 },
    { rank: 3, id: 25, name: 'Honey Lantern', npc: false, owner: honey.owner, worth: 3300, spot: 23, tier: 0 },
  ]
  const html = U.boardHtml(board, 25)
  const items = html.match(/<li[^>]*>.*?<\/li>/g)
  const bot = items.find((li) => li.includes(kettleBot.name))
  assert.match(bot, /class="player bot"/)
  assert.match(bot, /<span class="bot-tag"[^>]*>house bot<\/span>/)
  assert.ok(!items.find((li) => li.includes('Honey Lantern')).includes('bot-tag'), 'a player is not tagged')
  assert.ok(!items.find((li) => li.includes('The Quiet Kettle')).includes('bot-tag'), 'a merchant is not tagged')
  assert.match(html, /run by a script with fixed rules/)
  assert.ok(!U.boardHtml(board.filter((r) => r.id !== 30), 25).includes('bot-tag'), 'no note without bots')

  const deed = (stall) => U.deedHtml({ stall: { footfall: 34, holders: [], customers: 0, listed: null, ...stall }, token: null, cfg, account: honey.owner, royaltyPct: 5, freeSpots: [] })
  assert.match(deed(botStall()), /deed-title">Bot - Tin Kettle <span class="bot-tag"/)
  // a player's stall founded by a bot (bought or given) still shows who founded it
  const bought = deed(botStall({ owner: honey.owner, name: 'Was A Bot' }))
  assert.ok(!/deed-title">[^<]*<span class="bot-tag"/.test(bought))
  assert.match(bought, /Founder <code>[^<]+<\/code> <span class="bot-tag"/)
  assert.ok(!deed({ ...honey, founder: honey.owner, money: 100, worth: 100, tier: 0 }).includes('bot-tag'))
})

test('every strategy plans a valid visit: prices in bounds, a margin, a quarter of the Dock left, coin kept', () => {
  for (const id of Object.keys(STRATEGIES)) {
    const stall = botStall()
    const acts = planTurn(id, stall, world([kettle, honey, stall]), cfg)
    assert.ok(acts.length > 0 && acts.length <= 16, id)
    let spent = 0
    for (const a of acts) {
      if (a.price) {
        const g = a.price.good
        assert.ok(STRATEGIES[id].mix[g] > 0, `${id} prices only what it carries`)
        assert.ok(a.price.price >= 1 && a.price.price <= goods[g].max_price)
      }
      if (a.buy) {
        const { good: g, qty, max_cost } = a.buy
        const price = acts.find((x) => x.price?.good === g).price.price
        assert.ok(dock[g].price * 1.1 < price, `${id} buys ${goods[g].name} only with a margin`)
        assert.ok(qty <= dock[g].left - Math.ceil(dock[g].left / 4), `${id} leaves a quarter of the Dock`)
        assert.ok(qty <= STRATEGIES[id].mix[g])
        const cost = L.dockCost(goods[g], dock[g], qty)
        assert.ok(cost <= stall.money * 0.3 && max_cost >= cost)
        spent += cost
      }
    }
    assert.ok(stall.money - spent >= 600, `${id} keeps a reserve`)
    assert.equal(acts.findIndex((a) => a.buy) === -1 || acts.slice(acts.findIndex((a) => a.buy)).every((a) => a.buy), true, 'prices go before purchases')
  }
})

test('the strategies price the way their rules say', () => {
  const s = botStall()
  const price = (id, w = world([kettle, honey, s])) => Object.fromEntries(planTurn(id, s, w, cfg).filter((a) => a.price).map((a) => [a.price.good, a.price.price]))
  assert.deepEqual(price('restocker'), { 0: 60, 1: 90, 2: 40, 3: 350, 4: 180 })
  assert.deepEqual(price('discounter'), { 0: 54, 1: 81, 2: 36 })
  assert.deepEqual(price('premium'), { 0: 75, 1: 112, 3: 437, 4: 225 })
  // watcher: tea 3% under Honey Lantern's 70 is 67; oil 3% under the Kettle's 127 is 123, charms under
  // its 258 is 250; nobody has dumplings or silk: the cap, 140% of fair
  assert.deepEqual(price('watcher'), { 0: 67, 1: 123, 2: 56, 3: 490, 4: 250 })
  assert.equal(price('watcher', world([{ ...kettle, price: [99, 127, 0, 0, 400] }, s]))[4], 252) // capped
  // never below 95% of fair
  assert.equal(price('watcher', world([kettle, { ...honey, price: [30, 0, 0, 0, 0] }, s]))[0], 57)
  // shadow ignores the player's cheap tea and follows the merchant: 90% of 99 is 89
  assert.equal(price('shadow')[0], 89)
  assert.equal(price('shadow')[2], 40) // no merchant has dumplings: fair
})

test('a bot does nothing when nothing changed, unless its stall needs tending to keep its spot', () => {
  const s = botStall({ stock: [10, 8, 6, 2, 4], price: [60, 90, 40, 350, 180] })
  assert.deepEqual(planTurn('restocker', s, world([kettle, s]), cfg), [])
  assert.deepEqual(planTurn('restocker', s, world([kettle, s]), cfg, { keepAlive: true }), [{ price: { stall: 30, good: 0, price: 60 } }])
  // off the row: back onto the worst free spot first
  const off = botStall({ spot: null })
  const acts = planTurn('restocker', off, world([kettle, honey]), cfg)
  assert.deepEqual(acts[0], { move: { stall: 30, spot: 22, max_fee: 48 } })
  assert.equal(describe(acts.slice(0, 3)), 'move spot 22 · price tea 60, oil 90')
})

test('no margin, no purchase; a full stall buys nothing', () => {
  const s = botStall()
  const dear = dock.map((d, g) => ({ ...d, price: goods[g].fair * 2 }))
  assert.ok(!planTurn('restocker', s, { ...world([s]), dock: dear }, cfg).some((a) => a.buy))
  const full = botStall({ stock: [40, 0, 0, 0, 0] })
  assert.ok(!planTurn('restocker', full, world([full]), cfg).some((a) => a.buy))
})

test('bot keys come only from the secret, and only for listed accounts', async () => {
  assert.equal(await main([], {}), 0) // no secret: nothing to do, no network
  assert.throws(() => loadBots('not json'), /not valid JSON/)
  assert.throws(() => loadBots('[]'), /non-empty/)
  assert.throws(() => loadBots('["abc"]'), /not a 64-character hex seed/)
  const stranger = crypto.randomBytes(32).toString('hex')
  assert.throws(() => loadBots(JSON.stringify([stranger])), (e) => /refusing to run an unlabelled bot/.test(e.message) && !e.message.includes(stranger))
  assert.equal(dailyCost({ keeperEvery: 5, botEvery: 15, bots: 5, keeperNear: 0.001, actNear: 0.0004 }).near.toFixed(3), '0.480')
})

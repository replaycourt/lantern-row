// Pure game logic of the client: no DOM, no network, no canvas. Everything here is unit-tested with
// `node --test web/test`. The rules it mirrors are in SPEC.md; the contract is the truth, this only
// helps the player decide and explains what happened.

export const GOODS = ['tea', 'lamp oil', 'dumplings', 'silk', 'charms']
export const GOOD_SHORT = ['Tea', 'Oil', 'Dumplings', 'Silk', 'Charms']

/** The mix a sensible stall carries at size 0; the same shape the economy simulation's Trader uses. */
export const MIX = [8, 5, 10, 2, 3]

export const fmt = (n) => (n == null ? '–' : Math.round(n).toLocaleString('en-US'))

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

/** Names allowed by the contract: 1 to 24 letters, digits, spaces, - and '. */
export function validName(name) {
  return /^[A-Za-z0-9 '\-]{1,24}$/.test(name) && name.trim().length > 0
}

export function cleanName(name) {
  return String(name ?? '')
    .replace(/[^A-Za-z0-9 '\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24)
}

const ADJ = ['Amber', 'Paper', 'Jade', 'Velvet', 'Lucky', 'Quiet', 'Golden', 'Little', 'Moonlit', 'Honey', 'Copper', 'Plum', 'Misty', 'Silver', 'Warm', 'Humble']
const NOUN = ['Teapot', 'Moon', 'Fox', 'Lantern', 'Crane', 'Kettle', 'Thread', 'Ember', 'Pear', 'Sparrow', 'Willow', 'Comet', 'Pebble', 'Bell', 'Compass', 'Otter']

export function randomStallName(rand = Math.random) {
  return `${ADJ[Math.floor(rand() * ADJ.length)]} ${NOUN[Math.floor(rand() * NOUN.length)]}`
}

export function shortAccount(acc) {
  if (!acc) return ''
  if (acc.length <= 20) return acc
  return `${acc.slice(0, 6)}…${acc.slice(-4)}`
}

/** A stable hue per stall for awnings and the HUD. */
export function stallHue(id) {
  return (id * 137 + 20) % 360
}

/** Spots are numbered as the chain numbers them: 0 at the gate, 23 at the back. The NFT says the same. */
export function spotLabel(spot) {
  return spot == null ? 'off the row' : `spot ${spot}`
}

/** "tea, oil and silk" */
export function listWords(words) {
  const u = [...new Set(words)]
  if (u.length <= 1) return u.join('')
  return `${u.slice(0, -1).join(', ')} and ${u[u.length - 1]}`
}

// ---- the Dock -----------------------------------------------------------------------------------

/** Cost of q units at the Dock right now (SPEC section 6). */
export function dockCost(good, dock, q) {
  if (q <= 0) return 0
  const s = good.heat_slope
  const h = dock.heat
  const f = dock.factor_pct ?? 100
  return Math.ceil((good.dock_base * f * (q * s + h * q + (q * (q - 1)) / 2)) / (100 * s))
}

/** The most units of a good one can buy with `money`, up to `max`. */
export function affordable(good, dock, money, max) {
  let q = 0
  while (q < max && dockCost(good, dock, q + 1) <= money) q++
  return q
}

// ---- the villagers' minds, exactly as the contract works them out (SPEC section 5) ---------------

export function wealthPct(wallet, wage) {
  return Math.min(150, 60 + Math.floor((wallet * 40) / (5 * Math.max(1, wage))))
}
export function spareNights(wealth) {
  return Math.floor(Math.max(0, wealth - 100) / 25)
}
export function needPeriod(good, taste) {
  return taste === 0 ? Infinity : Math.max(1, Math.floor((good.need_period * 100) / taste))
}
export function eventGood(event, kind) {
  return event && typeof event === 'object' && event[kind] ? event[kind].good : null
}

/** What a villager wants tonight: [{good, over}] most overdue first, at most four. */
export function villagerWants(v, cfg, event) {
  const wealth = wealthPct(v.wallet, v.wage)
  const spare = spareNights(wealth)
  const fest = eventGood(event, 'festival')
  const out = []
  cfg.goods.forEach((good, g) => {
    const taste = v.taste?.[g] ?? 0
    if (!taste) return
    const period = needPeriod(good, taste)
    let unmet = (v.unmet?.[g] ?? 0) + spare
    if (fest === g) unmet = Math.max(unmet, period) + 1
    if (unmet >= period) out.push({ good: g, over: unmet - period })
  })
  out.sort((a, b) => b.over - a.over)
  return out.slice(0, 4)
}

/** The most a villager pays for a good tonight, before stall reputation and memory. */
export function willingness(good, taste, over, wealth, event, g) {
  const ev = eventGood(event, 'festival') === g ? 130 : event === 'payday' ? 110 : 100
  const unmet = 100 + 15 * Math.min(over, 8)
  return Math.floor((good.fair * taste * unmet * wealth * ev) / 100000000)
}

/** Willingness at one particular stall: reputation and memory make villagers pay a little more. */
export function stallWtp(wtp, rep, memory) {
  return Math.floor((wtp * (100 + Math.floor(rep / 100) + memory)) / 100)
}

/**
 * Tonight's demand per good as the contract will see it: who wants what, what each would pay at
 * this stall, how likely they are to pass by, and what the rivals offer them. Returns one entry per
 * good: {wanted, rivalStock, rivalMin, buyers: [{name, eff, wallet, reach, units, rivals}]}.
 */
export function forecast(world, cfg, stall) {
  const rivals = (world?.row ?? []).filter((x) => x.id !== stall.id && x.spot != null)
  const fest = eventGood(world?.event, 'festival')
  const out = cfg.goods.map((_, g) => {
    let rivalStock = 0
    let rivalMin = null
    for (const x of rivals) {
      if (x.stock[g] > 0 && x.price[g] > 0) {
        rivalStock += x.stock[g]
        rivalMin = rivalMin == null ? x.price[g] : Math.min(rivalMin, x.price[g])
      }
    }
    return { good: g, wanted: 0, rivalStock, rivalMin, buyers: [] }
  })
  const mem = (v, id) => v.memory?.find((m) => m[0] === id)?.[1] ?? 0
  const reach = (spot, remembered) => (spot == null ? 0 : Math.min(1, (100 - 3 * spot + (remembered ? 25 : 0)) / 100))
  for (const v of world?.villagers ?? []) {
    const wealth = wealthPct(v.wallet, v.wage)
    for (const { good: g, over } of villagerWants(v, cfg, world.event)) {
      const wtp = willingness(cfg.goods[g], v.taste[g], over, wealth, world.event, g)
      const m = mem(v, stall.id)
      const eff = stallWtp(wtp, stall.rep, m)
      const offers = []
      for (const x of rivals) {
        if (!(x.stock[g] > 0 && x.price[g] > 0)) continue
        const mx = mem(v, x.id)
        const ex = stallWtp(wtp, x.rep, mx)
        if (x.price[g] > ex || x.price[g] > v.wallet) continue
        offers.push({ surplus: ex - x.price[g], reach: reach(x.spot, mx > 0), ahead: x.spot < (stall.spot ?? 99) })
      }
      out[g].wanted++
      out[g].buyers.push({ name: v.name, eff, wallet: v.wallet, reach: reach(stall.spot, m > 0), units: fest === g ? 2 : 1, rivals: offers })
    }
  }
  return out
}

/**
 * About how many units of a good this stall sells tonight at a price: villagers who want it, can pay
 * it, pass by, and find no better deal on their walk. Chance, not certainty: the walk is random.
 */
export function expectSales(fc, g, price, { stock = Infinity } = {}) {
  if (!(price > 0) || !fc?.[g]) return 0
  let e = 0
  for (const b of fc[g].buyers) {
    if (b.eff < price || b.wallet < price) continue
    const mine = b.eff - price
    let p = b.reach
    for (const o of b.rivals) if (o.surplus > mine || (o.surplus === mine && o.ahead)) p *= 1 - o.reach
    e += p * b.units
  }
  return Math.min(e, stock)
}

/** The price that brings the most coin tonight, from the villagers' own willingness. */
export function bestPrice(fc, g, { floor, ceiling, stock }) {
  const levels = new Set([floor, ceiling])
  for (const b of fc[g].buyers) if (b.eff >= floor && b.eff <= ceiling) levels.add(b.eff)
  if (fc[g].rivalMin && fc[g].rivalMin - 1 >= floor && fc[g].rivalMin - 1 <= ceiling) levels.add(fc[g].rivalMin - 1)
  let best = null
  for (const p of [...levels].sort((a, b) => a - b)) {
    const n = expectSales(fc, g, p, { stock })
    const take = p * n
    if (!best || take > best.take * 1.03) best = { price: p, take, sales: n }
  }
  return best
}

// ---- advice -------------------------------------------------------------------------------------

/**
 * A price per good that pays tonight: the price that brings the most coin from the villagers who
 * want the good, within a band of 125% of the Dock up to 140% of fair (more during a festival or
 * when nobody else sells it). Returns [{price, reason, sales}].
 */
export function suggestPrices(world, cfg, stall, fc = forecast(world, cfg, stall)) {
  return cfg.goods.map((good, g) => {
    const unit = world.dock[g].price
    const f = fc[g]
    const fest = eventGood(world.event, 'festival') === g
    const storm = eventGood(world.event, 'storm') === g
    const alone = f.rivalStock === 0
    const floor = Math.max(Math.floor((unit * 125) / 100), Math.floor((good.fair * 95) / 100))
    const ceiling = Math.max(floor, Math.floor((good.fair * (fest ? 175 : alone || (storm && f.rivalStock <= 2) ? 160 : 140)) / 100))
    const stock = Math.max(stall.stock[g], Math.floor(MIX[g] * (1 + stall.tier / 2)))
    let price, reason, sales
    if (f.wanted === 0) {
      price = f.rivalMin ? Math.min(ceiling, Math.max(floor, f.rivalMin - 1)) : ceiling
      reason = 'nobody wants it tonight; priced to keep'
      sales = 0
    } else {
      const b = bestPrice(fc, g, { floor, ceiling, stock })
      price = b.price
      sales = b.sales
      if (sales < 0.5) {
        // nobody can be won at a paying price: sit just under the rivals and wait for needs to grow
        price = f.rivalMin ? Math.min(ceiling, Math.max(floor, Math.floor((f.rivalMin * 94) / 100))) : floor
        reason = f.rivalMin ? `under the rivals' ${f.rivalMin}; needs grow each night` : 'as low as still pays'
      } else if (fest) reason = `festival: ~${Math.round(sales)} would pay it`
      else if (alone) reason = `nobody else sells it; ~${Math.round(sales)} would pay it`
      else if (f.rivalMin && price < f.rivalMin) reason = `under the rivals' ${f.rivalMin}; ~${Math.round(sales)} would buy`
      else reason = `~${Math.round(sales)} would pay it even above the rivals' ${f.rivalMin}`
    }
    return { price: Math.min(price, good.max_price), reason, sales }
  })
}

/**
 * What to buy to fill the stall towards a sensible mix, within money, capacity and tonight's Dock
 * supply. Buys more of a good the night before a festival or storm for it, more of what many want
 * tonight, and none of a good the player chose to wait on. Returns {items: [{good, qty, cost}], total}.
 */
export function suggestRestock(world, cfg, stall, { reserve = Math.max(150, Math.floor(stall.money * 0.2)), skip = null, fc = null } = {}) {
  let room = stall.capacity - stall.stock.reduce((a, b) => a + b, 0)
  let money = Math.max(0, stall.money - reserve)
  const soon = world.event_left === 1
  const items = []
  // Dumplings spoil fast, so they come last; silk and charms are dear, so they come after the staples.
  const order = [0, 1, 4, 3, 2]
  for (const g of order) {
    if (g === skip) continue
    const good = cfg.goods[g]
    const fest = (soon && eventGood(world.event_next, 'festival') === g) || eventGood(world.event, 'festival') === g
    const storm = soon && eventGood(world.event_next, 'storm') === g
    let target = Math.floor(MIX[g] * (1 + stall.tier / 2) * (fest ? 2 : storm ? 1.5 : 1))
    if (fc) {
      // many want it and the merchants hold little: carry up to what they want, within reason
      const gap = fc[g].wanted - fc[g].rivalStock
      if (gap > 0) target = Math.max(target, Math.min(fc[g].wanted, Math.floor(target * 1.6)))
      else if (fc[g].wanted === 0 && !fest && !storm) target = Math.min(target, Math.ceil(MIX[g] / 2))
    }
    const want = Math.max(0, target - stall.stock[g])
    const cap = Math.min(want, room, world.dock[g].left, Math.floor((MIX[g] / 28) * 2 * stall.capacity))
    const qty = affordable(good, world.dock[g], Math.floor(money * (g === 3 ? 0.35 : 0.45)), cap)
    if (qty > 0) {
      const cost = dockCost(good, world.dock[g], qty)
      items.push({ good: g, qty, cost })
      room -= qty
      money -= cost
    }
  }
  return { items, total: items.reduce((a, i) => a + i.cost, 0) }
}

/** Turns restock advice into contract actions. */
export function restockActions(stallId, plan, slack = 1.3) {
  return plan.items.map((i) => ({ buy: { stall: stallId, good: i.good, qty: i.qty, max_cost: Math.ceil(i.cost * slack) + 2 } }))
}

/**
 * Collapses a list of queued actions into what one `act` call should carry: the last price per good
 * wins, buys of the same good merge, anything else stays in order. At most `max` actions.
 */
export function coalesce(actions, max = 16) {
  const out = []
  for (const a of actions) {
    if (a.price) {
      const i = out.findIndex((x) => x.price && x.price.good === a.price.good && x.price.stall === a.price.stall)
      if (i >= 0) {
        out[i] = a
        continue
      }
    } else if (a.buy) {
      const i = out.findIndex((x) => x.buy && x.buy.good === a.buy.good && x.buy.stall === a.buy.stall)
      if (i >= 0) {
        out[i] = { buy: { ...a.buy, qty: out[i].buy.qty + a.buy.qty, max_cost: out[i].buy.max_cost + a.buy.max_cost } }
        continue
      }
    }
    out.push(a)
  }
  // Prices first: they are never refused for lack of money or supply, so a refused buy cannot stop them.
  const prices = out.filter((a) => a.price)
  const others = out.filter((a) => !a.price)
  return [...prices, ...others].slice(0, max)
}

/** The stall as it will look once these actions apply, for optimistic UI. */
export function project(stall, actions, world, cfg) {
  const s = { ...stall, stock: [...stall.stock], price: [...stall.price] }
  for (const a of actions) {
    if (a.price) s.price[a.price.good] = a.price.price
    if (a.buy) {
      const cost = world ? dockCost(cfg.goods[a.buy.good], world.dock[a.buy.good], a.buy.qty) : a.buy.max_cost
      s.money -= Math.min(cost, a.buy.max_cost)
      s.stock[a.buy.good] += a.buy.qty
    }
    if (a.sell_back) {
      s.stock[a.sell_back.good] = Math.max(0, s.stock[a.sell_back.good] - a.sell_back.qty)
      s.money += a.sell_back.min_pay
    }
    if (a.upgrade) {
      s.money -= cfg.tier_cost[s.tier + 1] ?? 0
      s.tier += 1
      s.capacity = cfg.tier_capacity[s.tier] ?? s.capacity
      s.service = cfg.tier_service?.[s.tier] ?? s.service
    }
    if (a.move) {
      s.money -= a.move.max_fee ?? 0
      s.spot = a.move.spot
      s.footfall = 100 - 3 * a.move.spot
    }
    if (a.rename) s.name = a.rename.name
    if (a.list) s.listed = a.list.price
    if (a.unlist) s.listed = null
  }
  return s
}

/** The text the player signs; must equal the contract's `signing_text`. */
export function signingText(contract, nonce, action) {
  return `lantern-row:v1:${contract}:${nonce}:${action}`
}

// ---- events -------------------------------------------------------------------------------------

export function eventInfo(event, cfg) {
  if (!event || event === 'quiet') return { kind: 'quiet', title: 'A quiet night', short: 'quiet nights', line: 'Nothing special. Trade as usual.', good: null }
  if (event === 'payday') return { kind: 'payday', title: 'Payday', short: 'Payday', line: 'Wages are up by half. Villagers spend more freely.', good: null }
  const [kind, body] = Object.entries(event)[0]
  const g = body?.good
  const name = cfg?.goods?.[g]?.name ?? GOODS[g]
  if (kind === 'festival') return { kind, title: `Festival of ${name}`, short: `Festival of ${name}`, line: `Everyone wants ${name} tonight and buys two. They pay up to 30% more.`, good: g }
  if (kind === 'storm') return { kind, title: `Storm: little ${name}`, short: `Storm on ${name}`, line: `Little ${name} comes in, and the Dock charges half again. Stock up before it hits.`, good: g }
  if (kind === 'bumper') return { kind, title: `Bumper ${name}`, short: `Bumper ${name}`, line: `The Dock is flooded with ${name}: twice the supply at 30% off.`, good: g }
  return { kind, title: kind, short: kind, line: '', good: g ?? null }
}

/** The banner: what is on tonight, how long it lasts, and what comes next. */
export function bannerText(world, cfg) {
  const now = eventInfo(world.event, cfg)
  const next = eventInfo(world.event_next, cfg)
  const left = world.event_left ?? 1
  const parts = []
  if (now.kind !== 'quiet') parts.push(left > 1 ? `${left} nights left` : 'ends tonight')
  parts.push(`then ${next.short}`)
  return { title: now.title, detail: parts.join(' · '), kind: now.kind, good: now.good, next: next }
}

/** One-line announcement of what comes next. */
export function forecastLine(world, cfg) {
  const next = eventInfo(world.event_next, cfg)
  const when = world.event_left === 1 ? 'next night' : `in ${world.event_left} nights`
  if (next.kind === 'quiet') return `Quiet nights ${when}.`
  return `${next.short} ${when}.`
}

/**
 * The title screen's line about the street, all from the live world: the night, the villagers who
 * want something tonight (worked out as the contract does), the merchants and the player stalls.
 * Non-breaking spaces keep each part whole, so a narrow screen wraps only after a dot.
 */
export function titleLine(world, cfg) {
  const count = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`
  const shoppers = (world.villagers ?? []).filter((v) => villagerWants(v, cfg, world.event).length > 0).length
  const merchants = world.row.filter((s) => s.npc).length
  const players = world.row.length - merchants
  return [
    `Night ${fmt(world.night)}`,
    shoppers ? `${count(shoppers, 'villager')} shopping` : 'no villagers shopping',
    count(merchants, 'merchant'),
    players ? count(players, 'player stall') : 'no player stalls yet',
  ]
    .map((part) => part.replaceAll(' ', '\u00a0'))
    .join('\u00a0· ')
}

// ---- the walk, from a NightLog --------------------------------------------------------------------

/**
 * Turns a NightLog into a script per villager, in walking order:
 * [{villager, stops: [{stall, good, price, kind: 'buy'|'refuse'}], missed: [good]}].
 */
export function buildWalk(log) {
  const order = []
  const byV = new Map()
  const get = (v) => {
    if (!byV.has(v)) {
      byV.set(v, { villager: v, stops: [], missed: [] })
      order.push(v)
    }
    return byV.get(v)
  }
  const refusals = new Map()
  for (const [v, stall, good] of log.refusals ?? []) {
    const k = `${v}:${good}`
    if (!refusals.has(k)) refusals.set(k, [])
    refusals.get(k).push({ stall, good, kind: 'refuse' })
  }
  const seenGood = new Set()
  for (const [v, stall, good, price] of log.sales ?? []) {
    const e = get(v)
    const k = `${v}:${good}`
    if (!seenGood.has(k)) {
      seenGood.add(k)
      for (const r of refusals.get(k) ?? []) e.stops.push(r)
      refusals.delete(k)
    }
    e.stops.push({ stall, good, price, kind: 'buy' })
  }
  for (const [k, list] of refusals) {
    const v = Number(k.split(':')[0])
    const e = get(v)
    for (const r of list) e.stops.push(r)
  }
  for (const [v, good] of log.missed ?? []) get(v).missed.push(good)
  return order.map((v) => byV.get(v))
}

const BUY_LINES = {
  0: ['At last, tea!', 'Tea. Bliss.', 'A warm cup!', 'Just what I needed.'],
  1: ['Light for the night!', 'Oil at last.', 'My lamp thanks you.'],
  2: ['Mmm, dumplings!', 'Still warm!', 'One more…', 'Dumplings!'],
  3: ['Such silk!', 'Beautiful…', 'For the wedding.'],
  4: ['A lucky charm!', 'For luck.', 'Ooh, pretty.'],
}
const REFUSE_LINES = ['Too dear!', 'That much?!', 'Not at that price.', 'Hmph.']
const MISS_LINES = { 0: 'No tea anywhere…', 1: 'No oil tonight?', 2: 'Sold out of dumplings?', 3: 'Where is the silk?', 4: 'Nobody has charms…' }

export function bubbleText(kind, good, rand = Math.random) {
  const pick = (xs) => xs[Math.floor(rand() * xs.length)]
  if (kind === 'buy') return pick(BUY_LINES[good] ?? ['Thanks!'])
  if (kind === 'refuse') return pick(REFUSE_LINES)
  return MISS_LINES[good] ?? 'Nothing for me…'
}

// ---- the night summary --------------------------------------------------------------------------

/**
 * Explains one night for one stall. `before` is the stall view as it was before the night (may be
 * null), `stall` the view afterwards, `log` the NightLog, `world` the world after the night.
 * Returns {sold, revenue, lines: [{icon, text}], mood: 'good'|'flat'|'bad', headline}.
 */
export function summariseNight({ log, stall, before, world, cfg, villagers, nights = 1 }) {
  const id = stall.id
  const vname = (v) => villagers?.[v]?.name ?? `villager ${v}`
  const gname = (g) => cfg?.goods?.[g]?.name ?? GOODS[g]
  const mine = (log.sales ?? []).filter((s) => s[1] === id)
  const refusals = (log.refusals ?? []).filter((r) => r[1] === id)
  const spoiled = (log.spoiled ?? []).filter((s) => s[0] === id)
  const perGood = new Map()
  for (const [, , g, p] of mine) {
    const e = perGood.get(g) ?? { n: 0, coin: 0 }
    e.n++
    e.coin += p
    perGood.set(g, e)
  }
  const revenue = mine.reduce((a, s) => a + s[3], 0)
  const tax = Math.ceil((revenue * (cfg?.sales_tax_pct ?? 5)) / 100)
  const lines = []
  const soldParts = [...perGood].map(([g, e]) => `${e.n} ${gname(g)} for ${fmt(e.coin)}`)
  if (mine.length) lines.push({ icon: 'coin', text: `Sold ${listWords(soldParts)}. The town took ${fmt(tax)} in tax.` })

  // Sold out: money left on the table, counted from what the others bought and what nobody found.
  const soldOut = (cfg?.goods ?? GOODS).map((_, g) => g).filter((g) => before && before.stock[g] > 0 && stall.stock[g] === 0 && (perGood.get(g)?.n ?? 0) > 0)
  for (const g of soldOut) {
    const elsewhere = (log.sales ?? []).filter((s) => s[1] !== id && s[2] === g).length
    const nobody = (log.missed ?? []).filter((m) => m[1] === g).length
    const more = elsewhere + nobody
    const tail = more ? ` ${more} more bought ${elsewhere && nobody ? 'it elsewhere or found none' : elsewhere ? 'it elsewhere' : 'nothing: nobody had any'}. Stock more, or charge more.` : ' Stock more next time.'
    lines.push({ icon: 'star', text: `Sold out of ${gname(g)} after ${perGood.get(g).n}.${tail}` })
  }

  if (refusals.length) {
    const byGood = new Map()
    for (const [v, , g] of refusals) byGood.set(g, [...(byGood.get(g) ?? []), vname(v)])
    if (byGood.size > 2) {
      const names = refusals.map(([v]) => vname(v))
      lines.push({ icon: 'frown', text: `${listNames(names)} found your ${listWords([...byGood.keys()].map(gname))} too dear. Nobody on the row was cheap enough for them.` })
      byGood.clear()
    }
    for (const [g, names] of byGood) {
      const price = stall.price[g] || before?.price?.[g] || 0
      const rival = cheapestRival(world, id, g)
      const tail = rival && rival.price[g] < price ? ` ${rival.name} asks ${fmt(rival.price[g])}.` : names.length > 1 ? ' Nobody on the row was cheap enough for them.' : ` Nobody on the row was cheap enough for ${names[0]}.`
      lines.push({ icon: 'frown', text: `${listNames(names)} found your ${gname(g)} too dear at ${fmt(price)}.${tail}` })
    }
  }

  if (spoiled.length) lines.push({ icon: 'leaf', text: `Spoiled: ${listWords(spoiled.map(([, g, n]) => `${n} ${gname(g)}`))}.` })
  if (before && stall.rent_paid > before.rent_paid) {
    const rent = fmt(stall.rent_paid - before.rent_paid)
    lines.push({ icon: 'house', text: nights > 1 ? `Rent ${rent} for ${spotLabel(stall.spot)}, over the ${nights} nights the town traded while nobody watched.` : `Rent ${rent} for ${spotLabel(stall.spot)}.` })
  }

  let mood = mine.length ? 'good' : 'flat'
  if (!mine.length) {
    const why = explainNoSales({ stall, before, world, cfg, log })
    if (why) lines.unshift({ icon: 'moon', text: why })
    if (stall.spot == null) mood = 'bad'
  }

  const headline = mine.length
    ? `${mine.length} sale${mine.length === 1 ? '' : 's'}, +${fmt(revenue - tax)} coin`
    : stall.spot == null
      ? 'Off the row: no customers'
      : 'No sales tonight'
  return { sold: mine.length, revenue, tax, lines, mood, headline, perGood }
}

function listNames(names) {
  const u = [...new Set(names)]
  if (u.length <= 2) return u.join(' and ')
  return `${u.slice(0, 2).join(', ')} and ${u.length - 2} more`
}

export function cheapestRival(world, id, g) {
  let best = null
  for (const x of world?.row ?? []) {
    if (x.id === id || x.spot == null || !(x.price[g] > 0) || !(x.stock[g] > 0)) continue
    if (!best || x.price[g] < best.price[g]) best = x
  }
  return best
}

/** Why a stall sold nothing, in one friendly sentence, or null if there is no clear reason. */
export function explainNoSales({ stall, before, world, cfg, log }) {
  const s = before ?? stall
  if (stall.spot == null) return 'Your stall is off the row, so nobody walks past it. Move onto a free spot.'
  const stocked = s.stock.map((n, g) => (n > 0 ? g : -1)).filter((g) => g >= 0)
  if (!stocked.length) return 'Your counter was empty. Restock, and the villagers will stop.'
  const priced = stocked.filter((g) => s.price[g] > 0)
  if (!priced.length) return 'You had goods but no prices. A price of 0 means not for sale.'
  const gname = (g) => cfg?.goods?.[g]?.name ?? GOODS[g]
  const dearer = priced.filter((g) => {
    const r = cheapestRival(world, stall.id, g)
    return r && s.price[g] > r.price[g]
  })
  if (dearer.length === priced.length) {
    const g = dearer[0]
    const r = cheapestRival(world, stall.id, g)
    return `Your prices were above the merchants'. ${r.name} sells ${gname(g)} at ${fmt(r.price[g])}; you asked ${fmt(s.price[g])}.`
  }
  const wanted = (log?.sales ?? []).some(([, , g]) => priced.includes(g))
  if (!wanted) return `Nobody wanted ${listWords(priced.map(gname)).replace(' and ', ' or ')} tonight. Needs come round every few nights; they will be back.`
  if (stall.spot >= 14) return `Only ${stall.footfall}% of villagers walk as far as ${spotLabel(stall.spot)}. Earn, then move up the row.`
  return `Villagers who passed found what they needed at a stall they remembered. Lower prices a little, and they will remember yours.`
}

/** What to tell the player when the town caught up on several nights at once. */
export function catchUpText(advanced, slept) {
  if (advanced <= 1 && !slept) return null
  const parts = []
  if (advanced > 1) parts.push(`The town traded ${advanced} nights while nobody was watching: rent was paid and some goods spoiled.`)
  if (slept) parts.push(`It slept through ${slept} more.`)
  return parts.join(' ')
}

// ---- tonight's call: one decision a night ----------------------------------------------------------

function buyPlan(world, cfg, stall, g, qty, { reserve = Math.max(120, Math.floor(stall.money * 0.15)) } = {}) {
  const room = stall.capacity - stall.stock.reduce((a, b) => a + b, 0)
  const cap = Math.max(0, Math.min(qty, room, world.dock[g].left))
  const q = affordable(cfg.goods[g], world.dock[g], Math.max(0, stall.money - reserve), cap)
  return { qty: q, cost: dockCost(cfg.goods[g], world.dock[g], q) }
}

/**
 * One readable decision for tonight, drawn from the rules: the event that starts next night, the
 * festival or payday in force, what sold out or was refused last night, and the gap between what
 * villagers want tonight and what the merchants hold. Returns null when there is nothing worth asking.
 * {kind, good, title, text, accept: {label, actions, cost}, decline, expect} or null.
 */
export function nightlyCall({ world, cfg, stall, log, fc = forecast(world, cfg, stall), avoid = null }) {
  if (!world || !stall || stall.spot == null || stall.listed != null) return null
  const avoided = (kind, g) => !!avoid && avoid.kind === kind && avoid.good === g
  const gname = (g) => cfg.goods[g].name
  const id = stall.id
  const prices = suggestPrices(world, cfg, stall, fc)
  const buy = (g, qty, max_cost) => ({ buy: { stall: id, good: g, qty, max_cost: Math.ceil(max_cost * 1.3) + 2 } })
  const setPrice = (g, price) => ({ price: { stall: id, good: g, price } })
  const soon = world.event_left === 1
  const unit = (g) => world.dock[g].price

  // 1. Something starts next night: stock before it does, or wait for the Dock to get cheap.
  if (soon) {
    const fg = eventGood(world.event_next, 'festival')
    if (fg != null) {
      const target = Math.max(Math.floor(MIX[fg] * (1 + stall.tier / 2) * 2), Math.min(stall.service ?? 10, fc[fg].wanted * 2))
      const plan = buyPlan(world, cfg, stall, fg, target - stall.stock[fg])
      if (plan.qty > 0) {
        const festPrice = Math.floor((cfg.goods[fg].fair * 150) / 100)
        return {
          kind: 'festival-stock', good: fg, night: world.night,
          title: `Festival of ${gname(fg)} starts next night`,
          text: `Everyone will want ${gname(fg)} and buy two each, paying up to 30% more. The Dock sells it at ${fmt(unit(fg))} now.`,
          accept: { label: `Stock ${plan.qty} ${gname(fg)}`, cost: plan.cost, actions: [buy(fg, plan.qty, plan.cost), ...(stall.price[fg] === 0 ? [setPrice(fg, prices[fg].price)] : [])] },
          decline: { label: 'Skip' },
          expect: `Could sell for about ${fmt(festPrice)} each: ${fmt(plan.qty * festPrice)} for ${fmt(plan.cost)}.`,
        }
      }
    }
    const sg = eventGood(world.event_next, 'storm')
    if (sg != null) {
      // two nights' worth, within what villagers actually want: a storm raises the Dock's price, not demand
      const target = Math.min(Math.floor(MIX[sg] * (1 + stall.tier / 2) * 1.5), Math.max(MIX[sg], fc[sg].wanted))
      const plan = buyPlan(world, cfg, stall, sg, target - stall.stock[sg])
      if (plan.qty > 0) {
        const stormUnit = Math.ceil(unit(sg) * 1.5)
        return {
          kind: 'storm-stock', good: sg, night: world.night, priceThen: unit(sg),
          title: `Storm on ${gname(sg)} from next night`,
          text: `For three nights the Dock lands a quarter of its ${gname(sg)} at half again the price: about ${fmt(stormUnit)} a unit instead of ${fmt(unit(sg))}. Buy tonight's and tomorrow's now.`,
          accept: { label: `Stock ${plan.qty} ${gname(sg)}`, cost: plan.cost, actions: [buy(sg, plan.qty, plan.cost), ...(stall.price[sg] === 0 ? [setPrice(sg, prices[sg].price)] : [])] },
          decline: { label: 'Skip' },
          expect: `Saves about ${fmt(plan.qty * (stormUnit - unit(sg)))} coin against buying in the storm.`,
        }
      }
    }
    const bg = eventGood(world.event_next, 'bumper')
    if (bg != null && stall.stock[bg] < MIX[bg] && fc[bg].rivalStock > 0) {
      return {
        kind: 'bumper-wait', good: bg, night: world.night, priceThen: unit(bg),
        title: `Bumper ${gname(bg)} next night`,
        text: `The Dock will have twice the ${gname(bg)} at 30% off from next night. Yours sits at ${fmt(unit(bg))} a unit now.`,
        accept: { label: `Wait for cheap ${gname(bg)}`, cost: 0, actions: [], skip: bg },
        decline: { label: 'Buy now anyway' },
        expect: `About ${fmt(Math.floor(unit(bg) * 0.7))} a unit tomorrow instead of ${fmt(unit(bg))}.`,
      }
    }
  }

  // 2. A festival in force: price for it, and keep the counter full of it.
  const fg = eventGood(world.event, 'festival')
  if (fg != null) {
    const want = Math.min(stall.service ?? 10, fc[fg].wanted * 2)
    const plan = buyPlan(world, cfg, stall, fg, want - stall.stock[fg])
    const price = prices[fg].price
    const actions = []
    if (plan.qty > 0) actions.push(buy(fg, plan.qty, plan.cost))
    if (price > stall.price[fg]) actions.push(setPrice(fg, price))
    if (actions.length) {
      const label = plan.qty > 0 && price > stall.price[fg] ? `Stock ${plan.qty} and price at ${fmt(price)}` : plan.qty > 0 ? `Stock ${plan.qty} ${gname(fg)}` : `Raise ${gname(fg)} to ${fmt(price)}`
      return {
        kind: 'festival-price', good: fg, night: world.night,
        title: `Festival of ${gname(fg)} tonight`,
        text: `${fc[fg].wanted} villagers want ${gname(fg)}, two each, and pay up to 30% more. ${prices[fg].reason[0].toUpperCase()}${prices[fg].reason.slice(1)}.`,
        accept: { label, cost: plan.qty > 0 ? plan.cost : 0, actions },
        decline: { label: 'Keep as is' },
        expect: `About ${Math.round(expectSales(fc, fg, price, { stock: stall.stock[fg] + plan.qty }))} sales at ${fmt(price)}.`,
      }
    }
  }

  // 3. Payday: everyone pays a tenth more.
  if (world.event === 'payday') {
    const actions = []
    cfg.goods.forEach((good, g) => {
      if (stall.stock[g] > 0 && stall.price[g] > 0) {
        const p = Math.min(good.max_price, Math.floor((stall.price[g] * 108) / 100))
        if (p > stall.price[g]) actions.push(setPrice(g, p))
      }
    })
    if (actions.length) {
      return {
        kind: 'payday-price', good: null, night: world.night,
        title: 'Payday tonight',
        text: 'Wages are up by half and villagers pay about a tenth more than usual. Prices can go up with them.',
        accept: { label: 'Raise prices 8%', cost: 0, actions },
        decline: { label: 'Keep prices' },
        expect: 'More coin per sale; a few more may balk.',
      }
    }
  }

  // 4. Last night: sold out with buyers left over, or refused while a rival was cheaper.
  if (log && log.night === world.night - 1) {
    const soldOut = cfg.goods.map((_, g) => g).filter((g) => stall.stock[g] === 0 && (stall.sold_last?.[g] ?? 0) > 0 && fc[g].wanted > 0)
    const scored = soldOut.map((g) => ({ g, more: (log.sales ?? []).filter((s) => s[1] !== id && s[2] === g).length + (log.missed ?? []).filter((m) => m[1] === g).length })).sort((a, b) => b.more - a.more)
    if (scored.length && scored[0].more > 0) {
      const { g, more } = scored[0]
      const plan = buyPlan(world, cfg, stall, g, Math.min(stall.service ?? 10, stall.sold_last[g] + more))
      if (plan.qty > 0) {
        const price = stall.price[g] || prices[g].price
        return {
          kind: 'sold-out', good: g, night: world.night,
          title: `You sold out of ${gname(g)}`,
          text: `${stall.sold_last[g]} sold last night and ${more} more bought it elsewhere or found none. Tonight ${fc[g].wanted} want it again.`,
          accept: { label: `Stock ${plan.qty} ${gname(g)}`, cost: plan.cost, actions: [buy(g, plan.qty, plan.cost), ...(stall.price[g] === 0 ? [setPrice(g, price)] : [])] },
          decline: { label: 'Skip' },
          expect: `About ${Math.round(expectSales(fc, g, price, { stock: plan.qty }))} sales at ${fmt(price)}.`,
        }
      }
    }
    const refused = new Map()
    for (const [, s, g] of log.refusals ?? []) if (s === id) refused.set(g, (refused.get(g) ?? 0) + 1)
    const worst = [...refused].filter(([g]) => stall.stock[g] > 0 && stall.price[g] > 0 && prices[g].price < stall.price[g]).sort((a, b) => b[1] - a[1])[0]
    if (worst && worst[1] >= 2) {
      const [g, n] = worst
      const price = prices[g].price
      return {
        kind: 'price-cut', good: g, night: world.night,
        title: `${n} walked away from your ${gname(g)}`,
        text: `They found ${fmt(stall.price[g])} too dear${fc[g].rivalMin ? ` and the merchants ask ${fmt(fc[g].rivalMin)}` : ''}. ${fc[g].wanted} want ${gname(g)} tonight.`,
        accept: { label: `Drop to ${fmt(price)}`, cost: 0, actions: [setPrice(g, price)] },
        decline: { label: `Hold at ${fmt(stall.price[g])}` },
        expect: `About ${Math.round(expectSales(fc, g, price, { stock: stall.stock[g] }))} sales at ${fmt(price)} instead of ${Math.round(expectSales(fc, g, stall.price[g], { stock: stall.stock[g] }))}.`,
      }
    }
  }

  // 5. The gap: villagers want more than the merchants hold.
  const gaps = cfg.goods.map((_, g) => ({ g, gap: fc[g].wanted - fc[g].rivalStock - stall.stock[g], wanted: fc[g].wanted })).filter((x) => x.wanted >= 2 && x.gap > 0 && !avoided('gap', x.g)).sort((a, b) => b.gap - a.gap)
  for (const { g, gap } of gaps) {
    const plan = buyPlan(world, cfg, stall, g, Math.min(stall.service ?? 10, gap + Math.ceil(fc[g].rivalStock / 2)))
    if (plan.qty <= 0) continue
    const price = stall.price[g] || prices[g].price
    return {
      kind: 'gap', good: g, night: world.night,
      title: `${gname(g)[0].toUpperCase()}${gname(g).slice(1)} is short tonight`,
      text: `${fc[g].wanted} villagers want ${gname(g)}; the merchants hold ${fc[g].rivalStock}${stall.stock[g] ? ` and you ${stall.stock[g]}` : ''}. The Dock sells it at ${fmt(unit(g))}.`,
      accept: { label: `Stock ${plan.qty} ${gname(g)}`, cost: plan.cost, actions: [buy(g, plan.qty, plan.cost), ...(stall.price[g] === 0 ? [setPrice(g, price)] : [])] },
      decline: { label: 'Skip' },
      expect: `About ${Math.round(expectSales(fc, g, price, { stock: stall.stock[g] + plan.qty }))} sales at ${fmt(price)}.`,
    }
  }

  // 6. Nothing is short: undercut the merchants on the most-wanted good you can carry.
  const popular = cfg.goods.map((_, g) => g).filter((g) => fc[g].wanted >= 2 && fc[g].rivalMin && !avoided('undercut', g)).sort((a, b) => fc[b].wanted - fc[a].wanted)[0]
  if (popular != null) {
    const g = popular
    const price = prices[g].price
    const plan = stall.stock[g] < Math.ceil(fc[g].wanted / 2) ? buyPlan(world, cfg, stall, g, Math.ceil(fc[g].wanted / 2) - stall.stock[g]) : { qty: 0, cost: 0 }
    const actions = []
    if (plan.qty > 0) actions.push(buy(g, plan.qty, plan.cost))
    if (price !== stall.price[g]) actions.push(setPrice(g, price))
    if (actions.length) {
      return {
        kind: 'undercut', good: g, night: world.night,
        title: `${fc[g].wanted} want ${gname(g)} tonight`,
        text: `The merchants hold ${fc[g].rivalStock} and ask ${fmt(fc[g].rivalMin)}. ${prices[g].reason[0].toUpperCase()}${prices[g].reason.slice(1)}.`,
        accept: { label: plan.qty > 0 ? `Stock ${plan.qty} at ${fmt(price)}` : `Price at ${fmt(price)}`, cost: plan.cost, actions },
        decline: { label: 'Skip' },
        expect: `About ${Math.round(expectSales(fc, g, price, { stock: stall.stock[g] + plan.qty }))} sales at ${fmt(price)}.`,
      }
    }
  }
  return null
}

/** How the call turned out, once the night has been played. {met, text} */
export function judgeCall(call, { log, stall, before, world, cfg, accepted }) {
  if (!call || !log) return null
  const gname = (g) => cfg.goods[g].name
  const g = call.good
  const sold = g == null ? (log.sales ?? []).filter((s) => s[1] === stall.id).length : (log.sales ?? []).filter((s) => s[1] === stall.id && s[2] === g).length
  const coin = (log.sales ?? []).filter((s) => s[1] === stall.id && (g == null || s[2] === g)).reduce((a, s) => a + s[3], 0)
  const refused = g == null ? 0 : (log.refusals ?? []).filter((r) => r[1] === stall.id && r[2] === g).length
  const elsewhere = g == null ? 0 : (log.sales ?? []).filter((s) => s[1] !== stall.id && s[2] === g).length
  if (!accepted) {
    if (call.kind === 'bumper-wait') return { met: null, text: `You bought ${gname(g)} before the bumper night.` }
    if (g == null) return { met: null, text: 'You kept your prices on payday.' }
    return { met: null, text: `You skipped ${gname(g)}: ${elsewhere ? `${elsewhere} bought it from the merchants tonight` : 'nobody bought it on the row tonight'}.` }
  }
  switch (call.kind) {
    case 'bumper-wait': {
      const now = world?.dock?.[g]?.price
      const was = call.priceThen
      const met = now != null && was != null ? now < was : null
      return { met, text: met ? `Your call: ${gname(g)} at the Dock fell from ${fmt(was)} to ${fmt(now)}. Restock now.` : `Your call: the Dock's ${gname(g)} is at ${fmt(now)}.` }
    }
    case 'storm-stock': {
      const now = world?.dock?.[g]?.price
      const was = call.priceThen
      const qty = call.accept?.actions?.find((a) => a.buy)?.buy?.qty ?? 0
      const met = now != null && was != null ? now > was : null
      const soldPart = sold ? ` ${sold} sold tonight for ${fmt(coin)}.` : ''
      return { met, text: met ? `Your call paid off: the Dock's ${gname(g)} is up from ${fmt(was)} to ${fmt(now)}; you bought ${qty} before, saving about ${fmt(qty * (now - was))}.${soldPart}` : `Your call: the Dock's ${gname(g)} is at ${fmt(now)}.${soldPart}` }
    }
    case 'payday-price': {
      const met = sold >= 3 && refused <= sold
      return { met, text: met ? `Your call paid off: ${sold} sales at payday prices, ${fmt(coin)} coin.` : `Your call: ${sold} sales at payday prices${refused ? `, ${refused} balked` : ''}.` }
    }
    case 'price-cut': {
      const met = sold >= 1
      return { met, text: met ? `Your call paid off: ${gname(g)} at the lower price sold ${sold} for ${fmt(coin)}.` : `Your call: nobody bought ${gname(g)} even at the lower price${elsewhere ? `; ${elsewhere} bought it elsewhere` : ''}.` }
    }
    default: {
      const bought = call.accept?.qty ?? call.accept?.actions?.find((a) => a.buy)?.buy?.qty ?? 0
      const met = sold >= Math.max(1, Math.ceil(bought / 2))
      if (met) return { met, text: `Your call paid off: ${sold} ${gname(g)} sold for ${fmt(coin)}${call.accept?.cost ? ` (stock cost ${fmt(call.accept.cost)})` : ''}.` }
      const lasting = call.kind === 'festival-stock' ? ' The festival lasts two nights.' : call.kind === 'storm-stock' ? ' The storm lasts three nights; the merchants run dry first.' : ''
      return { met, text: `Your call: ${sold ? `only ${sold}` : 'none'} of the ${gname(g)} sold tonight${refused ? `, ${refused} found it too dear` : ''}.${lasting}` }
    }
  }
}

// ---- tutorial -----------------------------------------------------------------------------------

export const TUTORIAL = [
  { id: 'restock', text: 'This is your stall. Tap Restock to fill the counter at tonight’s Dock prices.', done: (s) => s.restocked },
  { id: 'price', text: 'Now set prices. Tap Smart prices, or nudge each one with − and +.', done: (s) => s.priced },
  { id: 'wait', text: 'When the clock runs out, villagers walk the row and buy. Each card says how many want the good tonight.', done: (s) => s.walked },
  { id: 'first', text: (s) => (s.firstSale ? `You sold your first ${s.firstSale}! Coins stay in your stall. Every night brings one call to make.` : 'Nobody bought this time. The summary says why. Price just under the merchants.'), done: (s) => s.walked >= 2 },
  { id: 'rival', text: (s) => `Beat ${s.rivalName ?? 'The Quiet Kettle'}: it sits near the gate, where everyone passes. Earn, then move up the row.`, done: (s) => s.walked >= 4 },
  { id: 'deed', text: 'Your stall is a deed you own. Open it from the top bar to grow, move or sell it.', done: (s) => s.openedDeed },
]

export function tutorialStep(progress) {
  for (const step of TUTORIAL) if (!step.done(progress)) return step
  return null
}

/** The leaderboard rank of a stall, or null. */
export function rankOf(board, id) {
  return board.find((r) => r.id === id)?.rank ?? null
}

/** The ranks worth showing: stalls on the row, plus the player's own wherever it is, renumbered. */
export function visibleBoard(board, myId) {
  return board.filter((r) => r.spot != null || r.id === myId).map((r, i) => ({ ...r, rank: i + 1 }))
}

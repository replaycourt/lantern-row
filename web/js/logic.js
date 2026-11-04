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

// ---- advice -------------------------------------------------------------------------------------

/**
 * A price per good that tends to sell: just under the cheapest rival with stock, never below 125% of
 * the Dock or 95% of fair, never above 140% of fair, plus a premium while a festival or storm
 * concerns the good. Returns [{price, reason}].
 */
export function suggestPrices(world, cfg, stall) {
  return cfg.goods.map((good, g) => {
    const unit = world.dock[g].price
    const rivals = world.row.filter((x) => x.id !== stall.id && x.stock[g] > 0 && x.price[g] > 0).map((x) => x.price[g])
    const floor = Math.max(Math.floor((unit * 125) / 100), Math.floor((good.fair * 95) / 100))
    const ceiling = Math.max(floor, Math.floor((good.fair * 140) / 100))
    let price, reason
    if (rivals.length) {
      const cheapest = Math.min(...rivals)
      price = Math.floor((cheapest * 97) / 100)
      reason = `just under the cheapest rival (${cheapest})`
    } else {
      price = ceiling
      reason = 'nobody else sells it tonight'
    }
    if (price < floor) {
      price = floor
      reason = 'as low as still pays'
    }
    if (price > ceiling) {
      price = ceiling
      reason = 'a fair price'
    }
    if (world.event?.festival?.good === g) {
      price = Math.floor((price * 125) / 100)
      reason = 'festival: everyone wants it'
    } else if (world.event?.storm?.good === g) {
      price = Math.floor((price * 130) / 100)
      reason = 'storm: scarce at the Dock'
    }
    return { price: Math.min(price, good.max_price), reason }
  })
}

/**
 * What to buy to fill the stall towards a sensible mix, within money, capacity and tonight's Dock
 * supply. Buys more of a good the night before a festival or storm for it. Returns
 * {items: [{good, qty, cost}], total}.
 */
export function suggestRestock(world, cfg, stall, { reserve = 150 } = {}) {
  let room = stall.capacity - stall.stock.reduce((a, b) => a + b, 0)
  let money = Math.max(0, stall.money - reserve)
  const soon = world.event_left === 1
  const items = []
  // Dumplings spoil fast, so they come last; silk and charms are dear, so they come after the staples.
  const order = [0, 1, 4, 3, 2]
  for (const g of order) {
    const good = cfg.goods[g]
    const fest = (soon && world.event_next?.festival?.good === g) || world.event?.festival?.good === g
    const storm = soon && world.event_next?.storm?.good === g
    const target = Math.floor(MIX[g] * (1 + stall.tier / 2) * (fest ? 2 : storm ? 1.5 : 1))
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
  return out.slice(0, max)
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
  if (!event || event === 'quiet') return { kind: 'quiet', title: 'A quiet night', line: 'Nothing special. Trade as usual.', good: null }
  if (event === 'payday') return { kind: 'payday', title: 'Payday', line: 'Wages are up by half. Villagers spend more freely.', good: null }
  const [kind, body] = Object.entries(event)[0]
  const g = body?.good
  const name = cfg?.goods?.[g]?.name ?? GOODS[g]
  if (kind === 'festival') return { kind, title: `Festival of ${name}`, line: `Everyone wants ${name} tonight and buys two. They pay up to 30% more.`, good: g }
  if (kind === 'storm') return { kind, title: `Storm at the Dock`, line: `Little ${name} comes in, and the Dock charges half again. Stock up before it hits.`, good: g }
  if (kind === 'bumper') return { kind, title: `Bumper ${name}`, line: `The Dock is flooded with ${name}: twice the supply at 30% off.`, good: g }
  return { kind, title: kind, line: '', good: g ?? null }
}

/** One-line announcement of what comes next, for the banner. */
export function forecastLine(world, cfg) {
  const next = eventInfo(world.event_next, cfg)
  const when = world.event_left === 1 ? 'next night' : `in ${world.event_left} nights`
  if (next.kind === 'quiet') return `Quiet nights ahead (${when}).`
  return `${next.title} ${when}.`
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
 * null), `after` the view afterwards, `log` the NightLog, `world` the world after the night.
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
  if (mine.length) lines.push({ icon: 'coin', text: `Sold ${soldParts.join(', ')}. The town took ${fmt(tax)} in tax.` })

  const soldOut = (cfg?.goods ?? GOODS).map((_, g) => g).filter((g) => before && before.stock[g] > 0 && stall.stock[g] === 0 && (perGood.get(g)?.n ?? 0) > 0)
  if (soldOut.length) lines.push({ icon: 'star', text: `Sold out of ${soldOut.map(gname).join(' and ')}. Villagers would have bought more.` })

  if (refusals.length) {
    const byGood = new Map()
    for (const [v, , g] of refusals) byGood.set(g, [...(byGood.get(g) ?? []), vname(v)])
    for (const [g, names] of byGood) {
      const rival = cheapestRival(world, id, g)
      const tail = rival ? ` ${rival.name} asks ${fmt(rival.price[g])}.` : ''
      lines.push({ icon: 'frown', text: `${listNames(names)} found your ${gname(g)} too dear at ${fmt(stall.price[g] || before?.price?.[g] || 0)}.${tail}` })
    }
  }

  if (spoiled.length) lines.push({ icon: 'leaf', text: `Spoiled: ${spoiled.map(([, g, n]) => `${n} ${gname(g)}`).join(', ')}.` })
  if (before && stall.rent_paid > before.rent_paid) {
    const rent = fmt(stall.rent_paid - before.rent_paid)
    lines.push({ icon: 'house', text: nights > 1 ? `Rent ${rent} for spot ${stall.spot + 1}, over the ${nights} nights the town traded while nobody watched.` : `Rent ${rent} for spot ${stall.spot + 1}.` })
  }

  let mood = mine.length ? 'good' : 'flat'
  if (!mine.length) {
    const why = explainNoSales({ stall, before, world, cfg, log })
    if (why) lines.unshift({ icon: 'moon', text: why })
    if (stall.spot == null) mood = 'bad'
  }

  const wantsMine = (world?.villagers ?? []).filter((v) => v.wants?.some((g) => stall.stock[g] > 0 && stall.price[g] > 0)).length
  if (wantsMine && stall.spot != null) lines.push({ icon: 'eye', text: `${wantsMine} villagers want something you stock tonight.` })

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
    if (x.id === id || !(x.price[g] > 0) || !(x.stock[g] > 0)) continue
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
  if (!wanted) return `Nobody wanted ${priced.map(gname).join(' or ')} tonight. Needs come round every few nights; they will be back.`
  if (stall.spot >= 14) return `Only ${stall.footfall}% of villagers walk as far as spot ${stall.spot + 1}. Earn, then move up the row.`
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

// ---- tutorial -----------------------------------------------------------------------------------

export const TUTORIAL = [
  { id: 'restock', text: 'This is your stall. Tap Restock to fill the counter.', done: (s) => s.restocked },
  { id: 'price', text: 'Now set prices. Tap Smart prices, or nudge each one with − and +.', done: (s) => s.priced },
  { id: 'wait', text: 'When the clock runs out, villagers walk the row and buy.', done: (s) => s.walked },
  { id: 'first', text: (s) => (s.firstSale ? `You sold your first ${s.firstSale}! Coins stay in your stall.` : 'Nobody bought this time. The summary says why. Price just under the merchants.'), done: (s) => s.walked >= 2 },
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

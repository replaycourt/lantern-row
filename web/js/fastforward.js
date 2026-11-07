// Fast-forward: 300 nights of the economy in a minute, played from a recording of the contract's own
// code in the test VM (contract/tests/economy_sim.rs, record_fast_forward), not from the live town.
// The data module is loaded only when the sheet opens. Everything here is drawn as SVG and DOM
// nodes; names go in as text, never as HTML.
import { fmt } from './logic.js'

const NS = 'http://www.w3.org/2000/svg'
const NIGHTS_PER_SECOND = 5
const COLORS = ['#e8a33d', '#7aa2e3', '#d9775b', '#b98be0', '#6fbf9a'] // tea, lamp oil, dumplings, silk, charms

const SVG_TAGS = new Set(['svg', 'line', 'polyline', 'text'])

/** A DOM or SVG node. `css` goes through the CSSOM, which the page's CSP allows (style attributes it blocks). */
function el(tag, attrs = {}, parent = null, text = null) {
  const e = SVG_TAGS.has(tag) ? document.createElementNS(NS, tag) : document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'css') Object.assign(e.style, v)
    else e.setAttribute(k, v)
  }
  if (text != null) e.textContent = text
  if (parent) parent.appendChild(e)
  return e
}

/**
 * What the villagers paid for each good, averaged over the last `window` nights with a sale and
 * given as an index (100 = that average on the first night it can be taken), night by night.
 * Pure, for the chart and the tests.
 */
export function priceIndex(nights, goods, window = 9) {
  return goods.map((_, g) => {
    const recent = []
    const avg = nights.map((n) => {
      if (n.paid[g] > 0) recent.push(n.paid[g])
      if (recent.length > window) recent.shift()
      return recent.length === window ? recent.reduce((a, b) => a + b, 0) / window : null
    })
    const base = avg.find((v) => v != null)
    return avg.map((v) => (v != null && base ? (v * 100) / base : null))
  })
}

/** The stalls by worth on night index i, richest first: [{id, name, npc, worth}]. */
export function worthBoard(data, i) {
  const names = new Map(data.stalls.map((s) => [s.id, s]))
  return data.nights[i].worth
    .map(([id, worth]) => ({ id, worth, name: names.get(id)?.name ?? `Stall ${id}`, npc: names.get(id)?.npc ?? false }))
    .sort((a, b) => b.worth - a.worth || a.id - b.id)
}

/** Builds the view inside `host` and plays it; returns a stop function. */
export async function playFastForward(host, { reduced = false } = {}) {
  const data = (await import('./fast-forward-data.js')).default
  host.replaceChildren()
  el('p', { class: 'ff-note' }, host, 'A simulation, not the live town: the contract’s own code in a test VM, 300 nights (about 100 minutes of the real street) in a minute. Four player bots trade; from night ' + fmt(data.floodFrom) + ' a fifth floods the row with tea.')
  const head = el('div', { class: 'ff-head' }, host)
  const nightEl = el('b', {}, head)
  const eventEl = el('span', {}, head)

  // the merchants' prices, as an index
  const W = 420
  const H = 170
  const pad = { l: 34, r: 8, t: 10, b: 18 }
  const idx = priceIndex(data.nights, data.goods)
  const all = idx.flat().filter((v) => v != null)
  const lo = Math.min(60, ...all)
  const hi = Math.max(140, ...all)
  const N = data.nights.length
  const x = (i) => pad.l + (i / (N - 1)) * (W - pad.l - pad.r)
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b)
  el('p', { class: 'ff-label' }, host, 'What the villagers paid, by good (100 = the first nine nights)')
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ff-chart', role: 'img', 'aria-label': 'What the villagers paid for each good over 300 nights' }, host)
  for (const v of [lo, 100, hi].map((v) => Math.round(v))) {
    el('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: v === 100 ? 'ff-base' : 'ff-grid' }, svg)
    el('text', { x: pad.l - 4, y: y(v) + 3, class: 'ff-axis', 'text-anchor': 'end' }, svg, String(v))
  }
  const floodI = data.nights.findIndex((n) => n.n >= data.floodFrom)
  if (floodI > 0) {
    el('line', { x1: x(floodI), x2: x(floodI), y1: pad.t, y2: H - pad.b, class: 'ff-flood' }, svg)
    el('text', { x: x(floodI) + 4, y: pad.t + 9, class: 'ff-axis' }, svg, 'tea flood starts')
  }
  const lines = idx.map((_, g) => el('polyline', { points: '', class: `ff-line${g === 0 ? ' ff-tea' : ''}`, stroke: COLORS[g] }, svg))
  const legend = el('div', { class: 'ff-legend' }, host)
  data.goods.forEach((name, g) => {
    const item = el('span', {}, legend)
    el('i', { css: { background: COLORS[g] } }, item)
    item.append(name)
  })

  // the stalls by worth
  el('p', { class: 'ff-label' }, host, 'Stalls by worth (coin, goods, size and spot)')
  const board = el('ol', { class: 'ff-board' }, host)
  const stats = el('p', { class: 'ff-stats' }, host)
  const controls = el('div', { class: 'ff-controls' }, host)
  const pauseBtn = el('button', { type: 'button', class: 'small' }, controls, 'Pause')
  const againBtn = el('button', { type: 'button', class: 'small' }, controls, 'Play again')

  const draw = (i) => {
    const n = data.nights[i]
    nightEl.textContent = `Night ${fmt(n.n)}`
    eventEl.textContent = n.e === 'quiet' ? '' : ` · ${n.e}`
    idx.forEach((series, g) => {
      const pts = []
      for (let k = 0; k <= i; k++) if (series[k] != null) pts.push(`${x(k).toFixed(1)},${y(series[k]).toFixed(1)}`)
      lines[g].setAttribute('points', pts.join(' '))
    })
    const top = worthBoard(data, i).slice(0, 8)
    const max = Math.max(1, ...top.map((r) => r.worth))
    board.replaceChildren(
      ...top.map((r) => {
        const li = el('li', { class: r.npc ? 'npc' : 'bot' })
        el('span', { class: 'ff-name' }, li, r.npc ? r.name : `${r.name} (bot)`)
        const bar = el('span', { class: 'ff-bar' }, li)
        el('i', { css: { width: `${((r.worth / max) * 100).toFixed(1)}%` } }, bar)
        el('span', { class: 'ff-num' }, li, fmt(r.worth))
        return li
      }),
    )
    const sold = n.sold.reduce((a, b) => a + b, 0)
    stats.textContent = `This night: ${fmt(sold)} sales, ${fmt(n.refused)} times too dear, ${fmt(n.missed)} found nothing · Treasury ${fmt(n.treasury)}`
  }

  let i = reduced ? N - 1 : 0
  let paused = false
  let stopped = false
  let last = performance.now()
  let carry = 0
  draw(i)
  const frame = (now) => {
    if (stopped) return
    if (!host.isConnected || host.closest('.hidden')) return void (stopped = true)
    if (!paused && i < N - 1) {
      carry += ((now - last) / 1000) * NIGHTS_PER_SECOND
      const step = Math.floor(carry)
      if (step > 0) {
        carry -= step
        i = Math.min(N - 1, i + step)
        draw(i)
      }
    }
    last = now
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  pauseBtn.addEventListener('click', () => {
    paused = !paused
    pauseBtn.textContent = paused ? 'Play' : 'Pause'
  })
  againBtn.addEventListener('click', () => {
    i = 0
    carry = 0
    paused = false
    pauseBtn.textContent = 'Pause'
    draw(i)
  })
  return () => {
    stopped = true
  }
}

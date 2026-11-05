#!/usr/bin/env node
// Records a take for the demo video: plays Lantern Row through its own page in headless Chrome, on the
// real contract, and records the screen with the DevTools screencast. Nothing is mocked: every click
// is a real input event on the page, and every number on screen comes from NEAR testnet.
//
//   node demo/video/tools/capture.mjs --url http://127.0.0.1:8765/web/ --out <take dir>
//        [--name "Honey Lantern"] [--nights 10] [--max-minutes 18] [--profile <dir>] [--dry] [--skip-play [--restock]]
//
// Writes into <take dir>:
//   frames/f000001.jpg …   the screencast, 1280x720 JPEG (the compositor scales to 1920x1080)
//   frames.jsonl           one line per frame: {"i": n, "t": <seconds, wall clock>}
//   events.jsonl           what happened and when: clicks, cursor moves, nights, reports, calls, sheets
//   take.json              a summary: stall, nights seen, transactions, whether a call paid off
//
// A fresh --profile founds a new stall; the same profile again returns to it. The take ends after
// --nights nights once a call has paid off (the "CALLED IT" stamp), or after --max-minutes. With
// --skip-play it goes straight from the title to the deed, the listing, the ranks and the proof. The
// storyboard then cuts the film from the events, see demo/video/README.md. Needs Node 22+ and Chrome.
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChrome, Page, sleep } from '../../../scripts/cdp.mjs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : dflt
}
const flag = (name) => process.argv.includes(`--${name}`)
const URL_ = arg('url', 'http://127.0.0.1:8765/web/')
const OUT = resolve(arg('out', 'take'))
const PROFILE = resolve(arg('profile', join(OUT, 'profile')))
const NAME = arg('name', 'Honey Lantern')
const NIGHTS = Number(arg('nights', 10))
const MAX_MIN = Number(arg('max-minutes', 18))
const PORT = Number(arg('port', 9411))
const DRY = flag('dry')
const SKIP_PLAY = flag('skip-play') // return to the stall and record only the deed, ranks and proof
const RESTOCK = flag('restock') // with --skip-play: withdraw a listing and fill the counter first, so the deed has goods in it
const QUALITY = Number(arg('quality', 90))
const W = 1280
const H = 720
const SCALE = 1 // the page renders in software here; 1280x720 at 1x keeps the game at its real pace, the compositor upscales

mkdirSync(join(OUT, 'frames'), { recursive: true })
const eventsOut = createWriteStream(join(OUT, 'events.jsonl'))
const framesOut = createWriteStream(join(OUT, 'frames.jsonl'))
const now = () => Date.now() / 1000
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
function mark(ev, data = {}) {
  const e = { t: now(), ev, ...data }
  eventsOut.write(JSON.stringify(e) + '\n')
  if (ev !== 'cursor' && ev !== 'state') log(ev, JSON.stringify(data).slice(0, 140))
  return e
}

// ---- the page ---------------------------------------------------------------------------------

async function open(chrome, url) {
  const target = await (await fetch(`http://127.0.0.1:${chrome.port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  const page = new Page(ws, chrome)
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Network.enable')
  await page.send('Network.setCacheDisabled', { cacheDisabled: true })
  await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: SCALE, mobile: false })
  await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 15, g: 13, b: 43, a: 1 } })
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.send('Page.navigate', { url })
  await page.waitFor(() => document.readyState === 'complete', 15000)
  return page
}

let cursor = { x: W / 2, y: H / 2 }
async function moveTo(page, x, y, ms = 380) {
  const from = { ...cursor }
  const steps = Math.max(6, Math.round(ms / 25))
  for (let i = 1; i <= steps; i++) {
    const k = i / steps
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2 // ease in-out
    cursor = { x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e }
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cursor.x, y: cursor.y })
    mark('cursor', { x: Math.round(cursor.x), y: Math.round(cursor.y) })
    await sleep(ms / steps)
  }
}

async function click(page, selector, label = selector) {
  const box = await page.eval((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    el.scrollIntoView?.({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
  }, selector)
  if (!box || box.w === 0) throw new Error(`no visible element ${selector}`)
  await sleep(250) // a scrolled sheet settles before the hand arrives
  // not dead centre: a little off, like a hand
  const x = box.x + (Math.random() - 0.5) * Math.min(12, box.w / 4)
  const y = box.y + (Math.random() - 0.5) * Math.min(6, box.h / 4)
  await moveTo(page, x, y)
  await sleep(140)
  mark('click', { x: Math.round(x), y: Math.round(y), what: label })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await sleep(70)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(60)
}

async function typeInto(page, selector, text) {
  await click(page, selector, 'name field')
  await page.eval((sel) => {
    const el = document.querySelector(sel)
    el.value = ''
    el.focus()
  }, selector)
  mark('type', { what: selector, text })
  for (const ch of text) {
    await page.send('Input.dispatchKeyEvent', { type: 'char', text: ch })
    await sleep(55 + Math.random() * 45)
  }
}

// ---- what the page shows, read 5 times a second ---------------------------------------------------

const snapshot = () => {
  const $ = (id) => document.getElementById(id)
  const vis = (id) => !$(id).classList.contains('hidden')
  const s = globalThis.__lantern?.state
  const c = globalThis.__lantern?.client
  const stall = s?.stall
  return {
    titleReady: vis('title') && vis('title-actions'),
    titleLine: $('title-line').textContent,
    started: !!s?.started,
    night: s?.world?.night ?? null,
    walking: !!s?.walking,
    stall: stall ? { id: stall.id, name: stall.name, money: stall.money, worth: stall.worth, stock: stall.stock, price: stall.price, listed: stall.listed, spot: stall.spot } : null,
    pending: s?.pendingGoods?.size ?? 0,
    status: $('status-text').textContent,
    hint: vis('hint') ? $('hint-text').textContent : null,
    toast: vis('toast') ? $('toast').textContent : null,
    summary: vis('summary') && vis('summary-report') ? { night: $('summary-night').textContent, headline: $('summary-headline').textContent, lines: [...document.querySelectorAll('#summary-lines li')].map((l) => l.textContent) } : null,
    outcome: vis('summary') && vis('summary-outcome') ? { text: $('summary-outcome').textContent, met: $('summary-outcome').classList.contains('met'), stamp: vis('summary-stamp') } : null,
    call: vis('summary') && vis('summary-call') ? { title: $('call-title').textContent, text: $('call-text').textContent, accept: $('call-accept').textContent, decline: $('call-decline').textContent, kind: s?.call?.call?.kind, answered: s?.call?.accepted } : null,
    event: { title: $('event-title').textContent, next: $('event-next').textContent, kind: $('event-banner').className.replace('event-banner', '').trim() },
    sheet: vis('sheet') ? $('sheet-title').textContent : null,
    forSale: !!document.querySelector('[data-unlist]'),
    txs: c?.txs?.length ?? 0,
    lastTx: c?.txs?.[0] ? { kind: c.txs[0].kind, hash: c.txs[0].hash, gas: c.txs[0].gas, failure: c.txs[0].failure ?? null } : null,
    account: s?.identity?.account ?? null,
  }
}

const seen = { nights: 0, calledIt: 0, calls: 0, answered: 0, summaries: 0, events: new Set(), firstNight: null }
let last = {}
let latest = null
async function watch(page) {
  for (;;) {
    let st
    try {
      st = await page.eval(snapshot)
    } catch {
      await sleep(200)
      continue
    }
    latest = st
    if (st.titleReady && !last.titleReady) mark('title-ready', { line: st.titleLine })
    if (st.titleLine !== last.titleLine && !st.started) mark('title-line', { text: st.titleLine })
    if (st.started && !last.started) mark('entered', { stall: st.stall, account: st.account })
    if (st.night !== last.night && st.night != null) {
      if (last.night != null && st.started) {
        seen.nights += st.night - last.night
        mark('night', { night: st.night, money: st.stall?.money, stock: st.stall?.stock })
      } else if (seen.firstNight == null) seen.firstNight = st.night
    }
    if (st.walking && !last.walking) mark('walk-start', { night: st.night })
    if (!st.walking && last.walking) mark('walk-end', { night: st.night })
    if (st.summary && JSON.stringify(st.summary) !== JSON.stringify(last.summary)) {
      seen.summaries++
      mark('summary', st.summary)
    }
    if (!st.summary && last.summary) mark('summary-hidden')
    if (st.outcome && JSON.stringify(st.outcome) !== JSON.stringify(last.outcome)) {
      mark('outcome', st.outcome)
      if (st.outcome.met) seen.calledIt++
    }
    if (st.call && (!last.call || st.call.title !== last.call.title || st.call.answered !== last.call.answered)) {
      if (st.call.answered == null && (!last.call || st.call.title !== last.call.title)) seen.calls++
      mark('call', st.call)
    }
    if (!st.call && last.call) mark('call-hidden')
    if (JSON.stringify(st.event) !== JSON.stringify(last.event)) {
      mark('banner', st.event)
      if (st.event.kind) seen.events.add(st.event.kind)
    }
    if (st.hint !== last.hint) mark('hint', { text: st.hint })
    if (st.toast !== last.toast) mark('toast', { text: st.toast })
    if (st.status !== last.status) mark('status', { text: st.status })
    if (st.sheet !== last.sheet) mark('sheet', { title: st.sheet })
    if (st.forSale !== last.forSale) mark('for-sale', { listed: st.forSale })
    if (st.stall?.listed !== last.stall?.listed && st.started) mark('listed', { price: st.stall?.listed ?? null })
    if (st.txs !== last.txs && st.lastTx) mark('tx', st.lastTx)
    if (st.stall && last.stall && (st.stall.money !== last.stall.money || JSON.stringify(st.stall.stock) !== JSON.stringify(last.stall.stock))) mark('state', { money: st.stall.money, stock: st.stall.stock, price: st.stall.price })
    if (st.pending === 0 && last.pending > 0) mark('stamped', { stock: st.stall?.stock, price: st.stall?.price })
    last = st
    await sleep(200)
  }
}

// ---- the take -----------------------------------------------------------------------------------

/** Plays: restock, prices, then the nights, answering every call, until a call has paid off. */
async function play(page, t0) {
  // one tap fills the counter, one more prices it
  await click(page, '#btn-restock', 'Restock')
  await sleep(1600)
  await click(page, '#btn-smart', 'Smart prices')
  await page.waitFor(() => globalThis.__lantern.state.pendingGoods.size === 0 && globalThis.__lantern.client.txs.some((t) => t.kind === 'act' && !t.failure), 90000, 300)
  await sleep(3000)
  // move the hand away from the buttons while the villagers walk
  await moveTo(page, W * 0.62, H * 0.42, 500)

  // nights: answer every call, restock now and then, stop once a call has paid off
  let lastAnswered = -1
  let lastRestockNight = latest?.night ?? 0
  let callShownAt = 0
  let lastCallKey = null
  while (Date.now() - t0 < MAX_MIN * 60000) {
    await sleep(300)
    const st = latest
    if (!st) continue
    if (st.call && st.call.answered == null && !st.walking) {
      const key = `${st.night}:${st.call.title}`
      if (key !== lastCallKey) {
        lastCallKey = key
        callShownAt = Date.now()
      }
      // let the viewer read the call before the hand moves
      if (Date.now() - callShownAt > 3200 && lastAnswered !== st.night) {
        lastAnswered = st.night
        seen.answered++
        await click(page, '#call-accept', `call: ${st.call.accept}`)
        await sleep(800)
        await moveTo(page, W * 0.62, H * 0.42, 500)
      }
    } else if (!st.walking && !st.summary && !st.call && st.night - lastRestockNight >= 2 && st.stall && st.stall.listed == null) {
      lastRestockNight = st.night
      const plan = await page.eval(() => document.getElementById('restock-sub').textContent)
      if (!/full|waiting/.test(plan)) {
        await click(page, '#btn-restock', 'Restock')
        await sleep(1000)
        await moveTo(page, W * 0.62, H * 0.42, 500)
      }
    }
    if (seen.nights >= NIGHTS && seen.calledIt > 0 && !st.walking && (!st.summary || Date.now() - callShownAt > 4500)) break
  }
}

/** Withdraws a listing left from an earlier take and fills the counter, off camera as far as the cut goes. */
async function prepare(page) {
  if (latest?.stall?.listed != null) {
    await click(page, '#btn-deed', 'Deed')
    await page.waitFor(() => document.querySelector('[data-unlist]'), 20000)
    await click(page, '[data-unlist]', 'Withdraw')
    await page.waitFor(() => globalThis.__lantern.state.pendingGoods.size === 0 && globalThis.__lantern.state.stall.listed == null, 60000, 300)
    await sleep(1500)
  }
  await click(page, '#btn-restock', 'Restock')
  await page.waitFor(() => globalThis.__lantern.state.pendingGoods.size === 0 && globalThis.__lantern.state.stall.stock.some((n) => n > 0), 90000, 300)
  await sleep(1500)
  await moveTo(page, W * 0.62, H * 0.42, 500)
}

/** The deed (list the stall for sale), the ranks and the proof drawer. */
async function deedRanksProof(page) {
  // right after a report, so no walk cuts in
  const seenNight = latest?.night
  await page.waitFor((n) => globalThis.__lantern.state.world.night > n, 120000, 300, seenNight).catch(() => {})
  await page.waitFor(() => !globalThis.__lantern.state.walking && !document.getElementById('summary').classList.contains('hidden') && !document.getElementById('summary-report').classList.contains('hidden'), 120000, 300).catch(() => {})
  await sleep(3000)
  if (latest?.call && latest.call.answered == null) await click(page, '#call-accept', `call: ${latest.call.accept}`)
  else if (latest?.summary) await click(page, '#summary-close', 'close report')
  await sleep(1200)
  await click(page, '#btn-deed', 'Deed')
  await page.waitFor(() => document.querySelector('[data-list]') || document.querySelector('[data-unlist]'), 20000)
  await sleep(4500)
  if (await page.eval(() => !!document.querySelector('[data-list]'))) {
    await click(page, '[data-list]', 'List for sale')
    await moveTo(page, W * 0.62, H * 0.3, 500)
    // the sign goes up when the chain has the listing; a night change in between redraws from the chain
    await page.waitFor(() => globalThis.__lantern.state.pendingGoods.size === 0 && globalThis.__lantern.state.stall.listed != null && globalThis.__lantern.client.txs[0]?.kind === 'act', 60000, 300)
    await sleep(5000)
  } else {
    await click(page, '#sheet-close', 'close')
    await sleep(2500)
  }
  await page.waitFor(() => !globalThis.__lantern.state.walking, 60000, 300).catch(() => {})
  await click(page, '#btn-board', 'Ranks')
  await page.waitFor(() => document.querySelectorAll('.board li').length > 0, 20000)
  await sleep(5000)
  await click(page, '#sheet-close', 'close')
  await sleep(800)
  await click(page, '#btn-proof', 'Proof')
  await sleep(4000)
  await click(page, '#sheet-close', 'close')
  await sleep(2500)
}

async function main() {
  const chrome = await launchChrome({ port: PORT, profileDir: PROFILE, width: W, height: H, extraArgs: ['--force-color-profile=srgb', '--font-render-hinting=none', '--mute-audio'] })
  const page = await open(chrome, URL_)
  let frames = 0
  page.on('Page.screencastFrame', (p) => {
    frames++
    writeFileSync(join(OUT, 'frames', `f${String(frames).padStart(6, '0')}.jpg`), Buffer.from(p.data, 'base64'))
    framesOut.write(JSON.stringify({ i: frames, t: p.metadata.timestamp }) + '\n')
    page.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {})
  })
  await page.send('Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: W * SCALE, maxHeight: H * SCALE, everyNthFrame: 1 })
  mark('record', { url: URL_, viewport: [W, H], scale: SCALE })
  const t0 = Date.now()
  const watcher = watch(page)
  try {
    await page.waitFor(() => !document.getElementById('title-actions').classList.contains('hidden'), 60000, 250)
    await sleep(DRY ? 5000 : 3500)
    if (DRY) {
      await sleep(1000)
      return
    }
    const fresh = await page.eval(() => !document.getElementById('name-row').classList.contains('hidden'))
    if (fresh) {
      await typeInto(page, '#stall-name', NAME)
      await sleep(600)
    }
    await click(page, '#start', 'Open your stall')
    await page.waitFor(() => globalThis.__lantern?.state?.started === true, 180000, 400)
    await sleep(3800)
    if (!SKIP_PLAY) await play(page, t0)
    else if (RESTOCK) await prepare(page)
    await deedRanksProof(page)
  } catch (e) {
    mark('error', { message: e.message })
    console.error(e)
  } finally {
    mark('end', { frames, nights: seen.nights, calledIt: seen.calledIt })
    await page.send('Page.stopScreencast').catch(() => {})
    await sleep(500)
    const st = latest ?? {}
    const txs = await page.eval(() => globalThis.__lantern?.client?.txs ?? []).catch(() => [])
    writeFileSync(
      join(OUT, 'take.json'),
      JSON.stringify({ url: URL_, name: NAME, account: st.account, stall: st.stall, nights: seen.nights, firstNight: seen.firstNight, lastNight: st.night, calledIt: seen.calledIt, calls: seen.calls, answered: seen.answered, events: [...seen.events], frames, txs, console: page.console.slice(-40) }, null, 2),
    )
    eventsOut.end()
    framesOut.end()
    await page.close().catch(() => {})
    chrome.kill()
    watcher.catch(() => {})
    log(`done: ${frames} frames, ${seen.nights} nights, called it ${seen.calledIt}x, ${txs.length} transactions`)
    process.exit(0)
  }
}

main()

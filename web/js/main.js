// The game controller: boots the street, founds the stall, runs the night loop, turns taps into
// actions and the chain's answers into pictures.
import { ed25519Supported } from './near.js'
import { ActionQueue, Client, FriendlyError, loadOrCreateIdentity, CONTRACT } from './chain.js'
import { Scene, drawLogo } from './scene.js'
import { Sound } from './audio.js'
import * as L from './logic.js'
import * as U from './ui.js'

const EXPLORER = 'https://testnet.nearblocks.io'
const CODE_HASH = L.WASM_SHA256
const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

const S = {
  cfg: null,
  world: null,
  clockOffset: 0,
  me: null,
  stall: null,
  prevStall: null,
  board: [], // the raw leaderboard: every stall, on the row or not
  standing: null, // {place, of, ahead, merchant}: the stall's place among the players
  goals: [], // worth milestones, from the contract's own numbers
  goalReached: null, // the highest milestone this stall has passed (worth)
  identity: null,
  walking: false,
  advancing: false,
  lastAdvanceTry: 0,
  shownNight: null,
  started: false,
  pendingGoods: new Set(),
  progress: { restocked: false, priced: false, walked: 0, firstSale: null, openedDeed: false, rivalName: null },
  pollTimer: null,
  failures: 0,
  foundingName: null,
  refusalRetries: 3,
  fc: null, // tonight's demand forecast, from the world view
  call: null, // {call, accepted: true|false|null, night}: tonight's decision and what the player said
  lastCall: null, // the call of the night that just ended, waiting to be judged
  skipGood: null, // {good, night}: a good the player chose to wait on until the Dock gets cheap
  summaryTimer: null,
  bestOffset: -Infinity, // chain clock minus browser clock, the largest seen: a smaller one means a stale view
  lastStale: 0,
}

// Watching the row: the title street replays the latest nights from the chain's own night logs.
// Read-only: views only, never a transaction, never advance_night.
const W = { on: false, token: 0, logs: new Map(), cycle: [], next: 0, pollTimer: null, watching: false }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const client = new Client()
const sound = new Sound()
let scene
let queue

// ---- boot ---------------------------------------------------------------------------------------

async function boot() {
  if (!(await ed25519Supported())) {
    U.$('title').classList.add('hidden')
    U.$('unsupported').classList.remove('hidden')
    return
  }
  scene = new Scene(U.$('scene'), { reducedMotion: reduced })
  scene.setTitle(true)
  scene.start()
  drawLogo(U.$('logo'))
  window.addEventListener('resize', () => {
    layout()
    if (S.started && S.stall) scene.focusStall(S.stall.id)
  })
  layout()
  scene.onTap = onTapStall
  scene.onCoin = onCoin
  scene.onBubble = onBubble
  let hostToasts = 0
  client.rpc.onHostChange = (h) => S.started && hostToasts++ === 0 && U.toast(`Switched to a backup connection (${new URL(h).host}).`, 'warn')
  wireButtons()

  try {
    const [cfg, world] = await Promise.all([client.config(), client.world()])
    S.cfg = cfg
    cfg.contract = CONTRACT
    applyWorld(world)
    scene.setWorld(world, cfg)
    scene.cam.target = 2 * 210
    scene.cam.x = -2 * 210
    // `?scene=festival|storm|quiet` dresses the title street for a screenshot (the social preview
    // image is made this way). It never touches the game: entering the game reloads the real event.
    const params = new URLSearchParams(location.search)
    const dress = params.get('scene')
    if (dress) scene.event = { kind: dress, good: 0 }
    if (params.has('poster')) U.$('title').classList.add('poster')
    S.identity = await loadOrCreateIdentity()
    S.me = await client.setIdentity(S.identity)
    U.$('title-line').textContent = L.titleLine(world, cfg)
    const returning = S.me.stalls?.length > 0
    U.$('name-row').classList.toggle('hidden', returning)
    U.$('start').textContent = returning ? `Back to ${S.me.stalls[0].name}` : 'Open your stall'
    if (!returning) U.$('stall-name').value = L.randomStallName()
    U.$('title-actions').classList.remove('hidden')
    S.goals = L.milestones(cfg)
    U.setIdle(L.idleNotice(world, cfg))
    startReplay()
  } catch (e) {
    console.error(e)
    U.$('title-line').textContent = 'The street is out of reach right now.'
    const err = U.$('title-error')
    err.textContent = 'Could not reach NEAR testnet. Check your connection and reload.'
    err.classList.remove('hidden')
  }
}

function layout() {
  const panel = U.$('panel')
  const bottom = panel.classList.contains('hidden') ? Math.min(60, window.innerHeight * 0.06) : panel.getBoundingClientRect().height
  const hud = U.$('hud')
  const top = hud.classList.contains('hidden') ? 0 : hud.getBoundingClientRect().height
  scene.resize()
  scene.setInsets({ top, bottom })
}

function wireButtons() {
  U.$('shuffle-name').addEventListener('click', () => (U.$('stall-name').value = L.randomStallName()))
  U.$('start').addEventListener('click', startGame)
  U.$('stall-name').addEventListener('keydown', (e) => e.key === 'Enter' && startGame())
  U.$('stall-chip').addEventListener('click', () => S.stall && scene.focusStall(S.stall.id))
  U.$('btn-restock').addEventListener('click', onRestock)
  U.$('btn-smart').addEventListener('click', onSmartPrices)
  U.$('btn-board').addEventListener('click', openBoard)
  U.$('btn-deed').addEventListener('click', openDeed)
  U.$('btn-proof').addEventListener('click', openProof)
  U.$('watch').addEventListener('click', () => setWatching(true))
  U.$('watch-play').addEventListener('click', () => setWatching(false))
  U.$('watch-proof').addEventListener('click', openProof)
  U.$('btn-sound').addEventListener('click', () => {
    sound.enable()
    sound.setMuted(!sound.muted)
    renderSound()
  })
  U.$('sheet-close').addEventListener('click', U.closeSheet)
  U.$('sheet-backdrop').addEventListener('click', U.closeSheet)
  U.$('summary-close').addEventListener('click', closeSummary)
  U.$('call-accept').addEventListener('click', () => answerCall(true))
  U.$('call-decline').addEventListener('click', () => answerCall(false))
  document.addEventListener('keydown', (e) => e.key === 'Escape' && (U.closeSheet(), U.hidePeek()))
  document.addEventListener('visibilitychange', () => schedulePoll(document.hidden ? 5000 : 300))
  renderSound()
}

function renderSound() {
  U.$('btn-sound').querySelector('.ico').classList.toggle('off', sound.muted)
}

// ---- start ----------------------------------------------------------------------------------------

async function startGame() {
  if (S.started) return
  sound.enable()
  const btn = U.$('start')
  btn.disabled = true
  U.$('title-error').classList.add('hidden')
  try {
    if (!S.me.stalls?.length) {
      const name = L.cleanName(U.$('stall-name').value) || L.randomStallName()
      if (!L.validName(name)) throw new FriendlyError('Names take letters, digits, spaces, - and \', up to 24 of them.')
      S.foundingName = name
      // A town nobody watched has nights to catch up on. Let it, before the stall exists, so the
      // first night report is about the first night and not about back rent.
      await catchUpBeforeFounding()
      U.$('title-line').textContent = 'The town clerk is writing your deed…'
      await found(name)
    }
    await enterGame()
  } catch (e) {
    console.error(e)
    const err = U.$('title-error')
    err.textContent = e instanceof FriendlyError ? e.message : 'Something went wrong. Try again in a moment.'
    err.classList.remove('hidden')
    btn.disabled = false
    U.$('title-line').textContent = ''
  }
}

async function catchUpBeforeFounding() {
  try {
    const world = await client.world()
    if (!world.due) return
    U.$('title-line').textContent = 'Waking the town…'
    await client.advanceNight()
    applyWorld(await client.world())
  } catch (e) {
    console.info('catch-up before founding', e?.message)
  }
}

async function found(name) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const out = await client.act([{ found: { name } }])
    if (out?.minted?.length) {
      const id = out.minted[0]
      for (let i = 0; i < 20; i++) {
        S.me = await client.player()
        if (S.me.stalls?.some((s) => s.id === id)) return
        await new Promise((r) => setTimeout(r, 700))
      }
      return
    }
    const why = out?.error ?? ''
    if (/licence|license|tonight/i.test(why)) {
      U.$('title-line').textContent = 'The clerk has no licences left tonight. Waiting for the next night…'
      await waitForNextNight()
      continue
    }
    if (/name/i.test(why)) throw new FriendlyError(`The clerk refused the name: ${why}.`)
    throw new FriendlyError(`The clerk refused: ${why}.`)
  }
  throw new FriendlyError('No licence tonight. Try again in a minute.')
}

async function waitForNextNight() {
  const start = (await client.world()).night
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2500))
    const w = await client.world()
    if (w.due && Date.now() - S.lastAdvanceTry > 5000) {
      S.lastAdvanceTry = Date.now()
      try {
        await client.advanceNight()
      } catch {
        /* someone else may have */
      }
    }
    if (w.night > start) return
  }
}

async function enterGame() {
  S.started = true
  S.stall = S.me.stalls[0]
  S.prevStall = S.stall
  try {
    applyWorld(await client.world())
  } catch {
    /* the poll loop will catch up */
  }
  stopReplay()
  scene.zoom = 1
  U.$('title').classList.add('hidden')
  U.$('watchbar').classList.add('hidden')
  U.$('hud').classList.remove('hidden')
  U.$('panel').classList.remove('hidden')
  scene.setTitle(false)
  scene.setPlayer(S.stall.id)
  scene.setWorld(S.world, S.cfg)
  scene.focusStall(S.stall.id, { instant: false })
  layout()
  U.buildGoods(S.cfg, { onPrice, onCard })
  S.goals = L.milestones(S.cfg)
  S.goalReached = loadGoal(S.stall)
  queue = new ActionQueue(client, { onFlush, onError, onPending })
  S.shownNight = S.world.night
  S.progress.rivalName = S.world.row.find((s) => s.npc && s.spot != null)?.name ?? 'The Quiet Kettle'
  if (S.stall.stock.some((n) => n > 0)) S.progress.restocked = true
  if (S.stall.price.some((p) => p > 0)) S.progress.priced = true
  if (S.stall.customers > 0) S.progress.walked = 5
  applyWorld(S.world)
  renderAll()
  // A returning player knows the ropes: straight to tonight's call.
  if (S.progress.walked) offerCall()
  tutorial()
  schedulePoll(50)
  setInterval(tickClock, 250)
  if (S.stall.spot == null) U.toast('Your stall has no spot on the row right now. Open the deed to move onto one.', 'warn', 6000)
}

// ---- polling ------------------------------------------------------------------------------------

function schedulePoll(ms) {
  clearTimeout(S.pollTimer)
  S.pollTimer = setTimeout(poll, ms)
}

let pollCount = 0
async function poll() {
  try {
    const world = await client.world()
    S.failures = 0
    const nightBefore = S.world?.night ?? world.night
    applyWorld(world)
    if (world.night > nightBefore) queueNight(world, world.night - nightBefore)
    else {
      const spotBefore = scene.stallById.get(S.stall?.id)?.spot
      scene.setWorld(world, S.cfg)
      const spotNow = scene.stallById.get(S.stall?.id)?.spot
      if (spotBefore !== spotNow) scene.focusStall(S.stall.id)
    }
    if (isDue(world) && !S.advancing && Date.now() - S.lastAdvanceTry > 4000) advance()
    pollCount++
    if (!queue.busy && pollCount % 2 === 0) await refreshMe()
    if (pollCount % 6 === 1) await refreshBoard()
    if (!S.walking) U.setStatus(queue.busy ? 'busy' : '', queue.busy ? 'Stamping your order…' : 'Ready')
  } catch (e) {
    S.failures++
    console.warn('poll', e)
    if (S.failures === 3) U.toast('The connection to the town is flickering. Retrying…', 'warn')
    U.setStatus('error', 'Reconnecting…')
  }
  schedulePoll(document.hidden ? 5000 : S.walking ? 2500 : 1500)
}

/**
 * A night is due when the chain says so, or when the browser's clock says the night ended a while
 * ago and the view still disagrees: an RPC node that fell behind serves a stale world, with a stale
 * clock and a stale `due`. Then the client moves to the other host; an early advance_night is harmless.
 */
function isDue(world) {
  if (world.due) return true
  const overdue = Date.now() + S.bestOffset - world.ends_ms
  if (overdue > 25000) {
    if (Date.now() - S.lastStale > 60000) {
      S.lastStale = Date.now()
      console.info('stale view', Math.round(overdue / 1000), 's overdue; switching host')
      client.rpc.active = (client.rpc.active + 1) % client.rpc.hosts.length
    }
    return true
  }
  return false
}

function applyWorld(world) {
  S.world = world
  S.clockOffset = world.now_ms - Date.now()
  if (S.clockOffset > S.bestOffset) S.bestOffset = S.clockOffset
  if (S.started && S.stall) {
    S.fc = L.forecast(world, S.cfg, S.stall)
    U.renderNight(world)
    U.renderEvent(world, S.cfg)
  }
}

function tickClock() {
  if (!S.world) return
  const now = Date.now() + Math.max(S.clockOffset, S.bestOffset - 5000)
  const left = S.world.ends_ms - now
  U.renderClock(Math.max(0, left) / S.cfg.night_ms, { walking: S.walking })
}

async function advance() {
  S.advancing = true
  S.lastAdvanceTry = Date.now()
  try {
    // A small, account-specific delay so two open tabs rarely race; a race is harmless anyway.
    await new Promise((r) => setTimeout(r, (parseInt(S.identity.account.slice(0, 4), 16) % 1400) + 100))
    const fresh = await client.world()
    if (!isDue(fresh)) return
    const out = await client.advanceNight()
    const text = L.catchUpText(out?.advanced ?? 1, out?.slept ?? 0)
    if (text) U.toast(text, 'warn', 7000)
    schedulePoll(50)
  } catch (e) {
    // Another tab usually ended the night first; only a dry gas pool is worth telling the player.
    console.info('advance', e?.message)
    if (e instanceof FriendlyError && /gas pool/.test(e.message)) U.setStatus('error', e.message)
  } finally {
    S.advancing = false
  }
}

/** A view that has not seen our latest transaction yet would roll the optimistic state back. */
function isStale(me) {
  return (me.nonce ?? 0) < (client.nonce ?? 0)
}

async function refreshMe() {
  const me = await client.player()
  if (isStale(me)) return
  S.me = me
  const mine = me.stalls?.find((s) => s.id === S.stall?.id) ?? me.stalls?.[0]
  if (!mine) return
  if (!queue.busy) {
    S.stall = mine
    scene.updateStall(mine)
    renderAll()
  }
}

async function refreshBoard() {
  try {
    setBoard(await client.leaderboard(120))
  } catch {
    /* next time */
  }
}

function setBoard(board) {
  const before = S.standing
  S.board = board
  S.standing = L.standing(board, S.stall.id)
  const passed = L.passedText(before, S.standing)
  if (passed) {
    U.toast(passed, 'ok', 5000)
    sound.fanfare()
  }
  renderHud()
}

// ---- nights -------------------------------------------------------------------------------------

// Nights are played one after another. If the chain moved on while a walk was playing, the nights
// that piled up are shown as one: the latest log walks, the report counts them all.
let nightChain = Promise.resolve()
function queueNight(world, nights) {
  S.pendingNight = { world, nights: (S.pendingNight?.nights ?? 0) + nights }
  nightChain = nightChain
    .then(async () => {
      const p = S.pendingNight
      if (!p) return
      S.pendingNight = null
      await onNightChanged(p.world, p.nights)
    })
    .catch((e) => console.warn('night', e))
}

async function onNightChanged(world, nights = 1) {
  sound.chime()
  clearTimeout(S.summaryTimer)
  U.hideSummary()
  S.lastCall = S.call
  S.call = null
  if (S.skipGood && S.skipGood.night < world.night) S.skipGood = null
  S.prevStall = S.stall
  await refreshMeNow()
  scene.setWorld(world, S.cfg)
  let log = world.last
  if (!log || log.night !== world.night - 1) {
    try {
      log = await client.nightLog(world.night - 1)
    } catch {
      log = world.last
    }
  }
  if (!log) return
  S.walking = true
  U.setStatus('busy', 'The villagers are walking the row…')
  U.hideHint()
  renderGoods()
  await scene.playNight(log, { duration: reduced ? 4 : 9, reasonFor: reasonsFor(log, S.world) })
  S.walking = false
  await refreshMeNow()
  const summary = L.summariseNight({ log, stall: S.stall, before: S.prevStall, world: S.world, cfg: S.cfg, villagers: S.world.villagers, nights })
  const outcome = S.lastCall && S.lastCall.accepted != null ? L.judgeCall(S.lastCall.call, { log, stall: S.stall, before: S.prevStall, world: S.world, cfg: S.cfg, accepted: S.lastCall.accepted }) : null
  S.lastOutcome = outcome
  U.showSummary(log.night, summary, outcome)
  U.$('summary').classList.remove('hidden')
  if (outcome?.met) sound.fanfare()
  S.progress.walked++
  if (summary.sold && !S.progress.firstSale) {
    const g = [...summary.perGood.keys()][0]
    S.progress.firstSale = S.cfg.goods[g].name
    sound.fanfare()
    scene.celebrate(S.stall.spot * 210)
  }
  if (summary.sold) sound.coin()
  offerCall()
  tutorial()
  U.setStatus('', 'Ready')
}

/** Works out tonight's call and puts it under the report (or alone, when there is no report). */
function offerCall() {
  if (S.walking || !S.stall) return
  const log = S.world.last && S.world.last.night === S.world.night - 1 ? S.world.last : null
  // a call that was taken last night and did not pay is not asked again tonight
  const avoid = S.lastCall?.accepted && S.lastOutcome?.met === false ? { kind: S.lastCall.call.kind, good: S.lastCall.call.good } : null
  const call = L.nightlyCall({ world: S.world, cfg: S.cfg, stall: S.stall, log, fc: S.fc, avoid })
  S.call = call ? { call, accepted: null, night: S.world.night } : null
  clearTimeout(S.summaryTimer)
  if (call) U.showCall(call, { alone: !U.summaryVisible() })
  else if (U.summaryVisible()) S.summaryTimer = setTimeout(closeSummary, 9000)
}

function answerCall(yes) {
  sound.tap()
  const c = S.call
  if (!c) return closeSummary()
  c.accepted = yes
  if (yes) {
    if (c.call.accept.skip != null) S.skipGood = { good: c.call.accept.skip, night: c.night }
    // the counter may have filled since the call was made: buy only what still fits
    const room = S.stall.capacity - S.stall.stock.reduce((a, b) => a + b, 0)
    const actions = c.call.accept.actions
      .map((a) => (a.buy && a.buy.qty > room ? (room > 0 ? { buy: { ...a.buy, qty: room } } : null) : a))
      .filter(Boolean)
    if (actions.length) {
      push(...actions)
      queue.flush()
      S.progress.restocked = S.progress.restocked || actions.some((a) => a.buy)
      S.progress.priced = S.progress.priced || actions.some((a) => a.price)
    }
    U.toast(`${c.call.accept.label}. The night report will say how it went.`, 'ok')
  }
  closeSummary()
}

function closeSummary() {
  clearTimeout(S.summaryTimer)
  U.hideSummary()
  tutorial()
}

async function refreshMeNow() {
  try {
    let me = await client.player()
    for (let i = 0; i < 4 && isStale(me); i++) {
      await new Promise((r) => setTimeout(r, 700))
      me = await client.player()
    }
    if (isStale(me)) return
    S.me = me
    const mine = me.stalls?.find((s) => s.id === S.stall.id)
    if (mine) {
      S.stall = mine
      scene.updateStall(mine)
    }
    renderAll()
  } catch {
    /* keep what we have */
  }
}

function onCoin(stallId, price) {
  if (stallId !== S.stall?.id) return
  sound.coin()
  const tax = Math.ceil((price * S.cfg.sales_tax_pct) / 100)
  S.stall = { ...S.stall, money: S.stall.money + price - tax }
  renderHud()
}

function onBubble(step) {
  if (step.kind === 'refuse' && step.stall === S.stall?.id) sound.refuse()
}

// ---- actions ------------------------------------------------------------------------------------

function onPrice(g, dir) {
  sound.tap()
  const cur = S.stall.price[g]
  let next
  if (cur === 0) {
    next = dir > 0 ? L.suggestPrices(S.world, S.cfg, S.stall, S.fc)[g].price : 0
  } else {
    const step = Math.max(1, Math.round(cur * 0.05))
    next = Math.max(0, cur + dir * step)
    if (dir < 0 && next < Math.floor(S.cfg.goods[g].dock_base * 0.5)) next = 0
  }
  next = Math.min(next, S.cfg.goods[g].max_price)
  if (next === cur) return
  push({ price: { stall: S.stall.id, good: g, price: next } })
  S.progress.priced = true
  tutorial()
}

function onSmartPrices() {
  sound.tap()
  const sugg = L.suggestPrices(S.world, S.cfg, S.stall, S.fc)
  const acts = sugg.map((s, g) => ({ price: { stall: S.stall.id, good: g, price: s.price } })).filter((a) => a.price.price !== S.stall.price[a.price.good])
  if (!acts.length) return U.toast('Your prices already sit where they sell best tonight.')
  push(...acts)
  S.progress.priced = true
  const first = acts[0].price.good
  U.toast(`Priced ${acts.length} good${acts.length === 1 ? '' : 's'}. ${S.cfg.goods[first].name} ${sugg[first].price}: ${sugg[first].reason}.`, 'ok', 5000)
  tutorial()
}

function onRestock() {
  sound.tap()
  if (S.stall.listed != null) return U.toast('A listed stall cannot buy. Withdraw the listing first.', 'warn')
  const plan = restockPlan()
  if (!plan.items.length) {
    const full = S.stall.stock.reduce((a, b) => a + b, 0) >= S.stall.capacity
    return U.toast(full ? 'The counter is full.' : S.stall.money < 60 ? 'Not enough coin to buy anything. Sell what you have first.' : 'The Dock has nothing you need right now.', 'warn')
  }
  const acts = L.restockActions(S.stall.id, plan)
  // Price what we just bought, if it has no price yet.
  const sugg = L.suggestPrices(S.world, S.cfg, S.stall, S.fc)
  for (const i of plan.items) if (S.stall.price[i.good] === 0) acts.push({ price: { stall: S.stall.id, good: i.good, price: sugg[i.good].price } })
  push(...acts)
  S.progress.restocked = true
  if (acts.some((a) => a.price)) S.progress.priced = true
  U.toast(`Buying ${L.listWords(plan.items.map((i) => `${i.qty} ${S.cfg.goods[i.good].name}`))} for about ${L.fmt(plan.total)}.`, 'ok')
  tutorial()
}

function restockPlan() {
  const skip = S.skipGood && S.skipGood.night === S.world.night ? S.skipGood.good : null
  return L.suggestRestock(S.world, S.cfg, S.stall, { skip, fc: S.fc })
}

function push(...actions) {
  if (!queue.busy) S.refusalRetries = 3
  S.stall = L.project(S.stall, actions, S.world, S.cfg)
  for (const a of actions) {
    const g = a.price?.good ?? a.buy?.good
    if (g != null) S.pendingGoods.add(g)
  }
  scene.updateStall(S.stall)
  renderAll()
  U.setStatus('busy', 'Stamping your order…')
  queue.push(...actions)
}

function onPending() {}

async function onFlush(out, batch) {
  const goods = [...new Set(batch.map((a) => a.price?.good ?? a.buy?.good).filter((g) => g != null))]
  if (out?.error) {
    const applied = out.applied ?? 0
    const refused = batch[applied]
    console.info('refused', out.error, JSON.stringify(refused))
    U.toast(explainRefusal(out.error, refused), 'warn', 5000)
    sound.refuse()
    // The contract stops at the first refused action. Send the rest again, with a buy that asked for
    // more than the Dock has clipped to what is left, so one stale number does not spoil the order.
    const rest = batch.slice(applied + 1)
    if (S.refusalRetries > 0 && (rest.length || refused?.buy)) {
      S.refusalRetries--
      try {
        const world = await client.world()
        applyWorld(world)
        const again = []
        if (refused?.buy && /that many|supply/i.test(out.error)) {
          const g = refused.buy.good
          const qty = Math.min(refused.buy.qty, world.dock[g].left)
          if (qty > 0) again.push({ buy: { ...refused.buy, qty, max_cost: Math.ceil(L.dockCost(S.cfg.goods[g], world.dock[g], qty) * 1.3) + 2 } })
        }
        again.push(...rest)
        if (again.length) queue.push(...again)
      } catch {
        /* the player can tap again */
      }
    }
  } else {
    sound.stamp()
    U.stampCards(goods)
  }
  S.pendingGoods.clear()
  if (!queue.busy) {
    U.setStatus('', 'Ready')
    await refreshMeNow()
  }
}

async function onError(err) {
  console.warn('act', err)
  U.toast(err instanceof FriendlyError ? err.message : 'The order did not go through. Nothing was lost.', 'warn', 5000)
  S.pendingGoods.clear()
  U.setStatus('error', 'Order not stamped')
  await refreshMeNow()
}

function explainRefusal(error, action) {
  const e = String(error)
  if (/money/i.test(e)) return 'Not enough coin for that. The rest of your order went through.'
  if (/capacity|room|full/i.test(e)) return 'The counter is full. Grow the stall to hold more.'
  if (/supply|left|dock/i.test(e)) return 'The Dock ran out of that good tonight.'
  if (/max_cost|cost/i.test(e)) return 'The Dock price moved while you were buying. Try again.'
  if (/listed|frozen/i.test(e)) return 'A listed stall cannot buy, move or grow. Withdraw the listing first.'
  if (/cooldown/i.test(e)) return 'Your stall moved recently; it can move again in a few nights.'
  if (/spot/i.test(e)) return 'That spot is not free any more.'
  if (/earned/i.test(e)) return 'Only coin earned from villagers can buy another stall; grants do not count.'
  return `The clerk said: ${e}${action ? ` (${Object.keys(action)[0]})` : ''}.`
}

// ---- deed and sheets ----------------------------------------------------------------------------

async function openDeed() {
  sound.tap()
  S.progress.openedDeed = true
  tutorial()
  let token = null
  try {
    token = await client.nftToken(S.stall.id)
  } catch {
    /* the picture is optional */
  }
  const freeSpots = freeSpotsAhead()
  const body = U.openSheet('Your stall', U.deedHtml({ stall: S.stall, token, cfg: S.cfg, account: S.identity.account, royaltyPct: S.cfg.royalty_pct, freeSpots }))
  drawDeedScene(body.querySelector('#deed-scene'), S.stall)
  body.querySelector('[data-upgrade]')?.addEventListener('click', () => {
    push({ upgrade: { stall: S.stall.id, max_cost: S.cfg.tier_cost[S.stall.tier + 1] } })
    U.closeSheet()
    U.toast('Growing the stall: more goods, more customers.', 'ok')
  })
  body.querySelectorAll('[data-move]').forEach((b) =>
    b.addEventListener('click', () => {
      const spot = Number(b.dataset.move)
      push({ move: { stall: S.stall.id, spot, max_fee: S.cfg.spots[spot].fee } })
      U.closeSheet()
      U.toast(`Moving to ${L.spotLabel(spot)}. ${100 - 3 * spot}% of villagers walk this far.`, 'ok')
      scene.focusStall(S.stall.id)
    }),
  )
  body.querySelector('[data-list]')?.addEventListener('click', () => {
    const price = Math.floor(Number(body.querySelector('#list-price').value))
    if (!(price > 0)) return U.toast('Give an asking price above 0.', 'warn')
    push({ list: { stall: S.stall.id, price } })
    U.closeSheet()
    U.toast(`Listed for ${L.fmt(price)} coin. Other players see the sign on your stall.`, 'ok')
  })
  body.querySelector('[data-unlist]')?.addEventListener('click', () => {
    push({ unlist: { stall: S.stall.id } })
    U.closeSheet()
    U.toast('Listing withdrawn.', 'ok')
  })
  body.querySelector('[data-rename]')?.addEventListener('click', () => {
    const name = L.cleanName(body.querySelector('#rename-input').value)
    if (!L.validName(name)) return U.toast('Names take letters, digits, spaces, - and \', up to 24.', 'warn')
    if (name === S.stall.name) return
    push({ rename: { stall: S.stall.id, name } })
    U.closeSheet()
  })
}

function freeSpotsAhead() {
  const taken = new Set(S.world.row.map((s) => s.spot))
  const mine = S.stall.spot ?? 24
  const out = []
  for (let spot = mine - 1; spot >= 0; spot--) if (!taken.has(spot)) out.push({ spot, fee: S.cfg.spots[spot].fee })
  // nearest first, but also show the best one we can afford
  const affordable = out.filter((s) => s.fee <= S.stall.money)
  const best = affordable.length ? affordable[affordable.length - 1] : null
  const list = out.slice(0, 2)
  if (best && !list.includes(best)) list.push(best)
  return list
}

async function openBoard() {
  sound.tap()
  U.openSheet('Leaderboard', '<p class="muted">Fetching the ranks…</p>')
  try {
    const board = await client.leaderboard(120)
    setBoard(board)
    U.openSheet('Leaderboard', U.boardHtml(board, S.stall.id))
  } catch {
    U.openSheet('Leaderboard', '<p>The ranks are out of reach right now.</p>')
  }
}

function openProof() {
  sound.tap()
  U.openSheet(
    'On-chain proof',
    U.proofHtml({ contract: CONTRACT, account: S.identity?.account ?? '–', stallId: S.stall?.id, rpcHost: client.rpc.host, gasKey: client.pool.lastKey, txs: client.txs, codeHash: CODE_HASH, explorer: EXPLORER }),
  )
  // the two claims a judge cares about, read from the chain now, not printed from memory
  client
    .contractFacts()
    .then((f) => U.renderProofFacts(L.proofFacts({ ...f, expected: CODE_HASH })))
    .catch(() => U.renderProofFacts(L.proofFacts({ keyCount: null, codeHashHex: null })))
}

function onTapStall(id, e) {
  U.hidePeek()
  if (id == null) return
  const stall = S.world.row.find((s) => s.id === id)
  if (!stall) return
  sound.tap()
  const mine = !!S.identity && stall.owner === S.identity.account
  const canBuy = !mine && stall.listed != null && S.stall && S.stall.earned >= stall.listed
  U.showPeek(stall, S.cfg, {
    x: e.clientX,
    y: e.clientY,
    mine,
    canBuy,
    onBuy: () => {
      push({ buy_stall: { with: S.stall.id, target: stall.id, max_price: stall.listed, min_money: 0 } })
      U.hidePeek()
      U.toast(`Buying ${stall.name} for ${L.fmt(stall.listed)}. Its coin and goods come with it.`, 'ok')
    },
  })
}

// ---- render -------------------------------------------------------------------------------------

function renderAll() {
  if (!S.started || !S.stall) return
  renderHud()
  renderGoods()
  const plan = restockPlan()
  const skip = S.skipGood && S.skipGood.night === S.world.night ? S.skipGood.good : null
  U.$('restock-sub').textContent = plan.items.length ? `${L.listWords(plan.items.map((i) => `${i.qty} ${L.GOOD_SHORT[i.good].toLowerCase()}`))} · ${L.fmt(plan.total)}` : skip != null ? `waiting on cheap ${S.cfg.goods[skip].name}` : 'counter is full'
  U.$('btn-restock').disabled = S.stall.listed != null
}

function renderHud() {
  if (!S.stall) return
  checkMilestones()
  U.renderHud({ stall: S.stall, goal: L.goalProgress(S.stall.worth, S.goals), standing: S.standing })
}

// ---- goals --------------------------------------------------------------------------------------

const goalKey = (stall) => `lantern-row:goal:v1:${stall.id}`

/** The highest milestone this stall already passed; on a first visit, whatever its worth already is. */
function loadGoal(stall) {
  const stored = Number(globalThis.localStorage?.getItem(goalKey(stall)))
  if (stored > 0) return stored
  return [...S.goals].reverse().find((m) => m.at <= stall.worth)?.at ?? 0
}

function checkMilestones() {
  if (S.goalReached == null || S.stall?.worth == null) return
  const passed = L.crossedMilestones(S.goalReached, S.stall.worth, S.goals)
  if (!passed.length) return
  const m = passed[passed.length - 1]
  S.goalReached = m.at
  globalThis.localStorage?.setItem(goalKey(S.stall), String(m.at))
  U.toast(L.milestoneText(m, S.cfg), 'ok', 6000)
  sound.fanfare()
  scene.celebrate((S.stall.spot ?? 0) * 210)
}

function onCard(g) {
  const card = U.$('goods').children[g]
  const good = S.cfg.goods[g]
  U.toast(`${card?.dataset.full ?? good.name} Fair price ${good.fair}; spoils ${good.spoil_pct}% a night.`, '', 6000)
}

// ---- watching the row ---------------------------------------------------------------------------

/** "Too dear!" gets a reason in a few words, worked out the way the contract decides. */
function reasonsFor(log, world) {
  return (villager, stall, good) => L.refusalWords(L.refusalReason({ log, world, cfg: S.cfg, villager, stall, good }))
}

function startReplay() {
  if (W.on) return
  W.on = true
  const token = ++W.token
  scene.follow = true
  if (S.world?.last) W.logs.set(S.world.last.night, S.world.last)
  W.cycle = [...W.logs.keys()].sort((a, b) => a - b)
  W.next = W.cycle.length - 1 // the latest night first
  renderTicker()
  loadOlderLogs(token)
  schedulePollTitle()
  ;(async () => {
    while (W.on && W.token === token) {
      const night = W.cycle[W.next % Math.max(1, W.cycle.length)]
      const log = W.logs.get(night)
      W.next = (W.next + 1) % Math.max(1, W.cycle.length)
      if (!log) {
        await sleep(2000)
        continue
      }
      U.$('watch-line').textContent = `Replaying night ${L.fmt(log.night)} from the chain · tap a stall to see its prices`
      await scene.playNight(log, { duration: reduced ? 6 : 16, reasonFor: reasonsFor(log, S.world) })
      if (!W.on || W.token !== token) break
      await sleep(1200)
    }
  })()
}

/** The contract keeps the last six night logs; fetch the ones before the latest for the replay. */
async function loadOlderLogs(token) {
  const latest = S.world?.last?.night
  if (latest == null) return
  for (let n = latest - 1; n > latest - (S.cfg.log_keep ?? 6) && n >= 0; n--) {
    if (W.token !== token) return
    if (W.logs.has(n)) continue
    try {
      const log = await client.nightLog(n)
      if (log?.night === n) W.logs.set(n, log)
    } catch {
      break
    }
  }
  if (W.token !== token) return
  W.cycle = [...W.logs.keys()].sort((a, b) => a - b)
  renderTicker()
}

function renderTicker() {
  const nights = [...W.logs.values()]
    .sort((a, b) => b.night - a.night)
    .map((log) => ({ tally: L.nightTally(log), items: L.tickerItems(log, { world: S.world, cfg: S.cfg }) }))
  U.renderTicker(nights, { reduced })
}

/** While nobody plays, the title still follows the chain: a night someone else closed shows up here. */
function schedulePollTitle() {
  clearTimeout(W.pollTimer)
  W.pollTimer = setTimeout(pollTitle, 15000)
}

async function pollTitle() {
  if (!W.on) return
  try {
    const world = await client.world()
    if (world.night !== S.world.night) {
      applyWorld(world)
      scene.setWorld(world, S.cfg)
      U.$('title-line').textContent = L.titleLine(world, S.cfg)
      if (world.last) W.logs.set(world.last.night, world.last)
      for (const n of [...W.logs.keys()].sort((a, b) => a - b).slice(0, -(S.cfg.log_keep ?? 6))) W.logs.delete(n)
      W.cycle = [...W.logs.keys()].sort((a, b) => a - b)
      W.next = W.cycle.length - 1
      renderTicker()
    } else applyWorld(world)
    U.setIdle(L.idleNotice(world, S.cfg))
  } catch {
    /* try again later */
  }
  schedulePollTitle()
}

function stopReplay() {
  W.on = false
  W.token++
  clearTimeout(W.pollTimer)
  scene.follow = false
  scene.stopWalk()
  U.$('ticker').classList.add('hidden')
}

/** "Watch the row": the title steps aside so the whole street shows; stalls can be tapped. */
function setWatching(on) {
  W.watching = on
  U.$('title').classList.toggle('hidden', on)
  U.$('watchbar').classList.toggle('hidden', !on)
  U.hidePeek()
  scene.zoom = on ? (window.innerWidth < 720 ? 1.4 : 1.3) : 1
  scene.resize()
  if (on) {
    sound.tap()
    U.toast('Tap any stall to see its prices and why. Drag to look along the row.', '', 5000)
  } else {
    U.$('stall-name').focus?.()
  }
}

/** The deed card's picture: the stall on the row at night, drawn by the same scene as the street. */
function drawDeedScene(canvas, stall) {
  if (!canvas) return
  try {
    const mini = new Scene(canvas, { reducedMotion: true, fit: 240 })
    const view = { ...stall, spot: stall.spot ?? 23 }
    mini.setWorld({ row: [view], villagers: [], event: S.world.event, listings: stall.listed != null ? [[stall.id, stall.listed]] : [] }, S.cfg)
    mini.focusStall(stall.id, { instant: true })
    mini.update(0)
    mini.draw()
  } catch (e) {
    console.info('deed picture', e?.message)
  }
}

function renderGoods() {
  const reasons = S.fc ? L.suggestPrices(S.world, S.cfg, S.stall, S.fc) : null
  U.renderGoods(S.stall, { cfg: S.cfg, world: S.world, pendingGoods: S.pendingGoods, fc: S.fc, reasons })
}

function tutorial() {
  if (S.walking || U.summaryVisible()) return U.hideHint()
  const step = L.tutorialStep(S.progress)
  if (!step) return U.hideHint()
  U.showHint(typeof step.text === 'function' ? step.text(S.progress) : step.text)
}

// Expose a little for the end-to-end test; it reads, never writes.
globalThis.__lantern = { state: S, client }

boot()

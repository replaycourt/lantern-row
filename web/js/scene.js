// The street, drawn in Canvas 2D. Everything here is original art made of paths and gradients:
// sky, rooftops, lamp posts, stalls, villagers, coins, rain, fireworks. The scene knows nothing about
// the chain; it is fed a world view and a night log and plays them.
import { buildWalk, bubbleText, stallHue } from './logic.js'

export const SPOT_W = 210 // world units between spots; spot 0 is at x = 0, near the town gate on the left
const SPOTS = 24
const FONT = 'ui-rounded, "SF Pro Rounded", "Nunito", "Trebuchet MS", "Segoe UI", system-ui, sans-serif'

const VILLAGER_COLORS = ['#d9643a', '#4f8fc0', '#c94f7c', '#5aa469', '#e0a33b', '#8e6bc8', '#3fb2a3', '#c76f3b', '#6c8ed6', '#b35d9a', '#79a84a', '#d6485c']
// Hat by trade: see drawVillager. 0 bare, 1 cap, 2 straw hat, 3 scarf, 4 veil, 5 tall hat, 6 hood, 7 bun
const HATS = { 'dock hand': 1, lamplighter: 1, seamstress: 7, fisher: 2, apothecary: 6, 'bride-to-be': 4, 'night watchman': 1, teacher: 7, 'card player': 5, porter: 2, 'shrine keeper': 6, heir: 5 }

function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1
  for (let i = 0; i < 4; i++) {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
  }
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const lerp = (a, b, t) => a + (b - a) * t
const easeOut = (t) => 1 - Math.pow(1 - t, 3)

export class Scene {
  constructor(canvas, { reducedMotion = false } = {}) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.reduced = reducedMotion
    this.W = 0
    this.H = 0
    this.dpr = 1
    this.bottomInset = 0
    this.topInset = 0
    this.cam = { x: 6 * SPOT_W, target: 6 * SPOT_W, scale: 1 }
    this.t = 0
    this.last = 0
    this.stalls = []
    this.stallById = new Map()
    this.playerStall = null
    this.event = { kind: 'quiet', good: null }
    this.villagersInfo = []
    this.actors = []
    this.strollers = [] // ambient villagers on the title screen
    this.coins = []
    this.floats = []
    this.sparks = []
    this.skyLanterns = []
    this.rain = []
    this.flash = 0
    this.nextFirework = 0
    this.nextLightning = 4
    this.title = false
    this.walk = null
    this.onCoin = null
    this.onBubble = null
    this.running = false
    this.drag = null
    this.houses = this.makeHouses()
    this.stars = Array.from({ length: 140 }, (_, i) => {
      const r = rng(1000 + i)
      return { x: r(), y: r() * 0.55, s: 0.6 + r() * 1.4, p: r() * 6.28 }
    })
    for (let i = 0; i < 26; i++) this.skyLanterns.push(this.newSkyLantern(true))
    this.resize()
    this.bindPointer()
  }

  // ---- layout -----------------------------------------------------------------------------------

  resize() {
    const r = this.canvas.getBoundingClientRect()
    this.W = Math.max(1, r.width)
    this.H = Math.max(1, r.height)
    this.dpr = Math.min(2, globalThis.devicePixelRatio || 1)
    this.canvas.width = Math.round(this.W * this.dpr)
    this.canvas.height = Math.round(this.H * this.dpr)
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.cam.scale = clamp(this.W / 1500, 0.6, 1.15)
    if (this.H < 560) this.cam.scale = Math.min(this.cam.scale, this.H / 640)
  }

  setInsets({ top = 0, bottom = 0 }) {
    this.topInset = top
    this.bottomInset = bottom
  }

  get groundY() {
    return this.H - this.bottomInset - 24 * this.cam.scale
  }
  get horizonY() {
    return clamp(this.groundY - 230 * this.cam.scale, this.H * 0.3, this.H * 0.8)
  }

  sx(x) {
    return (x - this.cam.x) * this.cam.scale + this.W / 2
  }
  sy(y) {
    return this.groundY + y * this.cam.scale
  }

  // ---- world ------------------------------------------------------------------------------------

  setWorld(world, cfg) {
    this.cfg = cfg
    this.villagersInfo = world.villagers ?? []
    const ev = world.event
    this.event = typeof ev === 'string' ? { kind: ev, good: null } : ev ? { kind: Object.keys(ev)[0], good: Object.values(ev)[0].good } : { kind: 'quiet', good: null }
    const prev = this.stallById
    this.stalls = (world.row ?? [])
      .filter((s) => s.spot != null)
      .map((s) => {
        const old = prev.get(s.id)
        return {
          id: s.id,
          spot: s.spot,
          name: s.name,
          tier: s.tier,
          npc: s.npc,
          hue: stallHue(s.id),
          stock: s.stock,
          price: s.price,
          rep: s.rep,
          listed: s.listed,
          owner: s.owner,
          money: old?.money ?? s.money,
          glow: old?.glow ?? 0,
          pop: old?.pop ?? 0,
        }
      })
    this.stallById = new Map(this.stalls.map((s) => [s.id, s]))
    if (this.playerStall != null && !this.stallById.has(this.playerStall)) {
      // the player's stall may be off the row: show it floating at the end so it exists on screen
      const mine = (world.row ?? []).find((s) => s.id === this.playerStall)
      if (mine) this.stalls.push({ ...mine, spot: SPOTS + 1, hue: stallHue(mine.id), glow: 0, pop: 0 })
    }
    if (world.listings) for (const [id, price] of world.listings) if (this.stallById.has(id)) this.stallById.get(id).listed = price
  }

  setPlayer(id) {
    this.playerStall = id
  }

  updateStall(view) {
    const s = this.stallById.get(view.id)
    if (!s) return
    Object.assign(s, { name: view.name, tier: view.tier, stock: view.stock, price: view.price, money: view.money, listed: view.listed, rep: view.rep })
    s.pop = 1
  }

  focusStall(id, { instant = false } = {}) {
    const s = this.stallById.get(id)
    if (!s) return
    this.cam.target = s.spot * SPOT_W
    if (instant) this.cam.x = this.cam.target
  }

  setTitle(on) {
    this.title = on
  }

  hitTest(px, py) {
    for (const s of this.stalls) {
      const w = (150 + s.tier * 18) * this.cam.scale
      const x = this.sx(s.spot * SPOT_W)
      const top = this.sy(-150 - s.tier * 10)
      if (px > x - w / 2 && px < x + w / 2 && py > top && py < this.sy(8)) return s.id
    }
    return null
  }

  bindPointer() {
    const c = this.canvas
    c.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, camX: this.cam.x, moved: false, id: e.pointerId }
      c.setPointerCapture?.(e.pointerId)
    })
    c.addEventListener('pointermove', (e) => {
      if (!this.drag || this.drag.id !== e.pointerId) return
      const dx = e.clientX - this.drag.x
      if (Math.abs(dx) > 4) this.drag.moved = true
      if (this.drag.moved) {
        this.cam.x = this.drag.camX - dx / this.cam.scale
        this.cam.target = this.cam.x
      }
    })
    const up = (e) => {
      if (!this.drag) return
      const d = this.drag
      this.drag = null
      if (!d.moved) {
        const r = c.getBoundingClientRect()
        const id = this.hitTest(e.clientX - r.left, e.clientY - r.top)
        this.onTap?.(id, e)
      }
    }
    c.addEventListener('pointerup', up)
    c.addEventListener('pointercancel', () => (this.drag = null))
  }

  // ---- the walk ---------------------------------------------------------------------------------

  /** Plays a night log. Resolves when the last villager has left. */
  playNight(log, { duration = 11 } = {}) {
    const scripts = buildWalk(log)
    const n = Math.max(1, scripts.length)
    const stagger = Math.min(0.75, Math.max(0.25, (duration - 5) / n))
    const rand = rng(log.night * 7919 + 13)
    this.actors = []
    let end = 0
    scripts.forEach((sc, i) => {
      const info = this.villagersInfo[sc.villager] ?? { name: `Villager ${sc.villager}`, trade: '' }
      const stops = sc.stops.filter((st) => this.stallById.has(st.stall) || st.stall === this.playerStall)
      const start = i * stagger
      const first = stops.length ? this.stallById.get(stops[0].stall) : null
      const startX = (first ? first.spot * SPOT_W : this.cam.x) - (420 + rand() * 300)
      const lane = -2 + ((sc.villager * 37) % 5) * 6 // depth lane, so villagers do not overlap exactly
      const actor = {
        id: sc.villager,
        name: info.name,
        color: VILLAGER_COLORS[sc.villager % VILLAGER_COLORS.length],
        hat: HATS[info.trade] ?? 0,
        trade: info.trade,
        x: startX,
        y: lane,
        dir: 1,
        start,
        steps: [],
        bubble: null,
        done: false,
        phase: rand() * 6.28,
        t0: 0,
        visible: false,
        walking: false,
      }
      // Precompute the timeline: walk to each stop, dwell, then leave to the right.
      let t = start
      let totalDist = 0
      let px = startX
      for (const st of stops) {
        const tx = this.stallById.get(st.stall).spot * SPOT_W + (rand() - 0.5) * 50
        totalDist += Math.abs(tx - px)
        px = tx
      }
      totalDist += 520
      const dwellTotal = stops.length * 1.0 + (sc.missed.length ? 1.0 : 0)
      const budget = Math.max(3.2, duration - 1.5 - start)
      const speed = Math.max(220, totalDist / Math.max(0.8, budget - dwellTotal))
      px = startX
      for (const st of stops) {
        const tx = this.stallById.get(st.stall).spot * SPOT_W + (rand() - 0.5) * 50
        const d = Math.abs(tx - px) / speed
        actor.steps.push({ kind: 'walk', from: px, to: tx, t0: t, t1: t + d })
        t += d
        actor.steps.push({ kind: st.kind, stall: st.stall, good: st.good, price: st.price, t0: t, t1: t + 1.0, text: bubbleText(st.kind, st.good, rand), fired: false })
        t += 1.0
        px = tx
      }
      if (sc.missed.length) {
        const tx = px + 90
        actor.steps.push({ kind: 'walk', from: px, to: tx, t0: t, t1: t + 90 / speed })
        t += 90 / speed
        actor.steps.push({ kind: 'miss', good: sc.missed[0], t0: t, t1: t + 1.0, text: bubbleText('miss', sc.missed[0], rand), fired: false })
        t += 1.0
        px = tx
      }
      const exitX = px + 520
      actor.steps.push({ kind: 'walk', from: px, to: exitX, t0: t, t1: t + 520 / speed, leaving: true })
      t += 520 / speed
      actor.end = t
      end = Math.max(end, t)
      this.actors.push(actor)
    })
    this.walk = { t: 0, end: end + 0.3, log }
    return new Promise((resolve) => (this.walk.resolve = resolve))
  }

  stepWalk(dt) {
    const w = this.walk
    if (!w) return
    w.t += dt
    for (const a of this.actors) {
      if (w.t < a.start) continue
      a.visible = true
      let cur = a.steps.find((s) => w.t >= s.t0 && w.t < s.t1)
      if (!cur) {
        if (w.t >= a.end) a.visible = false
        cur = a.steps[a.steps.length - 1]
        if (cur.kind === 'walk') a.x = cur.to
        a.walking = false
        continue
      }
      if (cur.kind === 'walk') {
        const p = (w.t - cur.t0) / Math.max(0.001, cur.t1 - cur.t0)
        a.x = this.reduced ? cur.to : lerp(cur.from, cur.to, p)
        a.dir = cur.to >= cur.from ? 1 : -1
        a.walking = !this.reduced
        a.bubble = null
      } else {
        a.walking = false
        a.dir = 1
        if (!cur.fired) {
          cur.fired = true
          a.bubble = { text: cur.text, kind: cur.kind, until: cur.t1 + 0.2 }
          if (cur.kind === 'buy') this.spawnCoin(a, cur.stall, cur.price)
          this.onBubble?.(cur, a)
        }
      }
    }
    if (w.t >= w.end) {
      const resolve = w.resolve
      this.walk = null
      this.actors = []
      resolve?.()
    }
  }

  /** On the title screen, a few villagers stroll past so the street never looks dead. */
  stepStrollers(dt) {
    if (this.reduced || this.walk) {
      this.strollers = []
      return
    }
    const half = this.W / 2 / this.cam.scale + 120
    while (this.strollers.length < (this.title ? 4 : 2)) {
      const id = Math.floor(Math.random() * 12)
      const info = this.villagersInfo[id] ?? { name: '', trade: '' }
      const dir = Math.random() < 0.7 ? 1 : -1
      this.strollers.push({
        id,
        name: info.name,
        trade: info.trade,
        color: VILLAGER_COLORS[id % VILLAGER_COLORS.length],
        hat: HATS[info.trade] ?? 0,
        x: this.cam.x + (dir > 0 ? -half - Math.random() * 400 : half + Math.random() * 400),
        y: -4 + Math.random() * 24,
        dir,
        speed: 70 + Math.random() * 50,
        phase: Math.random() * 6.28,
        walking: true,
        visible: true,
        bubble: null,
      })
    }
    for (const s of this.strollers) s.x += s.dir * s.speed * dt
    this.strollers = this.strollers.filter((s) => Math.abs(s.x - this.cam.x) < half + 500)
  }

  spawnCoin(actor, stallId, price) {
    const s = this.stallById.get(stallId)
    if (!s) return
    const n = 1 + Math.min(3, Math.floor(price / 120))
    for (let i = 0; i < n; i++) {
      this.coins.push({ x0: actor.x, y0: actor.y - 30, x1: s.spot * SPOT_W + (i - n / 2) * 10, y1: -62 - s.tier * 4, t: -i * 0.08, dur: 0.55, stall: stallId, price: i === 0 ? price : 0 })
    }
    s.glow = 1
  }

  celebrate(x) {
    for (let i = 0; i < 3; i++) setTimeout(() => this.firework(x ?? this.cam.x + (Math.random() - 0.5) * 600), i * 250)
  }

  firework(x) {
    const hue = [40, 350, 190, 280, 100][Math.floor(Math.random() * 5)]
    const sx = this.sx(x)
    const sy = this.H * (0.12 + Math.random() * 0.25)
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2 + Math.random() * 0.1
      const v = 60 + Math.random() * 90
      this.sparks.push({ x: sx, y: sy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1.1 + Math.random() * 0.3, hue })
    }
  }

  newSkyLantern(anywhere) {
    const r = Math.random
    return { x: r(), y: anywhere ? r() * 0.6 : 0.62 + r() * 0.1, v: 0.012 + r() * 0.02, s: 2 + r() * 2.5, p: r() * 6.28, hue: 20 + r() * 25 }
  }

  // ---- loop -------------------------------------------------------------------------------------

  start() {
    if (this.running) return
    this.running = true
    this.last = performance.now()
    const frame = (now) => {
      if (!this.running) return
      const dt = Math.min(0.05, (now - this.last) / 1000)
      this.last = now
      this.update(dt)
      this.draw()
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }

  stop() {
    this.running = false
  }

  update(dt) {
    this.t += dt
    if (this.title && !this.drag) this.cam.target += dt * 18
    if (!this.drag) this.cam.x = lerp(this.cam.x, this.cam.target, Math.min(1, dt * 4))
    this.stepWalk(dt)
    this.stepStrollers(dt)
    for (const c of this.coins) c.t += dt / c.dur
    for (const c of this.coins) {
      if (c.t >= 1 && !c.done) {
        c.done = true
        const s = this.stallById.get(c.stall)
        if (s) {
          s.pop = 1
          if (c.price) {
            this.floats.push({ x: s.spot * SPOT_W, y: -150 - s.tier * 10, text: `+${c.price}`, life: 1.3, color: '#ffd36b' })
            this.onCoin?.(c.stall, c.price)
          }
        }
      }
    }
    this.coins = this.coins.filter((c) => c.t < 1.05)
    for (const f of this.floats) {
      f.life -= dt
      f.y -= dt * 28
    }
    this.floats = this.floats.filter((f) => f.life > 0)
    for (const s of this.stalls) {
      s.glow = Math.max(0, s.glow - dt * 1.4)
      s.pop = Math.max(0, s.pop - dt * 2.2)
    }
    for (const sp of this.sparks) {
      sp.life -= dt
      sp.x += sp.vx * dt
      sp.y += sp.vy * dt
      sp.vy += 70 * dt
      sp.vx *= 0.985
    }
    this.sparks = this.sparks.filter((s) => s.life > 0)
    if (!this.reduced) {
      for (const l of this.skyLanterns) {
        l.y -= l.v * dt
        l.x += Math.sin(this.t * 0.4 + l.p) * 0.00012
        if (l.y < -0.05) Object.assign(l, this.newSkyLantern(false))
      }
    }
    if (this.event.kind === 'festival' && this.t > this.nextFirework) {
      this.firework(this.cam.x + (Math.random() - 0.5) * 700)
      this.nextFirework = this.t + (this.reduced ? 6 : 1.6 + Math.random() * 2.2)
    }
    if (this.event.kind === 'storm') {
      if (!this.rain.length) for (let i = 0; i < 170; i++) this.rain.push({ x: Math.random(), y: Math.random(), v: 0.9 + Math.random() * 0.5 })
      if (!this.reduced) {
        for (const r of this.rain) {
          r.y += r.v * dt
          r.x -= dt * 0.08
          if (r.y > 1) {
            r.y = -0.05
            r.x = Math.random() * 1.1
          }
        }
        if (this.t > this.nextLightning) {
          this.flash = 1
          this.nextLightning = this.t + 7 + Math.random() * 8
        }
      }
    } else this.rain.length = 0
    this.flash = Math.max(0, this.flash - dt * 6)
  }

  // ---- drawing ----------------------------------------------------------------------------------

  draw() {
    const { ctx, W, H } = this
    const k = this.cam.scale
    ctx.clearRect(0, 0, W, H)
    this.drawSky()
    this.drawHouses(0.22, this.horizonY - 10 * k, 0, '#1a1740', '#2b2560')
    this.drawHouses(0.45, this.horizonY + 26 * k, 1, '#120f2e', '#1d1946')
    this.drawGround()
    this.drawLampPosts()
    if (this.event.kind === 'festival') this.drawBunting()
    this.drawGate()
    this.drawDock()
    for (const s of this.stalls) this.drawStall(s)
    for (const a of this.strollers) this.drawVillager(a)
    for (const a of this.actors) if (a.visible) this.drawVillager(a)
    this.drawCoins()
    for (const a of this.actors) if (a.visible && a.bubble && (!this.walk || this.walk.t < a.bubble.until)) this.drawBubble(a)
    this.drawFloats()
    this.drawSparks()
    if (this.event.kind === 'storm') this.drawRain()
    this.drawVignette()
  }

  drawSky() {
    const { ctx, W, H } = this
    const storm = this.event.kind === 'storm'
    const g = ctx.createLinearGradient(0, 0, 0, this.horizonY + 60)
    if (storm) {
      g.addColorStop(0, '#07071a')
      g.addColorStop(0.6, '#15132f')
      g.addColorStop(1, '#2a2240')
    } else {
      g.addColorStop(0, '#0a0b26')
      g.addColorStop(0.55, '#1c1a4e')
      g.addColorStop(1, '#4a2a52')
    }
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
    // stars
    const tw = this.reduced ? 0 : this.t
    for (const s of this.stars) {
      const a = 0.35 + 0.45 * Math.abs(Math.sin(tw * 0.9 + s.p))
      ctx.fillStyle = `rgba(255,240,220,${storm ? a * 0.3 : a})`
      ctx.fillRect(s.x * W, s.y * H, s.s, s.s)
    }
    // moon
    const mx = W * 0.82 - this.cam.x * 0.01
    const my = Math.min(H * 0.17, this.horizonY * 0.4)
    const mr = 26 * Math.max(0.7, this.cam.scale)
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    const mg = ctx.createRadialGradient(mx, my, mr * 0.6, mx, my, mr * 4)
    mg.addColorStop(0, 'rgba(255,236,190,0.35)')
    mg.addColorStop(0.3, 'rgba(255,236,190,0.1)')
    mg.addColorStop(0.7, 'rgba(255,236,190,0.015)')
    mg.addColorStop(0.9, 'rgba(255,236,190,0)')
    mg.addColorStop(1, 'rgba(255,236,190,0)')
    ctx.fillStyle = mg
    ctx.fillRect(mx - mr * 4, my - mr * 4, mr * 8, mr * 8)
    ctx.restore()
    ctx.fillStyle = storm ? '#c9c3b6' : '#fff1c9'
    ctx.beginPath()
    ctx.arc(mx, my, mr, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = storm ? '#15132f' : '#1c1a4e'
    ctx.beginPath()
    ctx.arc(mx - mr * 0.42, my - mr * 0.18, mr * 0.86, 0, Math.PI * 2)
    ctx.fill()
    // sky lanterns
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (const l of this.skyLanterns) {
      const x = l.x * W
      const y = l.y * this.horizonY
      const r = l.s * Math.max(0.7, this.cam.scale)
      const pulse = 0.7 + 0.3 * Math.sin(tw * 2 + l.p)
      const lg = ctx.createRadialGradient(x, y, 0, x, y, r * 5)
      lg.addColorStop(0, `hsla(${l.hue},100%,70%,${0.5 * pulse})`)
      lg.addColorStop(0.4, `hsla(${l.hue},100%,65%,${0.12 * pulse})`)
      lg.addColorStop(0.85, `hsla(${l.hue},100%,60%,0)`)
      lg.addColorStop(1, `hsla(${l.hue},100%,60%,0)`)
      ctx.fillStyle = lg
      ctx.fillRect(x - r * 5, y - r * 5, r * 10, r * 10)
      ctx.fillStyle = `hsla(${l.hue},100%,80%,${0.9 * pulse})`
      ctx.fillRect(x - r / 2, y - r / 2, r, r * 1.3)
    }
    ctx.restore()
    if (this.flash > 0) {
      ctx.fillStyle = `rgba(220,225,255,${this.flash * 0.35})`
      ctx.fillRect(0, 0, W, H)
    }
  }

  makeHouses() {
    const layers = [[], []]
    for (let layer = 0; layer < 2; layer++) {
      const r = rng(77 + layer * 31)
      let x = -2600
      while (x < SPOTS * SPOT_W + 2600) {
        const w = 90 + r() * 120
        const h = (layer ? 110 : 70) + r() * (layer ? 110 : 90)
        const windows = []
        const cols = Math.max(1, Math.floor(w / 40))
        const rows = Math.max(1, Math.floor(h / 48))
        for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) if (r() < 0.45) windows.push([(i + 0.5) / cols, (j + 0.6) / (rows + 0.6)])
        layers[layer].push({ x, w, h, roof: r() < 0.6 ? 'pitch' : 'flat', pitch: 20 + r() * 30, windows })
        x += w + 6 + r() * 30
      }
    }
    return layers
  }

  drawHouses(parallax, baseY, layer, color, roofColor) {
    const { ctx, W } = this
    const k = this.cam.scale
    const camx = this.cam.x * parallax
    const warm = this.event.kind === 'storm' ? 'rgba(255,190,110,0.35)' : 'rgba(255,200,120,0.75)'
    for (const h of this.houses[layer]) {
      const x = (h.x - camx) * k + W / 2
      const w = h.w * k
      if (x + w < -20 || x > W + 20) continue
      const hh = h.h * k
      ctx.fillStyle = color
      ctx.fillRect(x, baseY - hh, w, hh + 60)
      ctx.fillStyle = roofColor
      ctx.beginPath()
      if (h.roof === 'pitch') {
        ctx.moveTo(x - 6 * k, baseY - hh + 2)
        ctx.lineTo(x + w / 2, baseY - hh - h.pitch * k)
        ctx.lineTo(x + w + 6 * k, baseY - hh + 2)
      } else {
        ctx.rect(x - 4 * k, baseY - hh - 6 * k, w + 8 * k, 8 * k)
      }
      ctx.fill()
      ctx.fillStyle = warm
      for (const [wx, wy] of h.windows) ctx.fillRect(x + wx * w - 3 * k, baseY - hh + wy * hh - 4 * k, 6 * k, 8 * k)
    }
  }

  drawGround() {
    const { ctx, W, H } = this
    const hy = this.horizonY
    const g = ctx.createLinearGradient(0, hy, 0, H)
    g.addColorStop(0, '#2b2043')
    g.addColorStop(0.5, '#241a39')
    g.addColorStop(1, '#17112a')
    ctx.fillStyle = g
    ctx.fillRect(0, hy, W, H - hy)
    // a low wall behind the stalls
    ctx.fillStyle = '#1e1636'
    ctx.fillRect(0, hy, W, 14 * this.cam.scale)
    // cobbles: faint arcs
    const k = this.cam.scale
    ctx.strokeStyle = 'rgba(255,220,180,0.05)'
    ctx.lineWidth = 1
    const off = ((this.cam.x * k) % (34 * k) + 34 * k) % (34 * k)
    for (let row = 0; row < 6; row++) {
      const y = this.groundY + 6 * k + row * 13 * k
      if (y > H) break
      for (let x = -off - (row % 2) * 17 * k; x < W + 40; x += 34 * k) {
        ctx.beginPath()
        ctx.arc(x, y, 14 * k, Math.PI, 0)
        ctx.stroke()
      }
    }
  }

  drawLampPosts() {
    const { ctx } = this
    const k = this.cam.scale
    const storm = this.event.kind === 'storm'
    for (let s = 0; s <= SPOTS; s++) {
      const wx = s * SPOT_W - SPOT_W / 2
      const x = this.sx(wx)
      if (x < -40 || x > this.W + 40) continue
      const base = this.sy(-6)
      const top = this.sy(-200)
      ctx.strokeStyle = '#2a2140'
      ctx.lineWidth = 4 * k
      ctx.beginPath()
      ctx.moveTo(x, base)
      ctx.lineTo(x, top)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(x, top)
      ctx.quadraticCurveTo(x + 14 * k, top, x + 18 * k, top + 10 * k)
      ctx.stroke()
      const sway = storm && !this.reduced ? Math.sin(this.t * 3 + s) * 3 * k : 0
      const lx = x + 18 * k + sway
      const ly = top + 18 * k
      this.lanternGlow(lx, ly, (storm ? 70 : 120) * k, storm ? 0.5 : 1.1)
      // a pool of light on the cobbles
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      const pool = ctx.createRadialGradient(lx, base, 0, lx, base, 90 * k)
      pool.addColorStop(0, `rgba(255,160,70,${storm ? 0.08 : 0.16})`)
      pool.addColorStop(0.5, `rgba(255,140,60,${storm ? 0.02 : 0.05})`)
      pool.addColorStop(0.9, 'rgba(255,120,40,0)')
      pool.addColorStop(1, 'rgba(255,120,40,0)')
      ctx.fillStyle = pool
      ctx.save()
      ctx.translate(lx, base)
      ctx.scale(1, 0.35)
      ctx.translate(-lx, -base)
      ctx.fillRect(lx - 90 * k, base - 90 * k, 180 * k, 180 * k)
      ctx.restore()
      ctx.restore()
      ctx.fillStyle = '#3a2d1c'
      ctx.fillRect(lx - 5 * k, ly - 9 * k, 10 * k, 3 * k)
      ctx.fillStyle = '#ffd98a'
      ctx.beginPath()
      ctx.moveTo(lx - 5 * k, ly - 6 * k)
      ctx.lineTo(lx + 5 * k, ly - 6 * k)
      ctx.lineTo(lx + 3.5 * k, ly + 7 * k)
      ctx.lineTo(lx - 3.5 * k, ly + 7 * k)
      ctx.closePath()
      ctx.fill()
    }
  }

  drawBunting() {
    const { ctx } = this
    const k = this.cam.scale
    const colors = ['#ff6b6b', '#ffd166', '#06d6a0', '#8ecae6', '#f78fb3']
    for (let s = 0; s < SPOTS; s++) {
      const x0 = this.sx(s * SPOT_W - SPOT_W / 2)
      const x1 = this.sx((s + 1) * SPOT_W - SPOT_W / 2)
      if (x1 < -40 || x0 > this.W + 40) continue
      const y = this.sy(-200) + 14 * k
      ctx.strokeStyle = 'rgba(255,230,200,0.5)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x0, y)
      ctx.quadraticCurveTo((x0 + x1) / 2, y + 26 * k, x1, y)
      ctx.stroke()
      for (let i = 1; i <= 7; i++) {
        const p = i / 8
        const fx = lerp(x0, x1, p)
        const fy = y + 26 * k * 4 * p * (1 - p) * 0.5
        const sway = this.reduced ? 0 : Math.sin(this.t * 2.5 + i + s) * 2 * k
        ctx.fillStyle = colors[(i + s) % colors.length]
        ctx.beginPath()
        ctx.moveTo(fx - 6 * k, fy)
        ctx.lineTo(fx + 6 * k, fy)
        ctx.lineTo(fx + sway, fy + 13 * k)
        ctx.closePath()
        ctx.fill()
      }
    }
  }

  drawGate() {
    const { ctx } = this
    const k = this.cam.scale
    const x = this.sx(-SPOT_W * 1.1)
    if (x < -200 * k || x > this.W + 200 * k) return
    const base = this.sy(0)
    const top = this.sy(-230)
    ctx.fillStyle = '#5b1f22'
    ctx.fillRect(x - 70 * k, top + 20 * k, 12 * k, base - top - 20 * k)
    ctx.fillRect(x + 58 * k, top + 20 * k, 12 * k, base - top - 20 * k)
    ctx.beginPath()
    ctx.moveTo(x - 95 * k, top + 22 * k)
    ctx.quadraticCurveTo(x, top - 14 * k, x + 95 * k, top + 22 * k)
    ctx.lineTo(x + 95 * k, top + 34 * k)
    ctx.quadraticCurveTo(x, top, x - 95 * k, top + 34 * k)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#7a2a2e'
    ctx.fillRect(x - 80 * k, top + 46 * k, 160 * k, 8 * k)
    this.paperLantern(x - 40 * k, top + 72 * k, 11 * k, '#ff7b4a', 0.9)
    this.paperLantern(x + 40 * k, top + 72 * k, 11 * k, '#ff7b4a', 0.9)
    ctx.fillStyle = '#ffe2b0'
    ctx.font = `bold ${13 * k}px ${FONT}`
    ctx.textAlign = 'center'
    ctx.fillText('LANTERN ROW', x, top + 32 * k)
  }

  /** The Dock at the far end of the row: a shed, crates and a lantern. Villagers never go there; the Dock sells to stalls. */
  drawDock() {
    const { ctx } = this
    const k = this.cam.scale
    const x = this.sx(SPOTS * SPOT_W + 40)
    if (x < -260 * k || x > this.W + 260 * k) return
    const base = this.sy(0)
    const top = this.sy(-170)
    ctx.fillStyle = '#2a1f33'
    ctx.fillRect(x - 90 * k, top + 30 * k, 180 * k, base - top - 30 * k)
    ctx.fillStyle = '#3a2a40'
    ctx.beginPath()
    ctx.moveTo(x - 104 * k, top + 32 * k)
    ctx.lineTo(x, top - 12 * k)
    ctx.lineTo(x + 104 * k, top + 32 * k)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#1b1426'
    ctx.fillRect(x - 28 * k, base - 70 * k, 56 * k, 70 * k)
    this.paperLantern(x + 60 * k, top + 60 * k, 9 * k, '#ffb347', 0.9)
    // crates
    const crate = (cx, cy, s) => {
      ctx.fillStyle = '#7a5a33'
      ctx.fillRect(cx - s / 2, cy - s, s, s)
      ctx.strokeStyle = '#4a3620'
      ctx.lineWidth = Math.max(1, 1.5 * k)
      ctx.strokeRect(cx - s / 2, cy - s, s, s)
      ctx.beginPath()
      ctx.moveTo(cx - s / 2, cy - s)
      ctx.lineTo(cx + s / 2, cy)
      ctx.stroke()
    }
    crate(x - 70 * k, base, 26 * k)
    crate(x - 44 * k, base, 26 * k)
    crate(x - 57 * k, base - 26 * k, 26 * k)
    crate(x + 86 * k, base, 22 * k)
    ctx.fillStyle = '#f3dcb8'
    ctx.font = `bold ${12 * k}px ${FONT}`
    ctx.textAlign = 'center'
    ctx.fillText('THE DOCK', x, top + 24 * k)
  }

  lanternGlow(x, y, r, a) {
    const { ctx } = this
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, `rgba(255,170,70,${0.42 * a})`)
    g.addColorStop(0.35, `rgba(255,140,50,${0.16 * a})`)
    g.addColorStop(0.7, `rgba(255,120,40,${0.03 * a})`)
    g.addColorStop(0.9, 'rgba(255,120,40,0)')
    g.addColorStop(1, 'rgba(255,120,40,0)')
    ctx.fillStyle = g
    ctx.fillRect(x - r, y - r, r * 2, r * 2)
    ctx.restore()
  }

  paperLantern(x, y, r, color, bright, swing = 0) {
    const { ctx } = this
    ctx.save()
    ctx.translate(x, y - r)
    ctx.rotate(swing)
    ctx.translate(0, r)
    this.lanternGlow(0, 0, r * 7, bright)
    ctx.strokeStyle = '#3a2a1a'
    ctx.lineWidth = Math.max(1, r * 0.12)
    ctx.beginPath()
    ctx.moveTo(0, -r * 1.9)
    ctx.lineTo(0, -r * 1.2)
    ctx.stroke()
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.ellipse(0, 0, r * 0.85, r * 1.05, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = `rgba(255,235,170,${0.55 * bright})`
    ctx.beginPath()
    ctx.ellipse(-r * 0.15, -r * 0.1, r * 0.4, r * 0.6, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(80,30,20,0.35)'
    ctx.lineWidth = 1
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath()
      ctx.ellipse(0, 0, r * 0.85 * Math.abs(i ? 0.6 : 0.2) + 0.1, r * 1.05, 0, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.fillStyle = '#c99a3a'
    ctx.fillRect(-r * 0.45, -r * 1.25, r * 0.9, r * 0.25)
    ctx.fillRect(-r * 0.35, r * 1.0, r * 0.7, r * 0.22)
    ctx.strokeStyle = '#d6a447'
    ctx.beginPath()
    ctx.moveTo(0, r * 1.2)
    ctx.lineTo(0, r * 1.7)
    ctx.stroke()
    ctx.restore()
  }

  drawStall(s) {
    const { ctx } = this
    const k = this.cam.scale
    const cx = this.sx(s.spot * SPOT_W)
    const w = (150 + s.tier * 18) * k
    if (cx + w < -60 || cx - w > this.W + 60) return
    const isMe = s.id === this.playerStall
    const pop = 1 + s.pop * 0.03
    const ground = this.sy(0)
    const counterTop = this.sy(-58 - s.tier * 3)
    const awningY = this.sy(-128 - s.tier * 10)
    const storm = this.event.kind === 'storm'
    const h = s.hue
    const bright = clamp(0.55 + s.rep / 900, 0.55, 1.15) * (storm ? 0.6 : 1) + s.glow * 0.6
    ctx.save()
    ctx.translate(cx, ground)
    ctx.scale(pop, pop)
    ctx.translate(-cx, -ground)
    // posts
    ctx.fillStyle = '#3b2a22'
    ctx.fillRect(cx - w / 2 + 4 * k, awningY, 6 * k, ground - awningY)
    ctx.fillRect(cx + w / 2 - 10 * k, awningY, 6 * k, ground - awningY)
    // back cloth
    ctx.fillStyle = `hsla(${h},35%,22%,0.9)`
    ctx.fillRect(cx - w / 2 + 8 * k, awningY + 10 * k, w - 16 * k, counterTop - awningY - 10 * k)
    // keeper (behind the counter)
    this.drawKeeper(cx, counterTop, k, s, isMe)
    // counter
    ctx.fillStyle = '#6b4a2b'
    ctx.fillRect(cx - w / 2, counterTop, w, ground - counterTop)
    ctx.fillStyle = '#4a3220'
    ctx.fillRect(cx - w / 2, counterTop + 8 * k, w, 4 * k)
    ctx.fillStyle = '#8a6238'
    ctx.fillRect(cx - w / 2 - 3 * k, counterTop - 4 * k, w + 6 * k, 8 * k)
    // cloth hanging from the counter front
    ctx.fillStyle = `hsl(${h},45%,38%)`
    ctx.fillRect(cx - w / 2 + 6 * k, counterTop + 14 * k, w - 12 * k, ground - counterTop - 22 * k)
    ctx.fillStyle = `hsla(${h},50%,55%,0.5)`
    for (let i = 0; i < 3; i++) ctx.fillRect(cx - w / 2 + 6 * k + ((i + 0.5) * (w - 12 * k)) / 3 - 4 * k, counterTop + 14 * k, 8 * k, ground - counterTop - 22 * k)
    // goods on the counter
    this.drawGoods(cx, counterTop, w, k, s)
    // awning
    const aw = w + 16 * k
    ctx.fillStyle = `hsl(${h},55%,45%)`
    ctx.beginPath()
    ctx.moveTo(cx - aw / 2, awningY + 10 * k)
    ctx.lineTo(cx - aw / 2 + 12 * k, awningY - 22 * k)
    ctx.lineTo(cx + aw / 2 - 12 * k, awningY - 22 * k)
    ctx.lineTo(cx + aw / 2, awningY + 10 * k)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = `hsla(${h},70%,75%,0.55)`
    const stripes = 5
    for (let i = 0; i < stripes; i += 2) {
      const x0 = cx - aw / 2 + 12 * k + ((aw - 24 * k) * i) / stripes
      const x1 = cx - aw / 2 + 12 * k + ((aw - 24 * k) * (i + 1)) / stripes
      ctx.beginPath()
      ctx.moveTo(x0 - 2.5 * k, awningY + 10 * k)
      ctx.lineTo(x0, awningY - 22 * k)
      ctx.lineTo(x1, awningY - 22 * k)
      ctx.lineTo(x1 + 2.5 * k, awningY + 10 * k)
      ctx.closePath()
      ctx.fill()
    }
    // scallops
    ctx.fillStyle = `hsl(${h},55%,45%)`
    const n = Math.round(aw / (14 * k))
    for (let i = 0; i < n; i++) {
      ctx.beginPath()
      ctx.arc(cx - aw / 2 + ((i + 0.5) * aw) / n, awningY + 10 * k, (aw / n) * 0.5, 0, Math.PI)
      ctx.fill()
    }
    // sign
    const name = s.name.length > 18 ? s.name.slice(0, 17) + '…' : s.name
    ctx.font = `bold ${13 * k}px ${FONT}`
    ctx.textAlign = 'center'
    const tw = ctx.measureText(name).width + 18 * k
    const signY = awningY - 42 * k
    ctx.fillStyle = '#2b1d14'
    roundRect(ctx, cx - tw / 2, signY, tw, 20 * k, 5 * k)
    ctx.fill()
    ctx.fillStyle = isMe ? '#ffe08a' : '#f3dcb8'
    ctx.fillText(name, cx, signY + 14.5 * k)
    // lanterns hanging from the awning
    const lanterns = 1 + s.tier
    for (let i = 0; i < lanterns; i++) {
      const lx = cx + (lanterns === 1 ? 0 : lerp(-aw / 2 + 24 * k, aw / 2 - 24 * k, i / (lanterns - 1)))
      const swing = storm && !this.reduced ? Math.sin(this.t * 3.2 + i + s.id) * 0.18 : this.reduced ? 0 : Math.sin(this.t * 1.1 + i + s.id) * 0.03
      this.paperLantern(lx, awningY + 32 * k, 9 * k, isMe ? '#ff6a3d' : `hsl(${(h + 20) % 360},80%,58%)`, bright, swing)
    }
    // sold / listed tags
    if (s.listed) {
      ctx.fillStyle = '#f5f0e6'
      roundRect(ctx, cx + w / 2 - 44 * k, counterTop - 30 * k, 54 * k, 18 * k, 3 * k)
      ctx.fill()
      ctx.fillStyle = '#7a2a2e'
      ctx.font = `bold ${9.5 * k}px ${FONT}`
      ctx.fillText('FOR SALE', cx + w / 2 - 17 * k, counterTop - 17 * k)
    }
    if (isMe) {
      const by = awningY - 70 * k + Math.sin(this.t * 2.2) * 3 * k * (this.reduced ? 0 : 1)
      ctx.fillStyle = '#ffd36b'
      ctx.beginPath()
      ctx.moveTo(cx, by + 12 * k)
      ctx.lineTo(cx - 8 * k, by)
      ctx.lineTo(cx + 8 * k, by)
      ctx.closePath()
      ctx.fill()
      ctx.font = `bold ${10 * k}px ${FONT}`
      ctx.fillText('YOUR STALL', cx, by - 5 * k)
    }
    ctx.restore()
  }

  drawKeeper(cx, counterTop, k, s, isMe) {
    const { ctx } = this
    const y = counterTop + 6 * k
    const bob = this.reduced ? 0 : Math.sin(this.t * 1.6 + s.id) * 1.2 * k
    const color = isMe ? '#e9b44c' : `hsl(${(s.hue + 180) % 360},40%,55%)`
    ctx.fillStyle = color
    roundRect(ctx, cx - 11 * k, y - 26 * k + bob, 22 * k, 24 * k, 6 * k)
    ctx.fill()
    ctx.fillStyle = '#f1c9a5'
    ctx.beginPath()
    ctx.arc(cx, y - 34 * k + bob, 8.5 * k, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#2d1e1a'
    ctx.beginPath()
    ctx.arc(cx, y - 37 * k + bob, 8.5 * k, Math.PI, 0)
    ctx.fill()
    if (isMe) {
      ctx.fillStyle = '#fff6e5'
      ctx.fillRect(cx - 6 * k, y - 16 * k + bob, 12 * k, 12 * k)
    }
  }

  drawGoods(cx, top, w, k, s) {
    const { ctx } = this
    const slots = 5
    const sw = (w - 20 * k) / slots
    for (let g = 0; g < 5; g++) {
      const n = s.stock?.[g] ?? 0
      if (n <= 0) continue
      const x = cx - w / 2 + 10 * k + sw * (g + 0.5)
      const y = top - 2 * k
      const count = Math.min(3, Math.ceil(n / 4))
      if (g === 0) {
        for (let i = 0; i < count; i++) {
          ctx.fillStyle = '#6fbf9a'
          roundRect(ctx, x - 10 * k + i * 7 * k, y - 9 * k - i * 1.5 * k, 9 * k, 9 * k, 2 * k)
          ctx.fill()
          ctx.fillStyle = '#d7f3e3'
          ctx.fillRect(x - 9 * k + i * 7 * k, y - 10 * k - i * 1.5 * k, 7 * k, 2 * k)
        }
      } else if (g === 1) {
        for (let i = 0; i < count; i++) {
          ctx.fillStyle = '#f0a43a'
          roundRect(ctx, x - 9 * k + i * 6 * k, y - 14 * k, 6 * k, 14 * k, 2 * k)
          ctx.fill()
          ctx.fillStyle = '#5a3a1a'
          ctx.fillRect(x - 8 * k + i * 6 * k, y - 17 * k, 4 * k, 3 * k)
        }
      } else if (g === 2) {
        ctx.fillStyle = '#8c5a2b'
        ctx.beginPath()
        ctx.ellipse(x, y - 4 * k, 12 * k, 5 * k, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#fff3dd'
        for (let i = 0; i < Math.min(5, n); i++) {
          ctx.beginPath()
          ctx.arc(x - 7 * k + (i % 3) * 7 * k, y - 8 * k - Math.floor(i / 3) * 5 * k, 3.6 * k, 0, Math.PI * 2)
          ctx.fill()
        }
        if (!this.reduced) {
          ctx.strokeStyle = 'rgba(255,255,255,0.25)'
          ctx.lineWidth = 1
          for (let i = 0; i < 2; i++) {
            const ph = (this.t * 0.5 + i * 0.5 + s.id * 0.1) % 1
            ctx.beginPath()
            ctx.moveTo(x - 3 * k + i * 6 * k, y - 14 * k - ph * 14 * k)
            ctx.quadraticCurveTo(x + i * 6 * k, y - 18 * k - ph * 14 * k, x - 3 * k + i * 6 * k, y - 22 * k - ph * 14 * k)
            ctx.stroke()
          }
        }
      } else if (g === 3) {
        const cols = ['#c04a9c', '#7d4ec9', '#e07aa8']
        for (let i = 0; i < Math.min(3, n); i++) {
          ctx.fillStyle = cols[i]
          roundRect(ctx, x - 12 * k, y - 7 * k - i * 6 * k, 24 * k, 6 * k, 3 * k)
          ctx.fill()
        }
      } else {
        for (let i = 0; i < Math.min(3, n); i++) {
          const tx = x - 8 * k + i * 8 * k
          ctx.strokeStyle = '#d64545'
          ctx.lineWidth = 1.5 * k
          ctx.beginPath()
          ctx.moveTo(tx, y - 20 * k)
          ctx.lineTo(tx, y - 6 * k)
          ctx.stroke()
          ctx.fillStyle = '#ffd166'
          ctx.beginPath()
          ctx.arc(tx, y - 14 * k, 3 * k, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = '#d64545'
          ctx.fillRect(tx - 2 * k, y - 8 * k, 4 * k, 6 * k)
        }
      }
    }
  }

  drawVillager(a) {
    const { ctx } = this
    const k = this.cam.scale
    const x = this.sx(a.x)
    const y = this.sy(a.y)
    if (x < -60 || x > this.W + 60) return
    const bob = a.walking ? Math.abs(Math.sin(this.t * 11 + a.phase)) * 2.2 * k : 0
    const swing = a.walking ? Math.sin(this.t * 11 + a.phase) * 5 * k : 0
    ctx.save()
    ctx.translate(x, y)
    if (a.dir < 0) ctx.scale(-1, 1)
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)'
    ctx.beginPath()
    ctx.ellipse(0, 1 * k, 11 * k, 3 * k, 0, 0, Math.PI * 2)
    ctx.fill()
    // legs
    ctx.strokeStyle = '#2b2233'
    ctx.lineWidth = 3.2 * k
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(-3 * k, -12 * k - bob)
    ctx.lineTo(-3 * k + swing * 0.6, 0)
    ctx.moveTo(3 * k, -12 * k - bob)
    ctx.lineTo(3 * k - swing * 0.6, 0)
    ctx.stroke()
    // body
    ctx.fillStyle = a.color
    roundRect(ctx, -8 * k, -33 * k - bob, 16 * k, 23 * k, 5 * k)
    ctx.fill()
    // arm
    ctx.strokeStyle = a.color
    ctx.lineWidth = 3.4 * k
    ctx.beginPath()
    ctx.moveTo(5 * k, -28 * k - bob)
    ctx.lineTo(10 * k - swing * 0.4, -17 * k - bob)
    ctx.stroke()
    // head
    ctx.fillStyle = '#f2cba7'
    ctx.beginPath()
    ctx.arc(0, -41 * k - bob, 8 * k, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#2d1e1a'
    ctx.beginPath()
    ctx.arc(2.5 * k, -41.5 * k - bob, 1.1 * k, 0, Math.PI * 2)
    ctx.fill()
    // hair and hat
    const hy = -41 * k - bob
    ctx.fillStyle = '#3a2620'
    switch (a.hat) {
      case 1: // cap
        ctx.fillStyle = darker(a.color)
        ctx.beginPath()
        ctx.arc(0, hy - 2 * k, 8.4 * k, Math.PI, 0)
        ctx.fill()
        ctx.fillRect(-2 * k, hy - 3 * k, 12 * k, 2.4 * k)
        break
      case 2: // straw hat
        ctx.fillStyle = '#d9b36a'
        ctx.beginPath()
        ctx.moveTo(-14 * k, hy - 3 * k)
        ctx.lineTo(0, hy - 13 * k)
        ctx.lineTo(14 * k, hy - 3 * k)
        ctx.closePath()
        ctx.fill()
        break
      case 4: // veil
        ctx.fillStyle = 'rgba(255,255,255,0.75)'
        ctx.beginPath()
        ctx.moveTo(-9 * k, hy - 4 * k)
        ctx.quadraticCurveTo(0, hy - 14 * k, 9 * k, hy - 4 * k)
        ctx.lineTo(10 * k, hy + 14 * k)
        ctx.lineTo(-10 * k, hy + 14 * k)
        ctx.closePath()
        ctx.fill()
        break
      case 5: // tall hat
        ctx.fillStyle = '#1f1a2b'
        ctx.fillRect(-9 * k, hy - 7 * k, 18 * k, 2.5 * k)
        ctx.fillRect(-6 * k, hy - 18 * k, 12 * k, 12 * k)
        break
      case 6: // hood
        ctx.fillStyle = darker(a.color)
        ctx.beginPath()
        ctx.arc(0, hy - 1 * k, 9.5 * k, Math.PI * 0.9, Math.PI * 2.1)
        ctx.fill()
        break
      case 7: // hair bun
        ctx.beginPath()
        ctx.arc(0, hy - 3 * k, 8 * k, Math.PI, 0)
        ctx.fill()
        ctx.beginPath()
        ctx.arc(-6 * k, hy - 9 * k, 3.5 * k, 0, Math.PI * 2)
        ctx.fill()
        break
      default:
        ctx.beginPath()
        ctx.arc(0, hy - 2 * k, 8 * k, Math.PI, 0)
        ctx.fill()
    }
    if (a.trade === 'lamplighter' || a.trade === 'night watchman') {
      ctx.strokeStyle = '#6b4a2b'
      ctx.lineWidth = 1.5 * k
      ctx.beginPath()
      ctx.moveTo(10 * k, -17 * k - bob)
      ctx.lineTo(10 * k, -30 * k - bob)
      ctx.stroke()
      this.lanternGlow(10 * k, -14 * k - bob, 24 * k, 0.6)
      ctx.fillStyle = '#ffd98a'
      ctx.fillRect(7.5 * k, -17 * k - bob, 5 * k, 7 * k)
    }
    ctx.restore()
  }

  drawBubble(a) {
    const { ctx } = this
    const k = this.cam.scale
    const fs = Math.max(11, 12.5 * k)
    ctx.font = `bold ${fs}px ${FONT}`
    const text = a.bubble.text
    const tw = ctx.measureText(text).width
    const pw = tw + 16
    const ph = fs + 12
    let x = this.sx(a.x)
    const y = this.sy(a.y) - 56 * k
    x = clamp(x, pw / 2 + 6, this.W - pw / 2 - 6)
    const tailX = clamp(this.sx(a.x), x - pw / 2 + 10, x + pw / 2 - 10)
    const fill = a.bubble.kind === 'buy' ? '#fff7e6' : a.bubble.kind === 'refuse' ? '#ffe3e3' : '#e9e6f5'
    ctx.fillStyle = fill
    roundRect(ctx, x - pw / 2, y - ph, pw, ph, 8)
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(tailX - 5, y - 1)
    ctx.lineTo(tailX, y + 7)
    ctx.lineTo(tailX + 5, y - 1)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#2a1d2e'
    ctx.textAlign = 'center'
    ctx.fillText(text, x, y - ph / 2 + fs * 0.36)
  }

  drawCoins() {
    const { ctx } = this
    const k = this.cam.scale
    for (const c of this.coins) {
      if (c.t < 0) continue
      const p = easeOut(Math.min(1, c.t))
      const x = this.sx(lerp(c.x0, c.x1, p))
      const y = this.sy(lerp(c.y0, c.y1, p)) - Math.sin(p * Math.PI) * 60 * k
      const r = 4.5 * k
      ctx.fillStyle = '#f3b63a'
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#ffe28a'
      ctx.beginPath()
      ctx.arc(x - r * 0.25, y - r * 0.25, r * 0.5, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  drawFloats() {
    const { ctx } = this
    const k = this.cam.scale
    for (const f of this.floats) {
      ctx.globalAlpha = Math.min(1, f.life)
      ctx.font = `bold ${15 * k}px ${FONT}`
      ctx.textAlign = 'center'
      ctx.fillStyle = f.color
      ctx.fillText(f.text, this.sx(f.x), this.sy(f.y))
    }
    ctx.globalAlpha = 1
  }

  drawSparks() {
    const { ctx } = this
    if (!this.sparks.length) return
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (const s of this.sparks) {
      ctx.fillStyle = `hsla(${s.hue},100%,70%,${Math.min(1, s.life)})`
      ctx.fillRect(s.x, s.y, 2.5, 2.5)
    }
    ctx.restore()
  }

  drawRain() {
    const { ctx, W, H } = this
    ctx.strokeStyle = 'rgba(190,205,255,0.32)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const r of this.rain) {
      const x = r.x * W
      const y = r.y * H
      ctx.moveTo(x, y)
      ctx.lineTo(x - 3, y + 16)
    }
    ctx.stroke()
    ctx.fillStyle = 'rgba(10,10,30,0.18)'
    ctx.fillRect(0, 0, W, H)
  }

  drawVignette() {
    const { ctx, W, H } = this
    const g = ctx.createRadialGradient(W / 2, H * 0.55, H * 0.3, W / 2, H * 0.55, Math.max(W, H) * 0.8)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(1, 'rgba(5,3,15,0.55)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
  }
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function darker(hex) {
  const n = parseInt(hex.slice(1), 16)
  const r = Math.floor(((n >> 16) & 255) * 0.6)
  const g = Math.floor(((n >> 8) & 255) * 0.6)
  const b = Math.floor((n & 255) * 0.6)
  return `rgb(${r},${g},${b})`
}

/** The logo: "Lantern Row" with a paper lantern for the o. Drawn on its own canvas. */
export function drawLogo(canvas, { width = 520 } = {}) {
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
  const height = Math.round(width * 0.4)
  canvas.width = width * dpr
  canvas.height = height * dpr
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const fs = width * 0.15
  ctx.font = `800 ${fs}px ${FONT}`
  ctx.textBaseline = 'alphabetic'
  const parts = ['Lantern R', 'w']
  const lanternW = fs * 0.62
  const total = ctx.measureText(parts[0]).width + lanternW + ctx.measureText(parts[1]).width
  let x = (width - total) / 2
  const y = height * 0.72
  const grad = ctx.createLinearGradient(0, y - fs, 0, y)
  grad.addColorStop(0, '#fff1c2')
  grad.addColorStop(0.55, '#ffcf5a')
  grad.addColorStop(1, '#f0883b')
  ctx.save()
  ctx.shadowColor = 'rgba(255,160,60,0.65)'
  ctx.shadowBlur = fs * 0.35
  ctx.lineJoin = 'round'
  ctx.lineWidth = fs * 0.12
  ctx.strokeStyle = '#3b1b2a'
  ctx.strokeText(parts[0], x, y)
  ctx.strokeText(parts[1], x + ctx.measureText(parts[0]).width + lanternW, y)
  ctx.shadowBlur = 0
  ctx.fillStyle = grad
  ctx.fillText(parts[0], x, y)
  ctx.fillText(parts[1], x + ctx.measureText(parts[0]).width + lanternW, y)
  ctx.restore()
  // the lantern
  const lx = x + ctx.measureText(parts[0]).width + lanternW / 2
  const ly = y - fs * 0.36
  const r = fs * 0.27
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, r * 3.2)
  g.addColorStop(0, 'rgba(255,170,70,0.55)')
  g.addColorStop(1, 'rgba(255,120,40,0)')
  ctx.fillStyle = g
  ctx.fillRect(lx - r * 3.2, ly - r * 3.2, r * 6.4, r * 6.4)
  ctx.restore()
  ctx.strokeStyle = '#3b1b2a'
  ctx.lineWidth = fs * 0.05
  ctx.beginPath()
  ctx.moveTo(lx, ly - r * 1.75)
  ctx.lineTo(lx, ly - r * 1.3)
  ctx.stroke()
  ctx.fillStyle = '#e8503a'
  ctx.beginPath()
  ctx.ellipse(lx, ly, r * 0.88, r * 1.05, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = '#3b1b2a'
  ctx.lineWidth = fs * 0.045
  ctx.stroke()
  ctx.fillStyle = 'rgba(255,230,150,0.7)'
  ctx.beginPath()
  ctx.ellipse(lx - r * 0.18, ly - r * 0.1, r * 0.4, r * 0.62, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(80,20,20,0.35)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.ellipse(lx, ly, r * 0.45, r * 1.05, 0, 0, Math.PI * 2)
  ctx.stroke()
  ctx.fillStyle = '#f3c04d'
  ctx.fillRect(lx - r * 0.45, ly - r * 1.3, r * 0.9, r * 0.25)
  ctx.fillRect(lx - r * 0.35, ly + r * 1.02, r * 0.7, r * 0.22)
  ctx.strokeStyle = '#f3c04d'
  ctx.lineWidth = fs * 0.03
  ctx.beginPath()
  ctx.moveTo(lx, ly + r * 1.24)
  ctx.lineTo(lx, ly + r * 1.7)
  ctx.stroke()
  // tagline
  ctx.fillStyle = '#f6dcb0'
  ctx.font = `600 ${fs * 0.21}px ${FONT}`
  ctx.textAlign = 'center'
  ctx.fillText('a night market that never closes', width / 2, y + fs * 0.42)
}

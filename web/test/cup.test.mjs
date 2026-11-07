// The Lantern Cup: an hourly race on the row by takings sized to the stall, from two reads of the
// chain an hour apart. Pure functions and the history read against a fake chain; no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as L from '../js/logic.js'
import { Rpc } from '../js/near.js'
import { Client } from '../js/chain.js'
import { cupHtml } from '../js/ui.js'

const HOUR = L.CUP_HOUR_MS
const BOT = '728c21065a3a9d06f535964b3b8fac6775a3bfacf3ca8b2b3b748365c610718f' // Bot - Tin Kettle

const stall = (id, o = {}) => ({ id, name: `Stall ${id}`, npc: id <= 6, owner: 'ab'.repeat(32), spot: id, revenue: 0, customers: 0, worth: 3000, ...o })

test('the cup hour is the clock hour that holds chain time', () => {
  const t = Date.UTC(2026, 10, 7, 11, 37, 30)
  const h = L.cupHour(t)
  assert.equal(h.start, Date.UTC(2026, 10, 7, 11))
  assert.equal(h.end, Date.UTC(2026, 10, 7, 12))
  assert.equal(h.left, 22.5 * 60_000)
  assert.equal(L.cupHour(h.start).start, h.start, 'the first millisecond belongs to the new hour')
  assert.equal(L.cupHour(h.end - 1).start, h.start)
})

test('a new stall that sells well leads the cup although a merchant takes in ten times as much', () => {
  const base = {
    minted: 27,
    stalls: [stall(1, { name: 'The Quiet Kettle', revenue: 500_000, customers: 4000, worth: 67_000 }), stall(26, { owner: BOT, name: 'Bot - Tin Kettle', revenue: 90_000, customers: 900, worth: 5_500 }), stall(27, { revenue: 100, worth: 800 })],
  }
  const row = [
    stall(1, { name: 'The Quiet Kettle', revenue: 611_000, customers: 5000, worth: 68_000 }), // took 111,000 on 67,000: ×1.66
    stall(26, { owner: BOT, name: 'Bot - Tin Kettle', revenue: 102_100, customers: 1020, worth: 5_800 }), // took 12,100 on 5,500: ×2.2
    stall(27, { revenue: 100, worth: 700 }), // nothing this hour
    stall(28, { name: 'Honey Lantern', revenue: 7_200, customers: 80, worth: 3_400 }), // opened this hour: 7,200 on 3,000: ×2.4
  ]
  const rows = L.cupStandings(row, base, { floor: 3000 })
  assert.deepEqual(rows.map((r) => [r.id, r.place, r.takings, r.stake]), [[28, 1, 7200, 3000], [26, 2, 12100, 5500], [1, 3, 111000, 67000], [27, null, 0, 3000]])
  assert.equal(rows[0].sales, 80)
  assert.equal(rows[1].bot, true, 'house bots race and are tagged')
  assert.equal(rows[2].npc, true, 'merchants race and are tagged')
  assert.ok(Math.abs(rows[2].score - 111000 / 67000) < 1e-9)
})

test('the cup leaves out stalls off the row and stalls whose start it does not know', () => {
  const base = { minted: 9, stalls: [stall(7, { revenue: 50 })] }
  const row = [stall(7, { revenue: 650 }), stall(8, { revenue: 9_999 }), stall(10, { revenue: 300 }), stall(11, { spot: null, revenue: 800 })]
  // 8 existed when the hour began (id <= minted) but the base does not hold it: its takings are unknown
  assert.deepEqual(L.cupStandings(row, base).map((r) => [r.id, r.takings]), [[7, 600], [10, 300]])
  // revenue never shrinks, but a lagging view must not make takings negative
  assert.equal(L.cupStandings([stall(7, { revenue: 10 })], base)[0].takings, 0)
  assert.deepEqual(L.cupStandings(null, base), [])
})

test('cup ties go to the bigger takings, then to the older stall', () => {
  const base = { minted: 3, stalls: [stall(2, { worth: 6000 }), stall(3, { worth: 3000 })] }
  const rows = L.cupStandings([stall(3, { revenue: 300 }), stall(2, { revenue: 600 }), stall(4, { revenue: 300 })], base)
  assert.deepEqual(rows.map((r) => r.id), [2, 3, 4])
  assert.deepEqual(rows.map((r) => r.place), [1, 2, 3])
})

test('the cup in words: score, time left, the HUD line and last hour’s winner', () => {
  assert.equal(L.cupScore(2.2449), '×2.24')
  assert.equal(L.cupScore(14.26), '×14.3')
  assert.equal(L.cupScore(0), '×0.00')
  assert.equal(L.cupTimeLeft(23.9 * 60_000), '23 min left')
  assert.equal(L.cupTimeLeft(40_000), 'under a minute left')
  const rows = L.cupStandings([stall(7, { revenue: 900 }), stall(8, { revenue: 3000 }), stall(9)], { minted: 6, stalls: [] })
  assert.deepEqual(L.cupLine(rows, 7, 23 * 60_000), { place: 'Cup #2 of 2', score: '×0.30', left: '23 min left' })
  assert.deepEqual(L.cupLine(rows, 9, 60_000), { place: 'Cup: no sale yet', score: null, left: '1 min left' })
  assert.equal(L.cupLine(rows, 99, 0).place, 'Cup: off the row')
  assert.equal(L.cupLine(null, 7, 0), null)
  assert.equal(L.cupWinner(rows, 8).winner.id, 8)
  assert.equal(L.cupWinner(rows, 8).mine, true)
  assert.equal(L.cupWinner(rows, 7).mine, false)
  assert.equal(L.cupWinner([], 7), null)
})

// ---- finding the hour's first block -------------------------------------------------------------

/** A fake chain: a block every ~590 ms with jitter, some heights skipped, history kept from `keep` on. */
function fakeChain({ first = 1000, last = 20000, keep = first, t0 = Date.UTC(2026, 10, 7, 8, 13), pace = 590, skip = (h) => h % 97 === 0 } = {}) {
  const ms = (h) => t0 + Math.round((h - first) * pace + ((h * 7919) % 13) * 9)
  let reads = 0
  return {
    first,
    last,
    ms,
    get reads() {
      return reads
    },
    head: { height: last, ms: ms(last) },
    async header(h) {
      reads++
      if (h < keep || h > last || skip(h)) throw new Error(`UNKNOWN_BLOCK ${h}`)
      return { height: h, ms: ms(h) }
    },
  }
}

test('findBlockAt lands on the hour’s first block within a few reads, over skipped heights', async () => {
  const c = fakeChain()
  for (const target of [Date.UTC(2026, 10, 7, 9), Date.UTC(2026, 10, 7, 10), Date.UTC(2026, 10, 7, 11)]) {
    const before = c.reads
    const b = await L.findBlockAt(target, c.head, c.header, { pace: 600 })
    assert.ok(b, `found a block for ${new Date(target).toISOString()}`)
    assert.ok(b.ms >= target && b.ms - target <= 1500, `block at +${b.ms - target} ms`)
    assert.ok(c.reads - before <= 8, `${c.reads - before} header reads`)
  }
})

test('findBlockAt gives up plainly: a future hour, a head just past the hour, history that is gone', async () => {
  const c = fakeChain()
  assert.equal(await L.findBlockAt(c.head.ms + 1000, c.head, c.header), null, 'the hour has not begun on the final chain yet')
  assert.equal(await L.findBlockAt(c.head.ms - 500, c.head, c.header), c.head, 'the head itself is the first block')
  const pruned = fakeChain({ keep: 15000 })
  await assert.rejects(L.findBlockAt(Date.UTC(2026, 10, 7, 9), pruned.head, pruned.header), /UNKNOWN_BLOCK/)
  assert.equal(await L.findBlockAt(0, null, c.header), null)
})

// ---- the history read, against two fake RPC hosts ----------------------------------------------

/** Two RPC hosts over one fake chain; `prunedBelow` maps a host to the first height it still keeps. */
function fakeHosts(chain, prunedBelow = {}) {
  const calls = []
  const fetchImpl = async (host, { body }) => {
    const req = JSON.parse(body)
    calls.push([host, req.method, req.params.block_id ?? req.params.finality])
    const reply = (j) => ({ ok: !j.error, status: j.error ? 422 : 200, json: async () => j })
    const unknown = { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_BLOCK' } } }
    const h = req.params.block_id ?? chain.last
    if (h < (prunedBelow[host] ?? 0)) return reply(unknown)
    if (req.method === 'block') {
      try {
        const b = await chain.header(h)
        return reply({ result: { header: { height: b.height, timestamp: b.ms * 1e6 } } })
      } catch {
        return reply(unknown)
      }
    }
    if (req.method === 'query') {
      const args = JSON.parse(Buffer.from(req.params.args_base64, 'base64').toString())
      const stalls = [stall(1, { revenue: h }), stall(2, { revenue: 2 * h })].filter((s) => s.id >= args.from)
      return reply({ result: { result: [...Buffer.from(JSON.stringify(stalls))], block_height: h } })
    }
    return reply({ error: { name: 'NO_SCRIPT' } })
  }
  return { calls, fetchImpl }
}

test('the cup reads the stalls at the hour’s first block, from the host that keeps the history', async () => {
  const chain = fakeChain()
  const f = fakeHosts(chain, { 'https://a': 19000 }) // host a keeps only the last ten minutes
  const rpc = new Rpc(['https://a', 'https://b'], { fetchImpl: f.fetchImpl })
  const client = new Client({ rpc, contract: 'lantern-row.testnet', pool: {} })
  const target = Date.UTC(2026, 10, 7, 10)
  const info = console.info
  console.info = () => {}
  const at = await client.stallsAt(target).finally(() => (console.info = info))
  assert.ok(at.ms >= target && at.ms - target <= 1500)
  assert.deepEqual(at.stalls.map((s) => s.revenue), [at.height, 2 * at.height], 'the view was read at that block')
  assert.equal(at.minted, 2)
  assert.equal(rpc.host, 'https://a', 'a host without history is not a broken host: the active one stays')
  const views = f.calls.filter((c) => c[1] === 'query')
  assert.deepEqual(views, [['https://b', 'query', at.height]], 'one view, at one block, on the host with history')
  assert.ok(f.calls.length <= 14, `${f.calls.length} calls in all`)
})

test('the cup read answers null when no host keeps the hour, so the page counts from its own first view', async () => {
  const chain = fakeChain()
  const f = fakeHosts(chain, { 'https://a': 19000, 'https://b': 19000 })
  const client = new Client({ rpc: new Rpc(['https://a', 'https://b'], { fetchImpl: f.fetchImpl }), contract: 'lantern-row.testnet', pool: {} })
  const info = console.info
  console.info = () => {}
  try {
    assert.equal(await client.stallsAt(Date.UTC(2026, 10, 7, 9)), null)
  } finally {
    console.info = info
  }
  assert.equal(f.calls.filter((c) => c[1] === 'query').length, 0)
})

// ---- the board -------------------------------------------------------------------------------------

test('the cup board escapes stall names and tags merchants, house bots and the player', () => {
  const rows = L.cupStandings(
    [stall(1, { name: 'The Quiet Kettle', revenue: 6000, worth: 60000 }), stall(26, { owner: BOT, name: 'Bot - Tin Kettle', revenue: 9000 }), stall(30, { name: '<img src=x onerror=alert(1)>', revenue: 4000 })],
    { minted: 26, stalls: [stall(1, { worth: 60000 }), stall(26)] },
  )
  const cup = { rows, ...L.cupHour(Date.UTC(2026, 10, 7, 11, 37)), live: false, since: Date.UTC(2026, 10, 7, 11), height: 276621909, last: { start: Date.UTC(2026, 10, 7, 10), winner: rows[0] }, floor: 3000 }
  const full = cupHtml(cup, { myId: 30 })
  assert.ok(!full.includes('<img'), 'a name never reaches the page as markup')
  assert.match(full, /&lt;img src=x onerror=alert\(1\)&gt; <em>\(you\)<\/em>/)
  assert.match(full, /house bot/)
  assert.match(full, /merchant/)
  assert.match(full, /#276,621,909/)
  assert.match(full, /23 min left/)
  assert.ok(!/style=/.test(full), 'no inline styles: the page CSP forbids them')
  const compact = cupHtml(cup, { myId: 30, compact: true })
  assert.equal((compact.match(/<li /g) ?? []).length, 3)
  assert.match(cupHtml({ ...cup, live: true, pending: false }, {}), /history was out of reach/)
  assert.match(cupHtml(null), /Reading the hour/)
})

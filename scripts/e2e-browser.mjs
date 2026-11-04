#!/usr/bin/env node
// End-to-end check of the web client against NEAR testnet, through the real page in headless Chrome.
// Two browser profiles play at once: each founds a stall (or returns to one), restocks, changes
// prices, watches nights pass, reads the night summary, opens the deed and lists the stall.
//
//   node scripts/e2e-browser.mjs --url http://127.0.0.1:8765/web/ --nights 10 --out <dir> [--profiles <dir>]
//
// Prints one line per observed night and transaction, and a JSON summary at the end. Exit code 1 on
// any failed step. Needs Node 22+ and Google Chrome.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchChrome, openPage, sleep } from './cdp.mjs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : dflt
}
const URL_ = arg('url', 'http://127.0.0.1:8765/web/')
const NIGHTS = Number(arg('nights', 10))
const OUT = arg('out', join(process.cwd(), 'e2e-out'))
const PROFILES = arg('profiles', join(OUT, 'profiles'))
mkdirSync(OUT, { recursive: true })

const results = { nights: {}, txs: {}, steps: [], failures: [] }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
function step(who, name, ok, info = '') {
  results.steps.push({ who, name, ok, info })
  log(`${ok ? 'ok  ' : 'FAIL'} [${who}] ${name} ${info}`)
  if (!ok) results.failures.push(`${who}: ${name} ${info}`)
}

const state = (p) => p.eval(() => {
  const s = globalThis.__lantern?.state
  if (!s) return null
  return { night: s.world?.night, started: s.started, stall: s.stall && { id: s.stall.id, name: s.stall.name, money: s.stall.money, stock: s.stall.stock, price: s.stall.price, listed: s.stall.listed, worth: s.stall.worth, spot: s.stall.spot }, walking: s.walking, txs: globalThis.__lantern.client.txs.map((t) => ({ kind: t.kind, hash: t.hash, gas: t.gas, failure: t.failure })), pending: globalThis.__lantern.state.pendingGoods.size, account: s.identity?.account }
})

async function player(who, { port, mobile }) {
  const chrome = await launchChrome({ port, profileDir: join(PROFILES, who), width: mobile ? 390 : 1366, height: mobile ? 844 : 820, mobile })
  const page = await openPage(chrome, URL_)
  const shot = (name) => page.screenshot(join(OUT, `${who}-${name}.png`))
  try {
    await page.waitFor(() => !document.getElementById('title-actions').classList.contains('hidden'), 30000)
    await shot('title')
    const fresh = await page.eval(() => !document.getElementById('name-row').classList.contains('hidden'))
    if (fresh) await page.type('#stall-name', who === 'alice' ? 'Alice Teahouse' : 'Bobs Dumplings')
    await page.click('#start')
    await page.waitFor(() => globalThis.__lantern?.state?.started === true, 120000, 500)
    let s = await state(page)
    step(who, 'stall on the street', !!s.stall, `stall ${s.stall?.id} "${s.stall?.name}" money ${s.stall?.money} account ${s.account?.slice(0, 10)}…`)
    await sleep(1500)
    await shot('game-start')

    // restock with one tap, then smart prices
    const before = s.stall
    await page.click('#btn-restock')
    await sleep(300)
    await page.click('#btn-smart')
    await page.waitFor(() => globalThis.__lantern.state.pendingGoods.size === 0 && globalThis.__lantern.client.txs.some((t) => t.kind === 'act'), 60000, 500)
    await sleep(2500)
    s = await state(page)
    const stocked = s.stall.stock.reduce((a, b) => a + b, 0)
    step(who, 'restock through the UI', stocked > before.stock.reduce((a, b) => a + b, 0) || stocked > 0, `stock ${JSON.stringify(s.stall.stock)} prices ${JSON.stringify(s.stall.price)}`)

    // change one price with the + button
    const p0 = s.stall.price[0]
    await page.click('.good[data-g="0"] .inc')
    await page.waitFor(() => globalThis.__lantern.state.pendingGoods.size === 0, 60000, 500)
    await sleep(2500)
    s = await state(page)
    step(who, 'price change through the UI', s.stall.price[0] !== p0 && s.stall.price[0] > 0, `tea ${p0} -> ${s.stall.price[0]}`)
    await shot('priced')

    // watch nights pass
    let seen = 0
    let summaries = 0
    let lastNight = s.night
    let midShot = false
    let summaryShot = false
    const t0 = Date.now()
    while (seen < NIGHTS && Date.now() - t0 < NIGHTS * 45000 + 60000) {
      await sleep(midShot ? 1000 : 400)
      const st = await state(page)
      if (!st) continue
      if (st.walking && !midShot) {
        await sleep(1800)
        await shot('mid-night')
        midShot = true
      }
      if (st.night !== lastNight) {
        seen += st.night - lastNight
        lastNight = st.night
        results.nights[who] = (results.nights[who] ?? 0) + 1
        log(`[${who}] night ${st.night} began (money ${st.stall.money}, stock ${JSON.stringify(st.stall.stock)})`)
        // every third night: restock again, so the stall keeps trading
        if (seen % 3 === 0) {
          await sleep(12000)
          await page.click('#btn-restock').catch(() => {})
        }
      }
      const vis = await page.eval(() => !document.getElementById('summary').classList.contains('hidden') && document.getElementById('summary-headline').textContent)
      if (vis && !summaryShot) {
        summaries++
        await shot('summary')
        summaryShot = true
        const lines = await page.eval(() => [...document.querySelectorAll('#summary-lines li')].map((l) => l.textContent))
        log(`[${who}] summary: ${vis} | ${lines.join(' | ')}`)
      } else if (vis) summaries++
    }
    step(who, `${NIGHTS} nights observed`, seen >= NIGHTS, `${seen} nights, ${summaries} summary sightings`)
    step(who, 'night summary shown', summaries > 0)

    // the deed: open, list, verify on chain, withdraw
    await page.click('#btn-deed')
    await page.waitFor(() => document.querySelector('[data-list]') || document.querySelector('[data-unlist]'), 20000)
    await sleep(800)
    await shot('deed')
    const alreadyListed = await page.eval(() => !!document.querySelector('[data-unlist]'))
    if (alreadyListed) {
      await page.click('[data-unlist]')
      await page.waitFor(() => globalThis.__lantern.state.pendingGoods.size === 0 && !globalThis.__lantern.client.txs[0]?.failure, 60000, 500)
      await sleep(3000)
      await page.click('#btn-deed')
      await page.waitFor(() => document.querySelector('[data-list]'), 20000)
    }
    await page.eval(() => (document.querySelector('#list-price').value = '4321'))
    await page.click('[data-list]')
    let listedOnChain = null
    for (let i = 0; i < 12 && listedOnChain === null; i++) {
      await sleep(2500)
      listedOnChain = await page.eval(async () => {
        const w = await globalThis.__lantern.client.world()
        return w.listings.find((l) => l[0] === globalThis.__lantern.state.stall.id)?.[1] ?? null
      })
    }
    step(who, 'deed listed for sale (on chain)', listedOnChain === 4321, `listing ${listedOnChain}`)
    await page.click('#btn-deed')
    await page.waitFor(() => document.querySelector('[data-unlist]'), 20000)
    await sleep(600)
    await shot('deed-listed')
    await page.click('[data-unlist]')
    await sleep(8000)
    const unlisted = await page.eval(async () => {
      const w = await globalThis.__lantern.client.world()
      return !w.listings.some((l) => l[0] === globalThis.__lantern.state.stall.id)
    })
    step(who, 'listing withdrawn (on chain)', unlisted)

    await page.click('#btn-board')
    await sleep(1500)
    await shot('leaderboard')
    const other = who === 'alice' ? 'Bobs Dumplings' : 'Alice Teahouse'
    const seesOther = await page.eval((name) => [...document.querySelectorAll('.board .who')].some((e) => e.textContent.includes(name)), other)
    step(who, `sees the other player (${other}) on the leaderboard`, seesOther)
    await page.click('#sheet-close')
    await page.click('#btn-proof')
    await sleep(800)
    await shot('proof')
    await page.click('#sheet-close')

    s = await state(page)
    results.txs[who] = s.txs
    const failed = s.txs.filter((t) => t.failure)
    step(who, 'no failed transactions', failed.length === 0, `${s.txs.length} transactions`)
    const errors = page.console.filter((l) => /exception|error/i.test(l) && !/favicon/.test(l))
    step(who, 'no page exceptions', !page.console.some((l) => l.startsWith('exception')), errors.slice(0, 3).join(' // '))
  } catch (e) {
    step(who, 'run', false, e.message)
    await shot('failure').catch(() => {})
  } finally {
    writeFileSync(join(OUT, `${who}-console.log`), page.console.join('\n'))
    await page.close().catch(() => {})
    chrome.kill()
  }
}

await Promise.all([player('alice', { port: 9333, mobile: false }), player('bob', { port: 9334, mobile: true })])
writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2))
console.log('\nTransactions:')
for (const [who, txs] of Object.entries(results.txs)) for (const t of txs) console.log(`  ${who.padEnd(6)} ${t.kind.padEnd(14)} ${(t.gas / 1e12).toFixed(2).padStart(6)} Tgas  ${t.hash}${t.failure ? '  FAILED' : ''}`)
console.log(`\n${results.steps.filter((s) => s.ok).length}/${results.steps.length} steps passed`)
if (results.failures.length) {
  console.log('failures:\n  ' + results.failures.join('\n  '))
  process.exit(1)
}

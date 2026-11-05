// A small Chrome DevTools Protocol driver with only Node's standard library (Node 22+ for WebSocket).
// Launches headless Chrome with its own profile and remote-debugging port, opens a page, evaluates
// JavaScript in it, clicks elements and takes screenshots. Used by the end-to-end test and for
// screenshots of the client.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export async function launchChrome({ port, profileDir, width = 1366, height = 820, mobile = false, headless = true, extraArgs = [] }) {
  mkdirSync(profileDir, { recursive: true })
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--autoplay-policy=no-user-gesture-required',
    '--hide-scrollbars',
    `--window-size=${width},${height}`,
    ...extraArgs,
    'about:blank',
  ]
  if (headless) args.unshift('--headless=new')
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  proc.stderr.on('data', (d) => (err += d))
  // wait for the debugging endpoint
  let version
  for (let i = 0; i < 100; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      break
    } catch {
      await sleep(150)
    }
  }
  if (!version) {
    proc.kill()
    throw new Error(`Chrome did not come up on ${port}: ${err.slice(0, 500)}`)
  }
  return { proc, port, version, mobile, width, height, kill: () => proc.kill() }
}

export async function openPage(chrome, url) {
  const target = await (await fetch(`http://127.0.0.1:${chrome.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  const page = new Page(ws, chrome)
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Network.enable')
  await page.send('Network.setCacheDisabled', { cacheDisabled: true }) // always the files on disk, never a stale copy
  if (chrome.mobile) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: chrome.width, height: chrome.height, deviceScaleFactor: 2, mobile: true })
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true })
  } else {
    await page.send('Emulation.setDeviceMetricsOverride', { width: chrome.width, height: chrome.height, deviceScaleFactor: 1, mobile: false })
  }
  await page.send('Page.navigate', { url })
  await page.waitFor(() => document.readyState === 'complete', 15000)
  return page
}

export class Page {
  constructor(ws, chrome) {
    this.ws = ws
    this.chrome = chrome
    this.id = 0
    this.pending = new Map()
    this.console = []
    this.handlers = new Map() // method -> fn(params), for events a caller wants (screencast frames, …)
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.method && this.handlers.has(m.method)) this.handlers.get(m.method)(m.params)
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
      } else if (m.method === 'Runtime.consoleAPICalled') {
        this.console.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`)
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.console.push(`exception: ${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description ?? ''}`)
      }
    }
  }

  /** Registers a handler for a protocol event, e.g. 'Page.screencastFrame'. */
  on(method, fn) {
    this.handlers.set(method, fn)
  }

  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res, rej) => this.pending.set(id, { res, rej }))
  }

  /** Evaluates a function (or expression string) in the page and returns its JSON value. */
  async eval(fn, ...args) {
    const expression = typeof fn === 'function' ? `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})` : fn
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`)
    return r.result.value
  }

  async waitFor(fn, timeout = 20000, every = 250, ...args) {
    const t0 = Date.now()
    for (;;) {
      let v
      try {
        v = await this.eval(fn, ...args)
      } catch (e) {
        if (Date.now() - t0 > timeout) throw e
      }
      if (v) return v
      if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${fn.toString().slice(0, 120)}`)
      await sleep(every)
    }
  }

  /** Clicks the centre of an element through real input events. */
  async click(selector) {
    const box = await this.eval((sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      el.scrollIntoView?.({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
    }, selector)
    if (!box || box.w === 0) throw new Error(`no visible element ${selector}`)
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
    }
    await sleep(60)
  }

  async type(selector, text) {
    await this.click(selector)
    await this.eval((sel) => {
      const el = document.querySelector(sel)
      el.value = ''
      el.focus()
    }, selector)
    for (const ch of text) await this.send('Input.dispatchKeyEvent', { type: 'char', text: ch })
    await sleep(30)
  }

  async screenshot(path, { clip } = {}) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
    writeFileSync(path, Buffer.from(r.data, 'base64'))
    return path
  }

  async close() {
    try {
      await this.send('Page.close')
    } catch {
      /* already gone */
    }
    this.ws.close()
  }
}

export { sleep }

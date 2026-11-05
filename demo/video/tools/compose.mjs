#!/usr/bin/env node
// Composes the frames of the demo video: the recorded take, cut as timeline.json says, with captions,
// the hand, the live badge and the end card drawn over it by compositor.html in headless Chrome.
//
//   node demo/video/tools/compose.mjs --work <dir> [--stills 3,40,70] [--from <sec>] [--port 9420]
//
// Reads <work>/timeline.json (from voice.py, which also names the takes) and ../storyboard.json,
// opens compositor.html, calls setup() once and seek(t) for every frame. A frame whose state did not
// change is not captured again; identical images are stored once. Output:
//   <work>/frames/*.png and <work>/frames/manifest.txt (one image path per video frame)
// With --stills it only writes <work>/stills/t<sec>.png for the given times (a quick look). With
// --from it recomposes only the frames from that second on and keeps the earlier ones of the last run.
// Needs Node 22+ and Google Chrome; no npm packages.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { launchChrome, Page } from '../../../scripts/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : dflt
}
const WORK = resolve(arg('work', 'work'))
const PORT = Number(arg('port', 9420))
const STILLS = arg('stills', null)
const FROM = Number(arg('from', 0))

const storyboard = JSON.parse(readFileSync(join(HERE, '..', 'storyboard.json'), 'utf8'))
const timeline = JSON.parse(readFileSync(join(WORK, 'timeline.json'), 'utf8'))
const { width, height } = storyboard.meta
const jsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const takes = Object.fromEntries(Object.entries(timeline.takes).map(([name, dir]) => [name, { url: pathToFileURL(dir).href, frames: jsonl(join(dir, 'frames.jsonl')), events: jsonl(join(dir, 'events.jsonl')) }]))

const chrome = await launchChrome({ port: PORT, profileDir: join(WORK, 'chrome-profile'), width, height, extraArgs: ['--allow-file-access-from-files', '--force-device-scale-factor=1', '--force-color-profile=srgb', '--font-render-hinting=none', '--mute-audio'] })
const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
const page = new Page(ws, chrome)
try {
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 15, g: 13, b: 43, a: 1 } })
  await page.send('Page.navigate', { url: pathToFileURL(join(HERE, 'compositor.html')).href })
  await page.waitFor(() => document.readyState === 'complete' && typeof window.setup === 'function', 15000, 100)
  const info = await page.eval(`setup(${JSON.stringify(timeline)}, ${JSON.stringify(storyboard)}, ${JSON.stringify(takes)})`)
  console.log('compositor ready:', JSON.stringify(info))
  const nextPaint = () => page.eval('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))')
  const capture = async () => Buffer.from((await page.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: false })).data, 'base64')

  if (STILLS) {
    const dir = join(WORK, 'stills')
    mkdirSync(dir, { recursive: true })
    for (const s of String(STILLS).split(',')) {
      await page.eval(`seek(${Number(s)})`)
      await nextPaint()
      const file = join(dir, `t${s}.png`)
      writeFileSync(file, await capture())
      console.log(file)
    }
  } else {
    const fps = timeline.fps
    const total = timeline.frames
    const dir = join(WORK, 'frames')
    const first = Math.round(FROM * fps)
    const manifest = first > 0 ? readFileSync(join(dir, 'manifest.txt'), 'utf8').split('\n').filter(Boolean).slice(0, first) : []
    if (first === 0) rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const byHash = new Map()
    let prevSig = null
    let prevFile = null
    let captured = 0
    const t0 = Date.now()
    for (let i = manifest.length; i < total; i++) {
      const sig = await page.eval(`seek(${i / fps})`)
      if (sig !== prevSig || prevFile === null) {
        await nextPaint()
        const png = await capture()
        captured++
        const hash = createHash('sha1').update(png).digest('hex')
        let file = byHash.get(hash)
        if (!file) {
          file = join(dir, `f${String(i).padStart(5, '0')}.png`)
          writeFileSync(file, png)
          byHash.set(hash, file)
        }
        prevFile = file
        prevSig = sig
      }
      manifest.push(prevFile)
      if (i % 300 === 0) console.log(`frame ${i}/${total}  captured ${captured}  unique ${byHash.size}  ${((Date.now() - t0) / 1000).toFixed(0)} s`)
    }
    writeFileSync(join(dir, 'manifest.txt'), manifest.join('\n') + '\n')
    console.log(`done: ${total} frames, ${captured} captured, ${byHash.size} unique PNGs, ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  }
  const errors = page.console.filter((l) => /exception|error/i.test(l))
  if (errors.length) console.log('page console:', errors.slice(0, 5).join('\n'))
} finally {
  await page.close().catch(() => {})
  chrome.kill()
}
process.exit(0)

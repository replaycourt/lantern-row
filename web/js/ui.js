// DOM side of the client: the HUD, the goods counter, hints, the night summary, sheets, toasts.
// Everything that comes from the chain goes through escapeHtml before it touches innerHTML.
import { GOOD_SHORT, escapeHtml as esc, fmt, shortAccount, eventInfo, bannerText, cheapestRival, expectSales, spotLabel } from './logic.js'

export const $ = (id) => document.getElementById(id)

const ICONS = [
  // tea: a cup with steam
  `<svg viewBox="0 0 40 40"><path d="M8 17h20v6a8 8 0 0 1-8 8h-4a8 8 0 0 1-8-8v-6z" fill="#6fbf9a"/><path d="M28 19h3a4 4 0 0 1 0 8h-3" fill="none" stroke="#6fbf9a" stroke-width="2.5"/><rect x="7" y="15" width="22" height="3" rx="1.5" fill="#d7f3e3"/><path d="M15 12c0-3 2-3 2-6M21 12c0-3 2-3 2-6" fill="none" stroke="#fff3dc" stroke-width="1.6" stroke-linecap="round" opacity=".7"/></svg>`,
  // lamp oil: a flask
  `<svg viewBox="0 0 40 40"><rect x="16" y="6" width="8" height="6" rx="1.5" fill="#5a3a1a"/><path d="M15 12h10v5l4 6v9a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3v-9l4-6v-5z" fill="#f0a43a"/><path d="M14 24h12v7a2 2 0 0 1-2 2H16a2 2 0 0 1-2-2v-7z" fill="#ffd166" opacity=".8"/></svg>`,
  // dumplings in a basket
  `<svg viewBox="0 0 40 40"><ellipse cx="20" cy="28" rx="15" ry="6" fill="#8c5a2b"/><circle cx="13" cy="21" r="5.5" fill="#fff3dd"/><circle cx="27" cy="21" r="5.5" fill="#fff3dd"/><circle cx="20" cy="16" r="5.5" fill="#fff3dd"/><path d="M11 20h4M25 20h4M18 15h4" stroke="#e8cfa8" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  // silk: rolled bolts
  `<svg viewBox="0 0 40 40"><rect x="6" y="24" width="28" height="7" rx="3.5" fill="#c04a9c"/><rect x="8" y="17" width="26" height="7" rx="3.5" fill="#7d4ec9"/><rect x="10" y="10" width="22" height="7" rx="3.5" fill="#e07aa8"/><path d="M12 13h16M10 20h18M8 27h20" stroke="#fff" stroke-width="1" opacity=".35"/></svg>`,
  // charms: tassels
  `<svg viewBox="0 0 40 40"><path d="M14 6v10M26 6v10" stroke="#d64545" stroke-width="2" stroke-linecap="round"/><circle cx="14" cy="18" r="4.5" fill="#ffd166"/><circle cx="26" cy="18" r="4.5" fill="#ffd166"/><path d="M11 22h6l-1 10h-4zM23 22h6l-1 10h-4z" fill="#d64545"/><path d="M14 32v3M26 32v3" stroke="#d64545" stroke-width="2.5"/></svg>`,
]

export function goodIcon(g) {
  return ICONS[g] ?? ''
}

// ---- goods counter ------------------------------------------------------------------------------

export function buildGoods(cfg, { onPrice, onCard }) {
  const root = $('goods')
  root.innerHTML = ''
  cfg.goods.forEach((good, g) => {
    const el = document.createElement('div')
    el.className = 'good'
    el.dataset.g = String(g)
    el.innerHTML = `
      <div class="icon">${ICONS[g]}</div>
      <div class="gname"><span>${esc(GOOD_SHORT[g] ?? good.name)}</span><span class="sold" data-sold></span></div>
      <div class="stock"><b data-stock>0</b> in stock<span class="want" data-want></span></div>
      <div class="price-row">
        <button class="dec" type="button" aria-label="Lower the price of ${esc(good.name)}">−</button>
        <div class="price" data-price><span data-p>–</span><small data-hint></small></div>
        <button class="inc" type="button" aria-label="Raise the price of ${esc(good.name)}">+</button>
      </div>`
    el.querySelector('.dec').addEventListener('click', () => onPrice(g, -1))
    el.querySelector('.inc').addEventListener('click', () => onPrice(g, +1))
    el.querySelector('.icon').addEventListener('click', () => onCard?.(g))
    root.appendChild(el)
  })
}

export function renderGoods(stall, { cfg, world, pendingGoods = new Set(), fc = null, reasons = null }) {
  const cards = $('goods').children
  const ev = world ? eventInfo(world.event, cfg) : null
  for (let g = 0; g < cards.length; g++) {
    const el = cards[g]
    const stock = stall.stock[g]
    const price = stall.price[g]
    el.classList.toggle('empty', stock === 0)
    el.querySelector('[data-stock]').textContent = fmt(stock)
    const p = el.querySelector('[data-price]')
    p.classList.toggle('off', price === 0)
    p.classList.toggle('pending', pendingGoods.has(g))
    el.querySelector('[data-p]').textContent = price === 0 ? 'off' : fmt(price)
    const rival = world ? cheapestRival(world, stall.id, g) : null
    const hint = el.querySelector('[data-hint]')
    const parts = []
    if (rival) parts.push(`rivals ${fmt(rival.price[g])}`)
    else if (world) parts.push(`dock ${fmt(world.dock[g].price)}`)
    const f = fc?.[g]
    if (f && price > 0 && stock > 0 && f.wanted > 0) {
      const n = expectSales(fc, g, price, { stock })
      parts.push(n >= 0.5 ? `~${Math.round(n)} sell` : 'few buy')
    }
    hint.textContent = parts.join(' · ')
    p.title = reasons?.[g] ? `Smart price: ${reasons[g].price}, ${reasons[g].reason}` : ''
    const sold = stall.sold_last?.[g] ?? 0
    el.querySelector('[data-sold]').textContent = sold ? `sold ${sold}` : ''
    const want = el.querySelector('[data-want]')
    want.textContent = f ? (f.wanted ? ` · ${f.wanted} want` : ' · none want') : ''
    const short = !!f && f.wanted > f.rivalStock + stock
    el.classList.toggle('short', short)
    el.classList.toggle('slow', !!f && f.wanted === 0)
    el.classList.toggle('hot', !!ev && ev.good === g)
    el.classList.toggle('storm', !!ev && ev.good === g && ev.kind === 'storm')
  }
}

export function stampCards(goods) {
  const cards = $('goods').children
  for (const g of goods) {
    const el = cards[g]
    if (!el) continue
    el.classList.remove('stamp')
    void el.offsetWidth
    el.classList.add('stamp')
  }
}

// ---- HUD ----------------------------------------------------------------------------------------

let lastMoney = null
export function renderHud({ stall, rank, total }) {
  $('hud-name').textContent = stall.name
  const m = $('hud-money')
  if (lastMoney !== null && stall.money !== lastMoney) {
    const wrap = m.parentElement
    wrap.classList.remove('bump')
    void wrap.offsetWidth
    wrap.classList.add('bump')
  }
  lastMoney = stall.money
  m.textContent = fmt(stall.money)
  $('hud-worth').textContent = `worth ${fmt(stall.worth)} · ${rank ? `#${rank} of ${total}` : spotLabel(stall.spot)}`
}

export function renderNight(world) {
  $('hud-night').textContent = String(world.night)
}

export function renderClock(fraction, { walking }) {
  const ring = $('ring-fg')
  const len = 119.4
  ring.style.strokeDashoffset = String(len * (1 - Math.max(0, Math.min(1, fraction))))
  ring.classList.toggle('walking', !!walking)
}

export function renderEvent(world, cfg) {
  const info = bannerText(world, cfg)
  const b = $('event-banner')
  b.className = `event-banner ${info.kind}`
  $('event-title').textContent = info.title
  $('event-next').textContent = info.detail
}

// ---- hint, status, toast ------------------------------------------------------------------------

export function showHint(text) {
  const h = $('hint')
  if ($('hint-text').textContent !== text) {
    $('hint-text').textContent = text
    h.classList.remove('hidden')
    h.style.animation = 'none'
    void h.offsetWidth
    h.style.animation = ''
  } else h.classList.remove('hidden')
}
export function hideHint() {
  $('hint').classList.add('hidden')
}

export function setStatus(kind, text) {
  const s = $('status')
  s.className = `status ${kind}`
  $('status-text').textContent = text
}

let toastTimer = null
export function toast(text, kind = '', ms = 3600) {
  const t = $('toast')
  t.textContent = text
  t.className = `toast ${kind}`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms)
}

// ---- night summary ------------------------------------------------------------------------------

/** The night report at the top of the card. `outcome` is how last night's call went: {met, text}. */
export function showSummary(night, s, outcome = null) {
  const el = $('summary')
  el.className = `summary mood-${s.mood}` // not the bare mood: ".good" is the goods card
  $('summary-report').classList.remove('hidden')
  $('summary-night').textContent = `Night ${night}`
  $('summary-headline').textContent = s.headline
  $('summary-lines').innerHTML = s.lines.map((l) => `<li class="${esc(l.icon)}">${esc(l.text)}</li>`).join('')
  const o = $('summary-outcome')
  o.className = `summary-outcome ${outcome?.met ? 'met' : outcome?.met === false ? 'missed' : ''}`
  o.classList.toggle('hidden', !outcome)
  o.textContent = outcome?.text ?? ''
  $('summary-stamp').classList.toggle('hidden', !outcome?.met)
  $('summary-call').classList.add('hidden')
}

/** Tonight's call: one decision with two buttons. Shows alone when there is no report to put it under. */
export function showCall(call, { alone = false } = {}) {
  const el = $('summary')
  if (alone) {
    el.className = 'summary mood-call'
    $('summary-report').classList.add('hidden')
  }
  $('call-title').textContent = call.title
  $('call-text').textContent = call.text
  $('call-expect').textContent = call.expect ?? ''
  $('call-accept').textContent = call.accept.cost ? `${call.accept.label} · ${fmt(call.accept.cost)}` : call.accept.label
  $('call-decline').textContent = call.decline?.label ?? 'Skip'
  $('summary-call').classList.remove('hidden')
  el.classList.remove('hidden')
}
export function hideCall() {
  $('summary-call').classList.add('hidden')
  if ($('summary-report').classList.contains('hidden')) hideSummary()
}
export function hideSummary() {
  $('summary').classList.add('hidden')
}
export function summaryVisible() {
  return !$('summary').classList.contains('hidden')
}
export function callVisible() {
  return summaryVisible() && !$('summary-call').classList.contains('hidden')
}

// ---- sheets -------------------------------------------------------------------------------------

export function openSheet(title, html) {
  $('sheet-title').textContent = title
  const body = $('sheet-body')
  body.innerHTML = html
  body.scrollTop = 0
  $('sheet').classList.remove('hidden')
  $('sheet-backdrop').classList.remove('hidden')
  return body
}
export function closeSheet() {
  $('sheet').classList.add('hidden')
  $('sheet-backdrop').classList.add('hidden')
}
export function sheetOpen() {
  return !$('sheet').classList.contains('hidden')
}

export function deedHtml({ stall, token, cfg, account, royaltyPct, freeSpots }) {
  const goods = stall.stock.reduce((a, b) => a + b, 0)
  const holders = stall.holders?.length ? `<p class="holders">Earlier owners: ${stall.holders.map((h) => `<code>${esc(shortAccount(h))}</code>`).join(', ')}</p>` : '<p class="holders">You are the first owner.</p>'
  const media = token?.metadata?.media?.startsWith('data:image/svg+xml') ? `<img class="deed-nft" src="${esc(token.metadata.media)}" alt="The stall as the chain draws it" width="200" height="200">` : '<div class="deed-nft deed-nft-empty">picture loading…</div>'
  const upgradeCost = cfg.tier_cost[stall.tier + 1]
  const frozen = stall.listed != null
  const moveButtons = (freeSpots ?? [])
    .slice(0, 3)
    .map((s) => `<button class="small" type="button" data-move="${s.spot}" ${frozen || stall.money < s.fee ? 'disabled' : ''}>Move to ${spotLabel(s.spot)} <small>· ${fmt(s.fee)}</small></button>`)
    .join('')
  return `
    <div class="deed">
      <div class="deed-title">${esc(stall.name)}</div>
      <p class="deed-sub">Stall No. ${stall.id} on Lantern Row · ${stall.spot == null ? 'off the row' : `spot ${stall.spot} of 0–23`} · size ${stall.tier + 1}${frozen ? ' · <span class="listed-tag">FOR SALE</span>' : ''}</p>
      <div class="deed-art">
        <div class="deed-pic">${media}<small>the token’s own picture, drawn by the contract</small></div>
        <div class="deed-stats">
          <div><span>coin inside</span><b>${fmt(stall.money)}</b></div>
          <div><span>goods inside</span><b>${fmt(goods)}</b></div>
          <div><span>reputation</span><b>${fmt(stall.rep / 10)}/100</b></div>
          <div><span>net worth</span><b>${fmt(stall.worth)}</b></div>
          <div><span>customers served</span><b>${fmt(stall.customers)}</b></div>
          <div><span>walk-by</span><b>${stall.footfall ?? 0}%</b></div>
        </div>
      </div>
      <p class="muted">Owner <code>${esc(shortAccount(stall.owner))}</code>${stall.owner === account ? ' (you)' : ''}. Founder <code>${esc(shortAccount(stall.founder))}</code> earns ${royaltyPct}% of every resale.</p>
      ${holders}
      <div class="stamp-seal">LANTERN<br>ROW</div>
    </div>

    <h3>Grow</h3>
    <p>${stall.tier < 3 ? `A bigger stall holds ${cfg.tier_capacity[stall.tier + 1]} goods and serves ${cfg.tier_service[stall.tier + 1]} customers a night.` : 'This is the largest stall on the row.'}</p>
    <div class="row-actions">
      ${stall.tier < 3 ? `<button class="small primary" type="button" data-upgrade ${frozen || stall.money < upgradeCost ? 'disabled' : ''}>Upgrade <small>· ${fmt(upgradeCost)}</small></button>` : ''}
      ${moveButtons || '<span class="muted">No free spot ahead of you right now.</span>'}
    </div>
    <p class="muted">Spots nearer the gate see more villagers: spot 0 has 100% walk-by, spot 23 has 31%.</p>

    <h3>Sell the whole stall</h3>
    <p>The stall is a token that holds its own coin and goods. Whoever buys it gets all of it. ${cfg.sales_tax_pct}% tax and ${royaltyPct}% founder royalty come off the price.</p>
    <div class="row-actions">
      ${frozen
        ? `<span>Listed at <b>${fmt(stall.listed)}</b>.</span><button class="small danger" type="button" data-unlist>Withdraw</button>`
        : `<input id="list-price" type="number" min="1" step="1" value="${Math.max(1, stall.worth)}" aria-label="Asking price"><button class="small primary" type="button" data-list>List for sale</button>`}
    </div>
    ${frozen ? '<p class="muted">While listed, the stall keeps selling to villagers but cannot buy, move or grow.</p>' : ''}

    <h3>Rename</h3>
    <div class="row-actions"><input id="rename-input" maxlength="24" value="${esc(stall.name)}" aria-label="New name"><button class="small" type="button" data-rename>Rename</button></div>
    <p class="muted">Token <code>${stall.id}</code> on <code>${esc(cfg.contract ?? 'lantern-row.testnet')}</code>: a NEP-171 NFT whose picture and description are computed from the live stall.</p>`
}

export function boardHtml(board, myId) {
  const rows = board
    .map((r) => {
      const cls = r.id === myId ? 'me' : r.npc ? 'npc' : 'player'
      const sub = r.spot == null ? 'off the row' : `${spotLabel(r.spot)} · size ${r.tier + 1}`
      return `<li class="${cls}"><span class="rank">${r.rank}</span><span class="who">${esc(r.name)}<small>${sub}</small></span><span class="worth">${fmt(r.worth)}</span></li>`
    })
    .join('')
  return `<p class="muted">Stalls on the row, by net worth: coin, goods at Dock value, stall size and half the spot's fee. Merchants trade by fixed rules; players are people like you on the same street.</p><ol class="board">${rows}</ol>`
}

export function proofHtml({ contract, account, stallId, rpcHost, gasKey, txs, codeHash, explorer }) {
  const txRows = txs.length
    ? txs
        .map((t) => `<li><span class="kind">${esc(t.kind)}</span><a href="${explorer}/txns/${esc(t.hash)}" target="_blank" rel="noopener">${esc(t.hash.slice(0, 10))}…</a>${t.failure ? ' <b>failed</b>' : ''}<span class="gas">${(t.gas / 1e12).toFixed(2)} Tgas</span></li>`)
        .join('')
    : '<li class="muted">No transactions from this tab yet.</li>'
  return `
    <p>Everything you do here is a real transaction on NEAR testnet, signed by a key this browser made. You never had to know that.</p>
    <ul class="proof-list">
      <li><span>contract</span><code><a href="${explorer}/address/${esc(contract)}" target="_blank" rel="noopener">${esc(contract)}</a></code></li>
      <li><span>your account</span><code>${esc(account)}</code></li>
      <li><span>your stall token</span><code>${stallId ?? '–'}</code></li>
      <li><span>code hash</span><code>${esc(codeHash)}</code></li>
      <li><span>contract keys</span><code>none: nobody can patch it</code></li>
      <li><span>RPC in use</span><code>${esc(rpcHost)}</code></li>
      <li><span>gas paid by</span><code>${esc(gasKey ?? 'the public pool')}</code></li>
    </ul>
    <h3>Your transactions</h3>
    <ul class="tx-list">${txRows}</ul>
    <h3>How it works</h3>
    <p class="muted">Your key signs <code>lantern-row:v1:${esc(contract)}:&lt;nonce&gt;:&lt;actions&gt;</code>. A public function-call key on the gas account relays it to <code>act</code>, which checks the signature and applies your actions. Those relay keys can only call <code>act</code> and <code>advance_night</code>; they cannot change anything you did not sign. The street itself ends a night when any client calls <code>advance_night</code>.</p>
    <p class="muted">Coin is an integer inside the contract: 1,000,000 of it exists, none is ever created or destroyed, and it is not a token. Testnet only.</p>`
}

// ---- stall peek ---------------------------------------------------------------------------------

export function showPeek(stall, cfg, { x, y, mine, canBuy, onBuy, onClose }) {
  hidePeek()
  const el = document.createElement('div')
  el.className = 'peek'
  el.id = 'peek'
  const rows = cfg.goods
    .map((good, g) => {
      const n = stall.stock[g]
      const p = stall.price[g]
      const note = stall.npc && stall.notes?.[g] != null ? `<div class="npc-note">${esc(cfg.notes[stall.notes[g]] ?? '')}</div>` : ''
      return `<tr><td>${esc(good.name)}</td><td>${n ? `${fmt(n)} in stock` : '<i>none</i>'}</td><td>${p ? fmt(p) : '–'}</td></tr>${note ? `<tr><td colspan="3">${note}</td></tr>` : ''}`
    })
    .join('')
  el.innerHTML = `
    <b>${esc(stall.name)}</b> <span class="muted">${stall.npc ? '· merchant' : mine ? '· yours' : '· player'}</span>
    <div class="muted">${spotLabel(stall.spot)} · ${stall.footfall ?? 0}% walk-by · rep ${fmt(stall.rep / 10)}/100 · worth ${fmt(stall.worth)}</div>
    <table>${rows}</table>
    ${stall.listed != null ? `<p><span class="listed-tag">FOR SALE</span> ${fmt(stall.listed)} coin${canBuy ? ' <button class="small primary" type="button" data-buy>Buy it</button>' : ''}</p>` : ''}
    <button class="close" type="button" aria-label="Close">×</button>`
  document.body.appendChild(el)
  const r = el.getBoundingClientRect()
  // keep it on screen: never past either edge, never under the top bar, never over the panel
  const panelTop = $('panel').getBoundingClientRect().top
  const hudBottom = $('hud').getBoundingClientRect().bottom
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - r.width - 8, x - r.width / 2))}px`
  el.style.top = `${Math.max(hudBottom + 8, Math.min(panelTop - r.height - 8, y - r.height - 24))}px`
  el.querySelector('.close').addEventListener('click', () => {
    hidePeek()
    onClose?.()
  })
  el.querySelector('[data-buy]')?.addEventListener('click', () => onBuy?.())
  return el
}

export function hidePeek() {
  document.getElementById('peek')?.remove()
}

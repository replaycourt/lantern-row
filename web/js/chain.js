// Talks to the Lantern Row contract: the player's local key, the public gas pool, views, `act` and
// `advance_night`, with retries over keys and RPC hosts. The UI never sees a transaction; it sees
// promises that resolve to game outcomes, and friendly errors when the network is in a mood.
import { Rpc, RpcError, encodeTx, functionCallAction, hex, implicitAccount, keyFromNearString, keyFromSeed, newKey, nearPublicKey, sign, signTx, sleep, summarise, txHash, unhex, utf8 } from './near.js'
import { CONTRACT, GAS_ACCOUNT, GAS_KEYS, RPC_HOSTS } from './gas-keys.js'
import { coalesce, signingText } from './logic.js'

const STORE_KEY = 'lantern-row:key:v1'
const ACT_GAS = 20_000_000_000_000n
const ADVANCE_GAS = 60_000_000_000_000n

export class FriendlyError extends Error {
  constructor(message, cause) {
    super(message)
    this.cause = cause
  }
}

// ---- the player's identity ----------------------------------------------------------------------

export async function loadOrCreateIdentity(storage = globalThis.localStorage) {
  const raw = storage?.getItem(STORE_KEY)
  if (raw) {
    try {
      const { seed, pub } = JSON.parse(raw)
      const key = await keyFromSeed(unhex(seed), unhex(pub))
      return { key, account: implicitAccount(key), fresh: false }
    } catch {
      // fall through and make a new one
    }
  }
  const key = await newKey()
  storage?.setItem(STORE_KEY, JSON.stringify({ seed: hex(key.seed), pub: hex(key.publicKey) }))
  return { key, account: implicitAccount(key), fresh: true }
}

export function forgetIdentity(storage = globalThis.localStorage) {
  storage?.removeItem(STORE_KEY)
}

// ---- the gas pool -------------------------------------------------------------------------------

export class GasPool {
  constructor(rpc, keys = GAS_KEYS, account = GAS_ACCOUNT) {
    this.rpc = rpc
    this.account = account
    this.entries = keys.map((k) => ({ ...k, key: null, nonce: null, dead: false, busy: false }))
    this.cursor = Math.floor(Math.random() * this.entries.length)
    this.lastKey = null
  }

  alive() {
    return this.entries.filter((e) => !e.dead)
  }

  async pick() {
    const alive = this.alive()
    if (!alive.length) throw new FriendlyError('The gas pool has run dry. The game keeps its state; play resumes once the pool is refilled.')
    // Prefer a key nobody in this tab is using right now.
    for (let i = 0; i < alive.length; i++) {
      const e = alive[(this.cursor + i) % alive.length]
      if (!e.busy) {
        this.cursor = (this.cursor + i + 1) % alive.length
        return e
      }
    }
    return alive[this.cursor++ % alive.length]
  }

  async ready(e) {
    if (!e.key) e.key = await keyFromNearString(e.private_key)
    if (e.nonce === null) e.nonce = await this.rpc.accessKeyNonce(this.account, e.public_key)
  }

  /** Sends one function call with a pool key, rotating keys on trouble. Returns summarise(result). */
  async relay(receiver, method, args, gas, { attempts = 5, onRetry } = {}) {
    let lastErr
    for (let attempt = 0; attempt < attempts; attempt++) {
      const e = await this.pick()
      e.busy = true
      try {
        await this.ready(e)
        const blockHash = await this.rpc.blockHash()
        e.nonce += 1n
        const tx = encodeTx({ signerId: this.account, publicKey: e.key.publicKey, nonce: e.nonce, receiverId: receiver, blockHash, actions: [functionCallAction({ method, args, gas })] })
        const signed = await signTx(e.key, tx)
        const hash = await txHash(tx)
        const res = await this.send(signed, hash)
        this.lastKey = e.public_key
        return summarise(res)
      } catch (err) {
        lastErr = err
        if (err instanceof RpcError) {
          if (err.invalidNonce) e.nonce = null // someone else used this key: re-read next time
          else if (err.noAllowance) e.dead = true
          else if (err.expired) {
            /* stale block hash: just retry */
          } else if (!err.transient) throw friendly(err)
        }
        onRetry?.(attempt + 1, err)
        await sleep(300 + attempt * 400)
      } finally {
        e.busy = false
      }
    }
    throw friendly(lastErr)
  }

  /**
   * Sends one signed transaction and gets its outcome, even when the RPC times out (a 408 or a
   * TIMEOUT_ERROR) after the chain already took it. A timeout is followed by asking for the status
   * by hash; an unknown hash is sent again, the same bytes, so nothing is ever applied twice.
   */
  async send(signed, hash) {
    let timedOut = null
    for (let round = 0; round < 2; round++) {
      try {
        return await this.rpc.sendTx(signed)
      } catch (err) {
        if (!(err instanceof RpcError) || !err.transient) {
          // a used nonce on the second round means the first send did land: look it up
          if (round > 0 && err instanceof RpcError && err.invalidNonce) {
            const found = await this.lookup(hash, 8)
            if (found) return found
          }
          throw err
        }
        timedOut = err
      }
      const found = await this.lookup(hash, 6)
      if (found) return found
    }
    throw timedOut
  }

  async lookup(hash, tries) {
    for (let i = 0; i < tries; i++) {
      await sleep(1200)
      const r = await this.rpc.txStatus(hash, this.account).catch(() => null)
      if (r?.status) return r
    }
    return null
  }
}

function friendly(err) {
  if (err instanceof FriendlyError) return err
  const t = String(err?.message ?? err)
  console.info('chain', t.slice(0, 300))
  if (/InvalidNonce/.test(t)) return new FriendlyError('The street is busy; your order got mixed up in the queue. Trying again.', err)
  if (/NotEnoughAllowance|AccessKeyDoesNotExist/.test(t)) return new FriendlyError('The gas pool is running low. One more try with another key.', err)
  if (/TIMEOUT|timeout|Failed to fetch|NetworkError|http 5|abort/i.test(t)) return new FriendlyError('The network hiccupped. Nothing was lost; trying again.', err)
  return new FriendlyError('Something went wrong on the way to the town. Nothing was lost.', err)
}

// ---- the contract -------------------------------------------------------------------------------

export class Client {
  constructor({ rpc = new Rpc(RPC_HOSTS), contract = CONTRACT, pool } = {}) {
    this.rpc = rpc
    this.contract = contract
    this.pool = pool ?? new GasPool(rpc)
    this.identity = null
    this.nonce = null
    this.txs = [] // {kind, hash, gas, at}
    this.onTx = null
  }

  view(method, args) {
    return this.rpc.view(this.contract, method, args)
  }
  world() {
    return this.view('world')
  }
  config() {
    return this.view('config')
  }
  player(account = this.identity?.account) {
    return this.view('player', { account })
  }
  stall(id) {
    return this.view('stall', { id })
  }
  leaderboard(limit = 30) {
    return this.view('leaderboard', { limit })
  }
  nightLog(night) {
    return this.view('night_log', night == null ? {} : { night })
  }
  nftToken(id) {
    return this.view('nft_token', { token_id: String(id) })
  }
  nftPayout(id) {
    return this.view('nft_payout', { token_id: String(id), balance: '1000000000000000000000000', max_len_payout: 10 })
  }
  dockQuote(good, qty) {
    return this.view('dock_quote', { good, qty })
  }

  async setIdentity(identity) {
    this.identity = identity
    const me = await this.player()
    this.nonce = me.nonce ?? 0
    return me
  }

  record(kind, r) {
    const entry = { kind, hash: r.hash, gas: r.gas, at: Date.now(), failure: r.failure }
    this.txs.unshift(entry)
    this.txs = this.txs.slice(0, 40)
    this.onTx?.(entry)
    return entry
  }

  /** Signs and relays a batch of actions. Returns the ActOutcome. Refused actions come back in `error`. */
  async act(actions) {
    if (!this.identity) throw new FriendlyError('No player key yet.')
    const action = JSON.stringify(actions)
    for (let attempt = 0; attempt < 3; attempt++) {
      const nonce = ++this.nonce
      const signature = hex(await sign(this.identity.key, utf8(signingText(this.contract, nonce, action))))
      let r
      try {
        r = await this.pool.relay(this.contract, 'act', { player_pubkey: this.identity.account, nonce, action, signature }, ACT_GAS)
      } catch (e) {
        // The order may or may not have landed. Read the chain's nonce so views are trusted again.
        await this.resync()
        throw e
      }
      this.record('act', r)
      if (r.failure) {
        // A used nonce means a view lagged behind our own earlier transaction: read it fresh and retry.
        if (/nonce/i.test(r.failure) && attempt < 2) {
          const me = await this.player()
          this.nonce = Math.max(this.nonce, me.nonce ?? 0)
          continue
        }
        throw new FriendlyError('The town clerk rejected the order. Reloading your stall.', new Error(r.failure))
      }
      return r.value
    }
    throw new FriendlyError('The order could not be stamped. Reloading your stall.')
  }

  /** Brings the local nonce back to what the chain knows, after an order that may not have landed. */
  async resync() {
    try {
      const me = await this.player()
      this.nonce = me.nonce ?? this.nonce
    } catch {
      /* the next view will tell */
    }
  }

  async advanceNight() {
    const r = await this.pool.relay(this.contract, 'advance_night', {}, ADVANCE_GAS, { attempts: 3 })
    this.record('advance_night', r)
    if (r.failure) throw new FriendlyError('The night would not end. Trying again shortly.', new Error(r.failure))
    return r.value
  }
}

// ---- the action queue ---------------------------------------------------------------------------

/**
 * Collects the player's taps into one `act` per flush. One call in flight at a time, so nonces never
 * overtake each other. `onFlush(outcome, actions)` and `onError(err, actions)` report back.
 */
export class ActionQueue {
  constructor(client, { delay = 900, onFlush, onError, onPending } = {}) {
    this.client = client
    this.delay = delay
    this.pending = []
    this.inflight = null
    this.timer = null
    this.onFlush = onFlush
    this.onError = onError
    this.onPending = onPending
  }

  get busy() {
    return !!this.inflight || this.pending.length > 0
  }

  push(...actions) {
    this.pending = coalesce([...this.pending, ...actions], 64)
    this.onPending?.(this.pending)
    this.schedule()
  }

  schedule(delay = this.delay) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), delay)
  }

  /** Sends what is pending now. Resolves when that batch (and only that batch) is done. */
  async flush() {
    clearTimeout(this.timer)
    if (this.inflight) return this.inflight.then(() => (this.pending.length ? this.flush() : undefined))
    if (!this.pending.length) return
    const all = coalesce(this.pending, 64)
    const batch = all.slice(0, 16)
    this.pending = all.slice(16)
    this.onPending?.(this.pending)
    this.inflight = (async () => {
      try {
        const out = await this.client.act(batch)
        this.onFlush?.(out, batch)
      } catch (e) {
        this.onError?.(e, batch)
      } finally {
        this.inflight = null
      }
    })()
    await this.inflight
    if (this.pending.length) this.schedule(200)
  }
}

export { CONTRACT, GAS_ACCOUNT, RPC_HOSTS, nearPublicKey }

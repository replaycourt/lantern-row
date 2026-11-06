// Minimal NEAR transaction signing and RPC with only Node's standard library (Node 20+).
// Used by the testnet scripts. A browser client would do the same with any ed25519 library.
import crypto from 'node:crypto'

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function b58encode(bytes) {
  let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'))
  let out = ''
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = '1' + out
  }
  return out
}

export function b58decode(s) {
  let n = 0n
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c))
  let hex = n.toString(16)
  if (hex.length % 2) hex = '0' + hex
  const body = Buffer.from(n === 0n ? '' : hex, 'hex')
  const zeros = [...s].findIndex((c) => c !== '1')
  return Buffer.concat([Buffer.alloc(zeros < 0 ? s.length : zeros), body])
}

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export function keyFromSeed(seed) {
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' })
  const publicKey = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)
  return { privateKey, publicKey, seed }
}

export function newKey() {
  return keyFromSeed(crypto.randomBytes(32))
}

/** Reads a NEAR key string "ed25519:<base58 of seed + public key>". */
export function keyFromNearString(s) {
  return keyFromSeed(b58decode(s.replace('ed25519:', '')).subarray(0, 32))
}

export const sign = (key, msg) => crypto.sign(null, msg, key.privateKey)
export const nearPublicKey = (key) => 'ed25519:' + b58encode(key.publicKey)
export const hex = (bytes) => Buffer.from(bytes).toString('hex')

// ---- borsh, just the parts a function call needs ------------------------------------------------

const u8 = (n) => Buffer.from([n])
const u32 = (n) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}
const u64 = (n) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b
}
const u128 = (n) => Buffer.concat([u64(BigInt(n) & 0xffffffffffffffffn), u64(BigInt(n) >> 64n)])
const str = (s) => {
  const b = Buffer.from(s, 'utf8')
  return Buffer.concat([u32(b.length), b])
}

function encodeTx({ signerId, key, nonce, receiverId, blockHash, action }) {
  return Buffer.concat([
    str(signerId),
    u8(0), key.publicKey,
    u64(nonce),
    str(receiverId),
    blockHash,
    u32(1), // one action
    action,
  ])
}

function functionCallAction({ method, args, gas, deposit }) {
  const argBytes = Buffer.from(JSON.stringify(args), 'utf8')
  return Buffer.concat([u8(2), str(method), u32(argBytes.length), argBytes, u64(gas), u128(deposit)])
}

const transferAction = (deposit) => Buffer.concat([u8(3), u128(deposit)])

// ---- RPC ----------------------------------------------------------------------------------------

// NEAR_RPC pins one host. Otherwise the public testnet hosts the web client uses, in turn: a rate
// limit (HTTP 429) or a network failure moves to the next one.
const HOSTS = process.env.NEAR_RPC ? [process.env.NEAR_RPC] : ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org']
let host = 0
export let RPC = HOSTS[0]

const rateLimited = (status, error) => status === 429 || /-429|rate limit/i.test(JSON.stringify(error ?? ''))

export async function rpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: '1', method, params }),
        signal: AbortSignal.timeout(60_000),
      })
      const j = await r.json().catch(() => ({ error: { status: r.status } }))
      if (rateLimited(r.status, j.error) && attempt < 6) {
        host = (host + 1) % HOSTS.length
        RPC = HOSTS[host]
        await new Promise((s) => setTimeout(s, 1000 * 2 ** Math.min(attempt, 4)))
        continue
      }
      if (j.error) {
        const retriable = /TIMEOUT|HANDLER|UNKNOWN_BLOCK/.test(JSON.stringify(j.error)) && attempt < 4
        if (retriable) {
          await new Promise((s) => setTimeout(s, 1500))
          continue
        }
        throw new Error(`rpc ${method}: ${JSON.stringify(j.error).slice(0, 400)}`)
      }
      return j.result
    } catch (e) {
      if (attempt >= 4 || String(e.message).startsWith('rpc ')) throw e
      host = (host + 1) % HOSTS.length
      RPC = HOSTS[host]
      await new Promise((s) => setTimeout(s, 1500))
    }
  }
}

export async function view(contract, method, args = {}) {
  const r = await rpc('query', {
    request_type: 'call_function',
    finality: 'optimistic',
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  })
  return JSON.parse(Buffer.from(r.result).toString('utf8'))
}

export class Signer {
  constructor(accountId, key) {
    this.accountId = accountId
    this.key = key
    this.nonce = null
  }

  async call(receiverId, method, args, { gas = 100_000_000_000_000n, deposit = 0n } = {}) {
    return this.send(receiverId, functionCallAction({ method, args, gas, deposit }))
  }

  /** Sends NEAR. To an implicit account that does not exist yet, this creates it. */
  async transfer(receiverId, yocto) {
    return this.send(receiverId, transferAction(yocto))
  }

  async send(receiverId, action) {
    if (this.nonce === null) {
      const k = await rpc('query', {
        request_type: 'view_access_key',
        finality: 'optimistic',
        account_id: this.accountId,
        public_key: nearPublicKey(this.key),
      })
      this.nonce = BigInt(k.nonce)
    }
    this.nonce += 1n
    const block = await rpc('block', { finality: 'final' })
    const tx = encodeTx({ signerId: this.accountId, key: this.key, nonce: this.nonce, receiverId, blockHash: b58decode(block.header.hash), action })
    const digest = crypto.createHash('sha256').update(tx).digest()
    const signed = Buffer.concat([tx, u8(0), sign(this.key, digest)])
    const res = await rpc('send_tx', { signed_tx_base64: signed.toString('base64'), wait_until: 'EXECUTED_OPTIMISTIC' })
    return summarise(res)
  }
}

export function summarise(res) {
  const outcomes = [res.transaction_outcome, ...res.receipts_outcome]
  const gas = outcomes.reduce((n, o) => n + o.outcome.gas_burnt, 0)
  // NEAR burnt by the whole transaction (all outcomes), from the chain's own tokens_burnt.
  const near = Number(outcomes.reduce((n, o) => n + BigInt(o.outcome.tokens_burnt ?? 0), 0n)) / 1e24
  // The receipt that ran the contract: the first after the transaction itself.
  const contractGas = res.receipts_outcome[0]?.outcome.gas_burnt ?? 0
  const failure = res.status.Failure ? JSON.stringify(res.status.Failure) : null
  let value = null
  if (res.status.SuccessValue !== undefined && res.status.SuccessValue !== '') {
    try {
      value = JSON.parse(Buffer.from(res.status.SuccessValue, 'base64').toString('utf8'))
    } catch {
      value = res.status.SuccessValue
    }
  }
  return { hash: res.transaction.hash, gas, near, contractGas, failure, value, logs:res.receipts_outcome.flatMap((o) => o.outcome.logs) }
}

export const tgas = (g) => (g / 1e12).toFixed(2)

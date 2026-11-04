import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import * as N from '../js/near.js'
import { GasPool, ActionQueue, loadOrCreateIdentity } from '../js/chain.js'

test('base58 round-trips and matches a known NEAR key', () => {
  const bytes = new Uint8Array([0, 0, 7, 255, 1, 2, 3, 128])
  assert.deepEqual([...N.b58decode(N.b58encode(bytes))], [...bytes])
  // the public key of a key string: last 32 bytes of the decoded 64
  const full = N.b58decode('XhAZCfyUyFitrA4fn4wE1SUjYwiEHNUYGvC55wtg9XpzSBxZAc3LdugarBMJrcCgWHsPZhhiGnJzRnwrzKp7J4e')
  assert.equal(full.length, 64)
  assert.equal(N.b58encode(full.slice(32)), '8BDq5iW9pxqGia2bQAvRZKvG4WHQrt2YSqzEjLiy1W62')
  assert.throws(() => N.b58decode('0OIl'))
})

test('hex and base64 helpers', () => {
  assert.equal(N.hex(new Uint8Array([0, 15, 255])), '000fff')
  assert.deepEqual([...N.unhex('000fff')], [0, 15, 255])
  const b = new Uint8Array([1, 2, 3, 250])
  assert.deepEqual([...N.unbase64(N.base64(b))], [...b])
})

test('WebCrypto Ed25519: new key, rebuild from seed, sign, verify, implicit account', async () => {
  assert.ok(await N.ed25519Supported())
  const k = await N.newKey()
  assert.equal(k.seed.length, 32)
  assert.equal(k.publicKey.length, 32)
  const msg = N.utf8('lantern-row:v1:lantern-row.testnet:1:[]')
  const sig = await N.sign(k, msg)
  assert.equal(sig.length, 64)
  const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), k.publicKey]), format: 'der', type: 'spki' })
  assert.ok(crypto.verify(null, msg, pub, sig))
  const again = await N.keyFromSeed(k.seed, k.publicKey)
  const sig2 = await N.sign(again, msg)
  assert.ok(crypto.verify(null, msg, pub, sig2))
  assert.match(N.implicitAccount(k), /^[0-9a-f]{64}$/)
  assert.equal(N.nearPublicKey(k), 'ed25519:' + N.b58encode(k.publicKey))
})

test('keyFromNearString reads the seed and public key of a NEAR key string', async () => {
  const k = await N.newKey()
  const s = 'ed25519:' + N.b58encode(N.concat(k.seed, k.publicKey))
  const back = await N.keyFromNearString(s)
  assert.deepEqual([...back.publicKey], [...k.publicKey])
  const sig = await N.sign(back, N.utf8('x'))
  assert.equal(sig.length, 64)
})

test('borsh transaction encoding has the expected layout', () => {
  const pk = new Uint8Array(32).fill(7)
  const action = N.functionCallAction({ method: 'act', args: { a: 1 }, gas: 20_000_000_000_000n, deposit: 0n })
  // enum tag 2, method string, args, gas u64, deposit u128
  assert.equal(action[0], 2)
  assert.deepEqual([...action.slice(1, 5)], [3, 0, 0, 0])
  assert.equal(new TextDecoder().decode(action.slice(5, 8)), 'act')
  const argLen = new DataView(action.buffer).getUint32(8, true)
  assert.equal(argLen, 7)
  assert.equal(action.length, 1 + 4 + 3 + 4 + 7 + 8 + 16)
  const tx = N.encodeTx({ signerId: 'g.testnet', publicKey: pk, nonce: 5n, receiverId: 'c.testnet', blockHash: new Uint8Array(32), actions: [action] })
  assert.equal(tx.length, 4 + 9 + 1 + 32 + 8 + 4 + 9 + 32 + 4 + action.length)
  assert.equal(tx[4 + 9], 0, 'key type ed25519')
  assert.equal(tx[4 + 9 + 1 + 32], 5, 'nonce little-endian')
})

test('signTx appends a signature over the sha256 of the transaction', async () => {
  const k = await N.newKey()
  const tx = N.encodeTx({ signerId: 'g.testnet', publicKey: k.publicKey, nonce: 1n, receiverId: 'c.testnet', blockHash: new Uint8Array(32), actions: [] })
  const signed = N.unbase64(await N.signTx(k, tx))
  assert.equal(signed.length, tx.length + 1 + 64)
  assert.equal(signed[tx.length], 0)
  const digest = crypto.createHash('sha256').update(tx).digest()
  const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), k.publicKey]), format: 'der', type: 'spki' })
  assert.ok(crypto.verify(null, digest, pub, signed.slice(tx.length + 1)))
})

test('summarise reads SuccessValue and sums gas', () => {
  const res = {
    transaction: { hash: 'H' },
    transaction_outcome: { outcome: { gas_burnt: 1 } },
    receipts_outcome: [{ outcome: { gas_burnt: 2, logs: [] } }],
    status: { SuccessValue: Buffer.from('{"advanced":1}').toString('base64') },
  }
  const s = N.summarise(res)
  assert.equal(s.hash, 'H')
  assert.equal(s.gas, 3)
  assert.deepEqual(s.value, { advanced: 1 })
  assert.equal(s.failure, null)
  assert.ok(N.summarise({ ...res, status: { Failure: { x: 1 } } }).failure)
})

test('RpcError classifies NEAR errors', () => {
  assert.ok(new N.RpcError('x', { cause: { name: 'TIMEOUT_ERROR' } }).transient)
  assert.ok(new N.RpcError('x', { data: { TxExecutionError: { InvalidTxError: { InvalidNonce: {} } } } }).invalidNonce)
  assert.ok(new N.RpcError('x', { data: 'NotEnoughAllowance' }).noAllowance)
  assert.ok(new N.RpcError('x', { data: 'Expired' }).expired)
  assert.ok(!new N.RpcError('x', { data: 'something else' }).transient)
})

function fakeRpc(script) {
  // script: array of responses per JSON-RPC method, in order
  const calls = []
  return {
    calls,
    fetch: async (host, { body }) => {
      const req = JSON.parse(body)
      calls.push(req.method)
      const next = script[req.method]?.shift()
      if (next instanceof Error) throw next
      return { ok: true, status: 200, json: async () => next ?? { error: { name: 'NO_SCRIPT', method: req.method } } }
    },
  }
}

test('Rpc falls over to the fallback host on network failure', async () => {
  const f = fakeRpc({ block: [new TypeError('Failed to fetch'), { result: { header: { hash: '11111111111111111111111111111111' } } }] })
  const rpc = new N.Rpc(['https://a', 'https://b'], { fetchImpl: f.fetch })
  let switched = null
  rpc.onHostChange = (h) => (switched = h)
  const hash = await rpc.blockHash()
  assert.equal(hash.length, 32)
  assert.equal(switched, 'https://b')
  assert.equal(rpc.host, 'https://b')
})

test('Rpc view decodes the result bytes', async () => {
  const bytes = [...Buffer.from(JSON.stringify({ night: 3 }))]
  const f = fakeRpc({ query: [{ result: { result: bytes } }] })
  const rpc = new N.Rpc(['https://a'], { fetchImpl: f.fetch })
  assert.deepEqual(await rpc.view('c', 'world'), { night: 3 })
})

test('GasPool rotates to another key when one has no allowance, and re-reads a nonce on InvalidNonce', async () => {
  const k1 = await N.newKey()
  const k2 = await N.newKey()
  const keyStr = (k) => 'ed25519:' + N.b58encode(N.concat(k.seed, k.publicKey))
  const ok = { result: { transaction: { hash: 'T' }, transaction_outcome: { outcome: { gas_burnt: 1 } }, receipts_outcome: [], status: { SuccessValue: '' } } }
  const f = fakeRpc({
    query: [{ result: { nonce: 10 } }, { result: { nonce: 20 } }, { result: { nonce: 30 } }],
    block: Array.from({ length: 6 }, () => ({ result: { header: { hash: '11111111111111111111111111111111' } } })),
    send_tx: [{ error: { data: 'NotEnoughAllowance' } }, { error: { data: { InvalidNonce: {} } } }, ok],
  })
  const rpc = new N.Rpc(['https://a'], { fetchImpl: f.fetch })
  const pool = new GasPool(rpc, [{ public_key: N.nearPublicKey(k1), private_key: keyStr(k1) }, { public_key: N.nearPublicKey(k2), private_key: keyStr(k2) }], 'gas.testnet')
  pool.cursor = 0
  const r = await pool.relay('c.testnet', 'advance_night', {}, 1n)
  assert.equal(r.hash, 'T')
  assert.equal(pool.alive().length, 1, 'the key without allowance is retired')
  assert.equal(f.calls.filter((c) => c === 'send_tx').length, 3)
})

test('GasPool looks a timed-out transaction up by hash instead of sending it twice', async () => {
  const k1 = await N.newKey()
  const keyStr = (k) => 'ed25519:' + N.b58encode(N.concat(k.seed, k.publicKey))
  const landed = { result: { transaction: { hash: 'T2' }, transaction_outcome: { outcome: { gas_burnt: 1 } }, receipts_outcome: [], status: { SuccessValue: '' } } }
  const f = fakeRpc({
    query: [{ result: { nonce: 10 } }],
    block: [{ result: { header: { hash: '11111111111111111111111111111111' } } }],
    send_tx: [{ error: { name: 'REQUEST_TIMEOUT', cause: { name: 'TIMEOUT_ERROR' } } }],
    tx: [{ error: { cause: { name: 'UNKNOWN_TRANSACTION' } } }, landed],
  })
  const rpc = new N.Rpc(['https://a'], { fetchImpl: f.fetch })
  const pool = new GasPool(rpc, [{ public_key: N.nearPublicKey(k1), private_key: keyStr(k1) }], 'gas.testnet')
  const t0 = Date.now()
  const r = await pool.relay('c.testnet', 'act', {}, 1n)
  assert.equal(r.hash, 'T2')
  assert.equal(f.calls.filter((c) => c === 'send_tx').length, 1, 'sent once')
  assert.equal(f.calls.filter((c) => c === 'tx').length, 2, 'asked twice for the status')
  assert.ok(Date.now() - t0 >= 2000, 'waited between lookups')
  // an http 408 counts as a timeout too
  assert.ok(new N.RpcError('http 408', { http: 408, text: 'http 408' }).transient)
  assert.ok(new N.RpcError('x', { cause: { name: 'UNKNOWN_TRANSACTION' } }).unknownTx)
})

test('txHash is the base58 sha256 of the unsigned transaction', async () => {
  const tx = N.utf8('hello')
  const h = await N.txHash(tx)
  assert.equal(h, N.b58encode(crypto.createHash('sha256').update(tx).digest()))
})

test('GasPool gives a friendly error when every key is dead', async () => {
  const rpc = new N.Rpc(['https://a'], { fetchImpl: fakeRpc({}).fetch })
  const pool = new GasPool(rpc, [], 'gas.testnet')
  await assert.rejects(pool.relay('c', 'act', {}, 1n), /gas pool has run dry/)
})

test('ActionQueue batches taps into one act and keeps one call in flight', async () => {
  const sent = []
  const fake = {
    act: async (actions) => {
      sent.push(actions)
      await new Promise((r) => setTimeout(r, 20))
      return { applied: actions.length, total: actions.length }
    },
  }
  const flushed = []
  const q = new ActionQueue(fake, { delay: 10, onFlush: (out, batch) => flushed.push(batch.length) })
  q.push({ price: { stall: 1, good: 0, price: 50 } })
  q.push({ price: { stall: 1, good: 0, price: 60 } })
  q.push({ buy: { stall: 1, good: 1, qty: 1, max_cost: 50 } })
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0], [{ price: { stall: 1, good: 0, price: 60 } }, { buy: { stall: 1, good: 1, qty: 1, max_cost: 50 } }])
  assert.deepEqual(flushed, [2])
  assert.equal(q.busy, false)
})

test('ActionQueue reports errors and goes on', async () => {
  const fake = { act: async () => { throw new Error('boom') } }
  const errors = []
  const q = new ActionQueue(fake, { delay: 5, onError: (e) => errors.push(e.message) })
  q.push({ list: { stall: 1, price: 5 } })
  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(errors, ['boom'])
  assert.equal(q.busy, false)
})

test('identity is created once and loaded again from storage', async () => {
  const store = new Map()
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }
  const a = await loadOrCreateIdentity(storage)
  assert.ok(a.fresh)
  const b = await loadOrCreateIdentity(storage)
  assert.ok(!b.fresh)
  assert.equal(a.account, b.account)
  const sig1 = await N.sign(a.key, N.utf8('m'))
  const sig2 = await N.sign(b.key, N.utf8('m'))
  assert.deepEqual([...sig1], [...sig2], 'the rebuilt key signs identically')
})

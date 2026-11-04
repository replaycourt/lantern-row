#!/usr/bin/env node
// Adds a pool of function-call keys to the gas account, limited to `act` and `advance_night` on the
// contract and capped by an allowance, and writes them to the git-ignored .secrets/gas-pool.json.
//   node scripts/setup-gas-pool.mjs <gas account> <contract> <how many> [allowance in NEAR]
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { b58encode, nearPublicKey, newKey } from './near-lite.mjs'

const [gasAccount, contract, count, allowance = '1'] = process.argv.slice(2)
if (!gasAccount || !contract || !count) {
  console.error('usage: setup-gas-pool.mjs <gas account> <contract> <how many> [allowance in NEAR]')
  process.exit(64)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, '.secrets', 'gas-pool.json')
mkdirSync(dirname(out), { recursive: true })
const pool = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : []

for (let i = 0; i < Number(count); i++) {
  const key = newKey()
  const publicKey = nearPublicKey(key)
  execFileSync('near', [
    'account', 'add-key', gasAccount,
    'grant-function-call-access',
    '--allowance', `${allowance} NEAR`,
    '--contract-account-id', contract,
    '--function-names', 'act, advance_night',
    'use-manually-provided-public-key', publicKey,
    'network-config', 'testnet',
    'sign-with-legacy-keychain',
    'send',
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  pool.push({
    account: gasAccount,
    contract,
    public_key: publicKey,
    private_key: 'ed25519:' + b58encode(Buffer.concat([key.seed, key.publicKey])),
  })
  writeFileSync(out, JSON.stringify(pool, null, 2) + '\n', { mode: 0o600 })
  console.log(`added ${publicKey}`)
}

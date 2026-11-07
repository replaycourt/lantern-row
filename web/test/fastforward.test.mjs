// The fast-forward sheet's numbers, and the recording it plays (web/js/fast-forward-data.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { priceIndex, worthBoard } from '../js/fastforward.js'
import data from '../js/fast-forward-data.js'

test('what villagers paid becomes a smoothed index, skipping nights without a sale', () => {
  const nights = [{ paid: [0, 50] }, { paid: [80, 70] }, { paid: [40, 0] }, { paid: [60, 90] }]
  assert.deepEqual(priceIndex(nights, ['tea', 'oil'], 2), [
    [null, null, 100, 83.33333333333333],
    [null, 100, 100, 133.33333333333334],
  ])
})

test('the worth board ranks the stalls of one night, richest first, with their names', () => {
  const d = { stalls: [{ id: 1, name: 'Kettle', npc: true }, { id: 7, name: 'Trader A', npc: false }], nights: [{ worth: [[1, 500], [7, 900], [9, 900]] }] }
  assert.deepEqual(
    worthBoard(d, 0).map((r) => [r.id, r.name, r.npc]),
    [
      [7, 'Trader A', false],
      [9, 'Stall 9', false],
      [1, 'Kettle', true],
    ],
  )
})

test('the recording has 300 nights, every one with all goods, and the tea glut shows in the price', () => {
  assert.equal(data.nights.length, 300)
  assert.deepEqual(data.goods, ['tea', 'lamp oil', 'dumplings', 'silk', 'charms'])
  for (const n of data.nights) {
    assert.equal(n.ask.length, 5)
    assert.equal(n.paid.length, 5)
    assert.equal(n.dock.length, 5)
    assert.ok(n.worth.length > 0)
  }
  // nights are consecutive
  data.nights.forEach((n, i) => i && assert.equal(n.n, data.nights[i - 1].n + 1))
  const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length
  const paid = (from, to) => mean(data.nights.filter((n) => n.n >= from && n.n < to && n.paid[0] > 0).map((n) => n.paid[0]))
  const before = paid(data.floodFrom - 60, data.floodFrom)
  const after = paid(data.floodFrom + 60, Infinity)
  assert.ok(after < before * 0.95, `what villagers pay for tea falls under the flood: ${after} vs ${before}`)
  // the stalls the recording names include the four player bots and the flooder
  const names = data.stalls.map((s) => s.name)
  for (const n of ['Trader A', 'Trader B', 'Restocker', 'Watcher', 'Tea flooder']) assert.ok(names.includes(n), n)
})

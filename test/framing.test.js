'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { encodeFrame, FrameDecoder } = require('../src/core/framing')

test('une trame est décodée telle quelle, même découpée octet par octet', () => {
  const frames = []
  const decoder = new FrameDecoder((h, body) => frames.push({ h, body: Buffer.from(body) }))
  const a = encodeFrame({ t: 'hello', name: 'Alice' })
  const b = encodeFrame({ t: 'fdata', o: 0 }, Buffer.from([1, 2, 3, 4]))
  const all = Buffer.concat([a, b])
  for (let i = 0; i < all.length; i++) decoder.push(all.subarray(i, i + 1))
  assert.equal(frames.length, 2)
  assert.deepEqual(frames[0].h, { t: 'hello', name: 'Alice' })
  assert.equal(frames[0].body.length, 0)
  assert.deepEqual(frames[1].h, { t: 'fdata', o: 0 })
  assert.deepEqual([...frames[1].body], [1, 2, 3, 4])
})

test('plusieurs trames dans un même morceau', () => {
  const frames = []
  const decoder = new FrameDecoder((h) => frames.push(h))
  decoder.push(Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 }), encodeFrame({ n: 3 })]))
  assert.deepEqual(frames, [{ n: 1 }, { n: 2 }, { n: 3 }])
})

test('une trame trop grande ou invalide est rejetée', () => {
  const decoder = new FrameDecoder(() => {}, 1024)
  const big = Buffer.alloc(4)
  big.writeUInt32BE(5000, 0)
  assert.throws(() => decoder.push(big))

  const bad = new FrameDecoder(() => {})
  const notObject = encodeFrame([1, 2])
  assert.throws(() => bad.push(notObject))
})

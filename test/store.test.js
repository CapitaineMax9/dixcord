'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const cr = require('../src/core/crypto')
const { createEvent } = require('../src/core/events')
const { ServerStore } = require('../src/core/store')

const alice = cr.keyPairFromSeed(Buffer.alloc(32, 1))
const bob = cr.keyPairFromSeed(Buffer.alloc(32, 2))
const serverId = cr.serverIdFromSecret(Buffer.alloc(32, 3))
const general = '0000000000000001'
const A = alice.publicKey.toString('hex')
const B = bob.publicKey.toString('hex')

function ev (keyPair, seq, type, body, ts = 1000 + seq) {
  return createEvent({ keyPair, serverId, seq, type, body, ts })
}

function tmpStore (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dixcord-store-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new ServerStore(dir, serverId)
  store.open()
  return store
}

test('ajout, déduplication et vecteur contigu', (t) => {
  const store = tmpStore(t)
  assert.equal(store.add(ev(alice, 1, 'msg', { channel: general, text: 'un' })), true)
  assert.equal(store.add(ev(alice, 1, 'msg', { channel: general, text: 'un' })), false)
  store.add(ev(alice, 3, 'msg', { channel: general, text: 'trois' }))
  assert.deepEqual(store.vector(), { [A]: 1 })
  assert.equal(store.nextSeq(A), 4)
  store.add(ev(alice, 2, 'msg', { channel: general, text: 'deux' }))
  assert.deepEqual(store.vector(), { [A]: 3 })
  assert.deepEqual(store.messages(general).messages.map((m) => m.body.text), ['un', 'deux', 'trois'])
})

test('eventsAfter renvoie seulement ce qui manque', (t) => {
  const store = tmpStore(t)
  for (let i = 1; i <= 3; i++) store.add(ev(alice, i, 'msg', { channel: general, text: 'a' + i }))
  for (let i = 1; i <= 2; i++) store.add(ev(bob, i, 'msg', { channel: general, text: 'b' + i }))
  const missing = store.eventsAfter({ [A]: 2 })
  assert.deepEqual(missing.map((e) => e.body.text).sort(), ['a3', 'b1', 'b2'])
  assert.equal(store.eventsAfter({ [A]: 3, [B]: 2 }).length, 0)
})

test('état des salons, du nom du serveur et des pseudos', (t) => {
  const store = tmpStore(t)
  store.add(ev(alice, 1, 'server', { name: 'Avant' }))
  store.add(ev(alice, 2, 'channel', { id: general, name: 'général', kind: 'text' }))
  store.add(ev(alice, 3, 'channel', { id: '0000000000000002', name: 'Vocal', kind: 'voice' }))
  store.add(ev(bob, 1, 'server', { name: 'Après' }, 5000))
  store.add(ev(bob, 2, 'channel', { id: general, name: 'discussion', kind: 'text' }, 5001))
  store.add(ev(bob, 3, 'channel', { id: '0000000000000002', name: 'Vocal', kind: 'voice', deleted: true }, 5002))
  store.add(ev(bob, 4, 'profile', { name: 'Bob' }, 5003))
  assert.equal(store.name, 'Après')
  assert.deepEqual(store.channels(), [{ id: general, name: 'discussion', kind: 'text' }])
  assert.equal(store.profileName(B), 'Bob')
  assert.equal(store.profileName(A), null)
})

test('l’historique est rechargé depuis le disque, même avec une ligne tronquée', (t) => {
  const store = tmpStore(t)
  store.add(ev(alice, 1, 'msg', { channel: general, text: 'persistant' }))
  store.close()
  fs.appendFileSync(store.file, '{"v":1,"serv')
  const again = new ServerStore(store.dir, serverId)
  again.open()
  t.after(() => again.close())
  assert.equal(again.messages(general).messages[0].body.text, 'persistant')
  assert.equal(again.nextSeq(A), 2)
})

test('pagination des messages', (t) => {
  const store = tmpStore(t)
  for (let i = 1; i <= 10; i++) store.add(ev(alice, i, 'msg', { channel: general, text: String(i) }))
  const last = store.messages(general, { limit: 4 })
  assert.deepEqual(last.messages.map((m) => m.body.text), ['7', '8', '9', '10'])
  assert.equal(last.hasMore, true)
  const before = store.messages(general, { limit: 4, beforeId: A + ':7' })
  assert.deepEqual(before.messages.map((m) => m.body.text), ['3', '4', '5', '6'])
  const first = store.messages(general, { limit: 4, beforeId: A + ':3' })
  assert.deepEqual(first.messages.map((m) => m.body.text), ['1', '2'])
  assert.equal(first.hasMore, false)
})

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const cr = require('../src/core/crypto')
const { createEvent, verifyEvent, eventId } = require('../src/core/events')
const { encodeInvite, decodeInvite } = require('../src/core/invite')

const keyPair = cr.keyPairFromSeed(Buffer.alloc(32, 1))
const serverId = cr.serverIdFromSecret(Buffer.alloc(32, 2))
const channel = 'aaaaaaaaaaaaaaaa'

function msg (text, seq = 1) {
  return createEvent({ keyPair, serverId, seq, type: 'msg', body: { channel, text } })
}

test('un événement signé est vérifiable', () => {
  const ev = msg('Salut !')
  assert.equal(verifyEvent(ev, serverId), true)
  assert.equal(eventId(ev), keyPair.publicKey.toString('hex') + ':1')
})

test('toute modification invalide la signature', () => {
  const ev = msg('Salut !')
  assert.equal(verifyEvent({ ...ev, body: { ...ev.body, text: 'Salut ?' } }, serverId), false)
  assert.equal(verifyEvent({ ...ev, ts: ev.ts + 1 }, serverId), false)
  assert.equal(verifyEvent({ ...ev, seq: 2 }, serverId), false)
  const other = cr.keyPairFromSeed(Buffer.alloc(32, 9)).publicKey.toString('hex')
  assert.equal(verifyEvent({ ...ev, author: other }, serverId), false)
})

test('un événement d’un autre serveur est refusé', () => {
  const ev = msg('Salut !')
  const otherServer = cr.serverIdFromSecret(Buffer.alloc(32, 3))
  assert.equal(verifyEvent(ev, otherServer), false)
})

test('les champs inconnus ou mal formés sont refusés', () => {
  const ev = msg('Salut !')
  assert.equal(verifyEvent({ ...ev, extra: 1 }, serverId), false)
  assert.throws(() => createEvent({ keyPair, serverId, seq: 1, type: 'msg', body: { channel, text: '   ' } }))
  assert.throws(() => createEvent({ keyPair, serverId, seq: 1, type: 'msg', body: { channel: 'xx', text: 'a' } }))
  assert.throws(() => createEvent({ keyPair, serverId, seq: 0, type: 'msg', body: { channel, text: 'a' } }))
  assert.throws(() => createEvent({ keyPair, serverId, seq: 1, type: 'profile', body: { name: 'a\nb' } }))
  assert.throws(() => createEvent({ keyPair, serverId, seq: 1, type: 'pirate', body: {} }))
})

test('les preuves d’authentification sont liées à la session et à l’émetteur', () => {
  const secret = Buffer.alloc(32, 5)
  const hh = Buffer.alloc(32, 6)
  const a = Buffer.alloc(32, 7)
  const b = Buffer.alloc(32, 8)
  assert.equal(cr.authProof(secret, hh, a), cr.authProof(secret, hh, a))
  assert.notEqual(cr.authProof(secret, hh, a), cr.authProof(secret, hh, b)) // pas de renvoi à l'expéditeur
  assert.notEqual(cr.authProof(secret, hh, a), cr.authProof(secret, Buffer.alloc(32, 1), a)) // pas de rejeu
  assert.notEqual(cr.authProof(secret, hh, a), cr.authProof(Buffer.alloc(32, 4), hh, a)) // mauvais secret
})

test('code d’invitation : aller-retour et rejet des codes invalides', () => {
  const secret = cr.randomBytes(32)
  const code = encodeInvite(secret, 'Les potes')
  assert.ok(code.startsWith('dixcord:'))
  const decoded = decodeInvite('  ' + code + '\n')
  assert.ok(decoded.secret.equals(secret))
  assert.equal(decoded.name, 'Les potes')
  assert.throws(() => decodeInvite('dixcord:n’importe quoi'))
  assert.throws(() => decodeInvite(''))
})

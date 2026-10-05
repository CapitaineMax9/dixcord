'use strict'

// Un code d'invitation contient le secret du serveur (et son nom pour
// l'afficher avant la première synchronisation). Quiconque possède ce code
// peut rejoindre le serveur : il se partage comme une clé.

const C = require('./constants')
const { isName } = require('./events')

const PREFIX = 'dixcord:'

function encodeInvite (secret, name) {
  const payload = { v: 1, k: secret.toString('hex') }
  if (name) payload.n = name
  return PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeInvite (code) {
  let s = String(code || '').trim()
  if (s.toLowerCase().startsWith(PREFIX)) s = s.slice(PREFIX.length)
  let payload
  try {
    payload = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
  } catch {
    throw new Error('Code d’invitation invalide')
  }
  if (!payload || payload.v !== 1 || typeof payload.k !== 'string' || !/^[0-9a-f]{64}$/.test(payload.k)) {
    throw new Error('Code d’invitation invalide')
  }
  const name = isName(payload.n, C.MAX_SERVER_NAME_LENGTH) ? payload.n : null
  return { secret: Buffer.from(payload.k, 'hex'), name }
}

module.exports = { encodeInvite, decodeInvite }

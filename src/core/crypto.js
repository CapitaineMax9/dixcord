'use strict'

const nodeCrypto = require('crypto')
const hc = require('hypercore-crypto')

function keyPairFromSeed (seed) {
  return hc.keyPair(seed)
}

function sign (message, secretKey) {
  return hc.sign(message, secretKey)
}

function verify (message, signature, publicKey) {
  try {
    return hc.verify(message, signature, publicKey)
  } catch {
    return false
  }
}

function randomBytes (n) {
  return nodeCrypto.randomBytes(n)
}

function randomHex (n) {
  return randomBytes(n).toString('hex')
}

function sha256 (...parts) {
  const h = nodeCrypto.createHash('sha256')
  for (const p of parts) h.update(p)
  return h.digest()
}

// Identifiant public d'un serveur : sert à étiqueter les événements.
function serverIdFromSecret (secret) {
  return sha256('dixcord/server-id/v1', secret).toString('hex')
}

// Sujet annoncé sur la DHT pour se retrouver entre membres d'un serveur.
function topicFromSecret (secret) {
  return sha256('dixcord/topic/v1', secret)
}

// Preuve qu'un pair connaît le secret d'un serveur, sans le révéler.
// Elle est liée à la session chiffrée (handshakeHash) et à la clé de
// l'émetteur, donc impossible à rejouer ou à renvoyer à son auteur.
function authProof (secret, handshakeHash, senderPublicKey) {
  return nodeCrypto
    .createHmac('sha256', secret)
    .update('dixcord/auth/v1')
    .update(handshakeHash)
    .update(senderPublicKey)
    .digest('hex')
}

module.exports = {
  keyPairFromSeed,
  sign,
  verify,
  randomBytes,
  randomHex,
  sha256,
  serverIdFromSecret,
  topicFromSecret,
  authProof
}

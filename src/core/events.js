'use strict'

// Toutes les données partagées d'un serveur (messages, salons, nom, pseudos)
// sont des « événements » signés par leur auteur. Chaque auteur numérote ses
// événements (seq = 1, 2, 3…) : l'identifiant d'un événement est
// « clé de l'auteur:seq ». Un pair peut donc relayer l'historique d'un autre
// sans pouvoir le falsifier.

const C = require('./constants')
const { canonical } = require('./canonical')
const { sign, verify } = require('./crypto')

const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
const CHANNEL_ID = /^[0-9a-f]{16}$/
const MIME = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

const EVENT_KEYS = ['author', 'body', 'seq', 'server', 'sig', 'ts', 'type', 'v']

function isPlainObject (x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function hasOnlyKeys (obj, allowed) {
  return Object.keys(obj).every((k) => allowed.includes(k))
}

function isName (s, max) {
  return typeof s === 'string' && s.trim().length > 0 && s.length <= max && !CONTROL_CHARS.test(s)
}

function validateFile (f) {
  if (!isPlainObject(f) || !hasOnlyKeys(f, ['hash', 'mime', 'name', 'size'])) return 'pièce jointe invalide'
  if (typeof f.hash !== 'string' || !HEX64.test(f.hash)) return 'empreinte de fichier invalide'
  if (!isName(f.name, C.MAX_FILE_NAME_LENGTH)) return 'nom de fichier invalide'
  if (!Number.isSafeInteger(f.size) || f.size < 0 || f.size > C.MAX_FILE_SIZE) return 'taille de fichier invalide'
  if (typeof f.mime !== 'string' || f.mime.length > 100 || !MIME.test(f.mime)) return 'type de fichier invalide'
  return null
}

function validateBody (type, body) {
  if (!isPlainObject(body)) return 'contenu invalide'
  switch (type) {
    case 'msg': {
      if (!hasOnlyKeys(body, ['channel', 'files', 'text'])) return 'message invalide'
      if (typeof body.channel !== 'string' || !CHANNEL_ID.test(body.channel)) return 'salon invalide'
      if (typeof body.text !== 'string' || body.text.length > C.MAX_TEXT_LENGTH) return 'texte invalide'
      const files = body.files === undefined ? [] : body.files
      if (!Array.isArray(files) || files.length > C.MAX_FILES_PER_MESSAGE) return 'pièces jointes invalides'
      for (const f of files) {
        const err = validateFile(f)
        if (err) return err
      }
      if (body.text.trim().length === 0 && files.length === 0) return 'message vide'
      return null
    }
    case 'channel':
      if (!hasOnlyKeys(body, ['deleted', 'id', 'kind', 'name'])) return 'salon invalide'
      if (typeof body.id !== 'string' || !CHANNEL_ID.test(body.id)) return 'identifiant de salon invalide'
      if (!isName(body.name, C.MAX_CHANNEL_NAME_LENGTH)) return 'nom de salon invalide'
      if (body.kind !== 'text' && body.kind !== 'voice') return 'type de salon invalide'
      if (body.deleted !== undefined && body.deleted !== true) return 'salon invalide'
      return null
    case 'server':
      if (!hasOnlyKeys(body, ['name'])) return 'serveur invalide'
      if (!isName(body.name, C.MAX_SERVER_NAME_LENGTH)) return 'nom de serveur invalide'
      return null
    case 'profile':
      if (!hasOnlyKeys(body, ['name'])) return 'profil invalide'
      if (!isName(body.name, C.MAX_USER_NAME_LENGTH)) return 'pseudo invalide'
      return null
    default:
      return 'type d’événement inconnu'
  }
}

// Renvoie un message d'erreur, ou null si la structure est valide.
function validateShape (ev) {
  if (!isPlainObject(ev)) return 'événement invalide'
  const keys = Object.keys(ev).sort()
  if (keys.length !== EVENT_KEYS.length || keys.some((k, i) => k !== EVENT_KEYS[i])) return 'champs invalides'
  if (ev.v !== 1) return 'version inconnue'
  if (typeof ev.server !== 'string' || !HEX64.test(ev.server)) return 'serveur invalide'
  if (typeof ev.author !== 'string' || !HEX64.test(ev.author)) return 'auteur invalide'
  if (!Number.isSafeInteger(ev.seq) || ev.seq < 1) return 'numéro de séquence invalide'
  if (!Number.isSafeInteger(ev.ts) || ev.ts < 0) return 'horodatage invalide'
  if (typeof ev.sig !== 'string' || !HEX128.test(ev.sig)) return 'signature invalide'
  return validateBody(ev.type, ev.body)
}

function signingPayload (ev) {
  const { sig, ...unsigned } = ev
  return Buffer.from('dixcord/event/v1\n' + canonical(unsigned), 'utf8')
}

function createEvent ({ keyPair, serverId, seq, type, body, ts = Date.now() }) {
  const ev = {
    v: 1,
    server: serverId,
    author: keyPair.publicKey.toString('hex'),
    seq,
    ts,
    type,
    body
  }
  const err = validateShape({ ...ev, sig: '0'.repeat(128) })
  if (err) throw new Error(err)
  ev.sig = sign(signingPayload(ev), keyPair.secretKey).toString('hex')
  if (Buffer.byteLength(JSON.stringify(ev)) > C.MAX_EVENT_SIZE) throw new Error('Message trop volumineux')
  return ev
}

function verifyEvent (ev, expectedServerId) {
  if (validateShape(ev)) return false
  if (ev.server !== expectedServerId) return false
  if (Buffer.byteLength(JSON.stringify(ev)) > C.MAX_EVENT_SIZE) return false
  return verify(signingPayload(ev), Buffer.from(ev.sig, 'hex'), Buffer.from(ev.author, 'hex'))
}

function eventId (ev) {
  return ev.author + ':' + ev.seq
}

// Ordre d'affichage stable, identique chez tous les pairs.
function compareEvents (a, b) {
  if (a.ts !== b.ts) return a.ts - b.ts
  if (a.author !== b.author) return a.author < b.author ? -1 : 1
  return a.seq - b.seq
}

module.exports = {
  HEX64,
  CHANNEL_ID,
  isName,
  validateShape,
  createEvent,
  verifyEvent,
  eventId,
  compareEvents
}

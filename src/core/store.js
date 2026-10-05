'use strict'

// Historique local d'un serveur : un journal d'événements signés en ajout
// seul (events.jsonl), rechargé en mémoire au démarrage.

const fs = require('fs')
const path = require('path')
const { validateShape, eventId, compareEvents } = require('./events')

class ServerStore {
  constructor (dir, serverId) {
    this.dir = dir
    this.serverId = serverId
    this.file = path.join(dir, 'events.jsonl')
    this.fd = null

    this.events = new Map() // id -> événement
    this.authors = new Map() // auteur -> { seqs: Set, contiguous, max }
    this.messagesByChannel = new Map() // salon -> messages triés
    this.channelStates = new Map() // salon -> { id, kind, name, deleted, first, latest }
    this.latestServerEvent = null
    this.profiles = new Map() // auteur -> dernier événement de profil
    this.fileInfos = new Map() // empreinte -> { name, size, mime }
  }

  open () {
    fs.mkdirSync(this.dir, { recursive: true })
    if (fs.existsSync(this.file)) {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n')
      for (const line of lines) {
        if (!line) continue
        let ev
        try {
          ev = JSON.parse(line)
        } catch {
          continue // ligne tronquée (arrêt brutal pendant une écriture)
        }
        if (validateShape(ev) || ev.server !== this.serverId) continue
        this._index(ev)
      }
    }
    this.fd = fs.openSync(this.file, 'a', 0o600)
  }

  close () {
    if (this.fd !== null) fs.closeSync(this.fd)
    this.fd = null
  }

  has (id) {
    return this.events.has(id)
  }

  // Ajoute un événement déjà vérifié. Renvoie false s'il était déjà connu.
  add (ev) {
    if (this.events.has(eventId(ev))) return false
    this._index(ev)
    if (this.fd !== null) fs.writeSync(this.fd, JSON.stringify(ev) + '\n')
    return true
  }

  _index (ev) {
    const id = eventId(ev)
    if (this.events.has(id)) return
    this.events.set(id, ev)

    let a = this.authors.get(ev.author)
    if (!a) {
      a = { seqs: new Set(), contiguous: 0, max: 0 }
      this.authors.set(ev.author, a)
    }
    a.seqs.add(ev.seq)
    if (ev.seq > a.max) a.max = ev.seq
    while (a.seqs.has(a.contiguous + 1)) a.contiguous++

    switch (ev.type) {
      case 'msg': {
        let list = this.messagesByChannel.get(ev.body.channel)
        if (!list) {
          list = []
          this.messagesByChannel.set(ev.body.channel, list)
        }
        insertSorted(list, ev)
        for (const f of ev.body.files || []) {
          if (!this.fileInfos.has(f.hash)) this.fileInfos.set(f.hash, { name: f.name, size: f.size, mime: f.mime })
        }
        break
      }
      case 'channel': {
        const b = ev.body
        const st = this.channelStates.get(b.id)
        if (!st) {
          this.channelStates.set(b.id, { id: b.id, kind: b.kind, name: b.name, deleted: !!b.deleted, first: ev, latest: ev })
          break
        }
        // Le type est fixé par la création, le reste par la dernière modification.
        if (compareEvents(ev, st.first) < 0) {
          st.first = ev
          st.kind = b.kind
        }
        if (compareEvents(ev, st.latest) > 0) {
          st.latest = ev
          st.name = b.name
          st.deleted = !!b.deleted
        }
        break
      }
      case 'server':
        if (!this.latestServerEvent || compareEvents(ev, this.latestServerEvent) > 0) this.latestServerEvent = ev
        break
      case 'profile': {
        const prev = this.profiles.get(ev.author)
        if (!prev || compareEvents(ev, prev) > 0) this.profiles.set(ev.author, ev)
        break
      }
    }
  }

  // Pour chaque auteur : le plus grand seq tel que 1..seq sont tous connus.
  vector () {
    const out = {}
    for (const [author, a] of this.authors) out[author] = a.contiguous
    return out
  }

  // Événements qu'un pair n'a pas, d'après son vecteur.
  eventsAfter (have) {
    const out = []
    for (const [author, a] of this.authors) {
      const known = Number.isSafeInteger(have[author]) ? have[author] : 0
      if (a.max <= known) continue
      const seqs = [...a.seqs].filter((s) => s > known).sort((x, y) => x - y)
      for (const s of seqs) out.push(this.events.get(author + ':' + s))
    }
    return out
  }

  nextSeq (author) {
    const a = this.authors.get(author)
    return (a ? a.max : 0) + 1
  }

  get name () {
    return this.latestServerEvent ? this.latestServerEvent.body.name : null
  }

  channel (id) {
    const st = this.channelStates.get(id)
    return st && !st.deleted ? { id: st.id, name: st.name, kind: st.kind } : null
  }

  channels () {
    return [...this.channelStates.values()]
      .filter((st) => !st.deleted)
      .sort((a, b) => compareEvents(a.first, b.first))
      .map((st) => ({ id: st.id, name: st.name, kind: st.kind }))
  }

  // Les `limit` derniers messages d'un salon, éventuellement avant `beforeId`.
  messages (channelId, { limit = 100, beforeId = null } = {}) {
    const list = this.messagesByChannel.get(channelId) || []
    let end = list.length
    if (beforeId) {
      const before = this.events.get(beforeId)
      if (before) end = lowerBound(list, before)
    }
    const start = Math.max(0, end - limit)
    return { messages: list.slice(start, end), hasMore: start > 0 }
  }

  profileName (author) {
    const p = this.profiles.get(author)
    return p ? p.body.name : null
  }

  authorKeys () {
    return [...this.authors.keys()]
  }

  fileInfo (hash) {
    return this.fileInfos.get(hash) || null
  }
}

function lowerBound (list, ev) {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (compareEvents(list[mid], ev) < 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

function insertSorted (list, ev) {
  // Cas courant : le message est le plus récent.
  if (list.length === 0 || compareEvents(list[list.length - 1], ev) <= 0) list.push(ev)
  else list.splice(lowerBound(list, ev), 0, ev)
}

module.exports = { ServerStore }

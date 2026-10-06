'use strict'

// Le « nœud » Dixcord : un client complet, sans serveur central.
//  - Hyperswarm (DHT publique) pour trouver les autres membres d'un serveur
//    et établir des connexions chiffrées de pair à pair (perçage de NAT).
//  - Une authentification par preuve de connaissance du secret du serveur.
//  - Un historique d'événements signés, synchronisé entre pairs.
//  - Le transfert de fichiers par morceaux, vérifiés par empreinte.
//  - Le relais des états vocaux et de la signalisation WebRTC.

const EventEmitter = require('events')
const fs = require('fs')
const path = require('path')
const Hyperswarm = require('hyperswarm')

const C = require('./constants')
const cr = require('./crypto')
const { createEvent, verifyEvent, eventId, isName, HEX64, CHANNEL_ID } = require('./events')
const { ServerStore } = require('./store')
const { FileStore } = require('./files')
const { encodeFrame, FrameDecoder } = require('./framing')
const { encodeInvite, decodeInvite } = require('./invite')
const { canonical } = require('./canonical')

const MAX_UPLOADS_PER_PEER = 4

class DixcordNode extends EventEmitter {
  constructor ({ storageDir, swarmOptions = null, uselessPeerGrace = C.USELESS_PEER_GRACE } = {}) {
    super()
    if (!storageDir) throw new Error('storageDir est requis')
    this.storageDir = storageDir
    this.swarmOptions = swarmOptions
    this.uselessPeerGrace = uselessPeerGrace
    this.swarm = null
    this.identity = null
    this.keyPair = null
    this.key = null
    this.files = null
    this.servers = new Map() // id -> serveur
    this.peers = new Map() // clé publique -> pair
    this.downloads = new Map() // empreinte -> téléchargement en cours
    this.voice = null // { server, channel, mute, deaf, video, screen }
    this._timer = null
  }

  // ---------------------------------------------------------------------------
  // Cycle de vie

  async start () {
    fs.mkdirSync(this.storageDir, { recursive: true })
    this.identity = this._loadIdentity()
    this.keyPair = cr.keyPairFromSeed(Buffer.from(this.identity.seed, 'hex'))
    this.key = this.keyPair.publicKey.toString('hex')

    this.files = new FileStore(path.join(this.storageDir, 'files'))
    this.files.init()

    for (const entry of this._loadServerList()) {
      try {
        this._openServer(Buffer.from(entry.secret, 'hex'), entry.name || null)
      } catch (err) {
        this.emit('warning', err)
      }
    }

    const opts = typeof this.swarmOptions === 'function' ? this.swarmOptions() : this.swarmOptions || {}
    this.swarm = new Hyperswarm({ ...opts, keyPair: this.keyPair })
    this.swarm.on('connection', (conn) => this._onConnection(conn))
    for (const server of this.servers.values()) this._joinTopic(server)

    this._lastAntiEntropy = Date.now()
    this._timer = setInterval(() => this._tick(), C.TICK_INTERVAL)
    if (this._timer.unref) this._timer.unref()
  }

  async stop () {
    if (!this.swarm) return
    clearInterval(this._timer)
    for (const dl of this.downloads.values()) this._failDownload(dl, new Error('Application arrêtée'))
    // « Au revoir » : les autres nous voient hors ligne tout de suite.
    for (const server of this.servers.values()) this._broadcastPresence(server, true)
    if (this.peers.size) await new Promise((resolve) => setTimeout(resolve, 150))
    const swarm = this.swarm
    this.swarm = null
    for (const peer of this.peers.values()) peer.conn.destroy()
    this.peers.clear()
    await swarm.destroy()
    for (const server of this.servers.values()) server.store.close()
  }

  // ---------------------------------------------------------------------------
  // Identité

  get name () {
    return this.identity.name || 'Anonyme-' + this.key.slice(0, 4)
  }

  me () {
    return { key: this.key, name: this.name, named: !!this.identity.name }
  }

  setName (name) {
    name = String(name || '').trim()
    if (!isName(name, C.MAX_USER_NAME_LENGTH)) throw new Error(`Le pseudo doit faire entre 1 et ${C.MAX_USER_NAME_LENGTH} caractères`)
    this.identity.name = name
    this._saveIdentity()
    for (const peer of this.peers.values()) this._send(peer, { t: 'name', name })
    for (const server of this.servers.values()) {
      this._append(server, 'profile', { name })
      this._broadcastPresence(server)
    }
    this.emit('me')
    return this.me()
  }

  _loadIdentity () {
    const file = path.join(this.storageDir, 'identity.json')
    try {
      const id = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (HEX64.test(id.seed)) return { seed: id.seed, name: isName(id.name, C.MAX_USER_NAME_LENGTH) ? id.name : null }
    } catch {}
    const identity = { seed: cr.randomHex(32), name: null }
    writeJsonAtomic(file, identity)
    return identity
  }

  _saveIdentity () {
    writeJsonAtomic(path.join(this.storageDir, 'identity.json'), this.identity)
  }

  // ---------------------------------------------------------------------------
  // Serveurs

  _loadServerList () {
    try {
      const list = JSON.parse(fs.readFileSync(path.join(this.storageDir, 'servers.json'), 'utf8'))
      return Array.isArray(list) ? list.filter((e) => e && HEX64.test(e.secret)) : []
    } catch {
      return []
    }
  }

  _saveServerList () {
    const list = [...this.servers.values()].map((s) => ({ secret: s.secret.toString('hex'), name: s.store.name || s.cachedName }))
    writeJsonAtomic(path.join(this.storageDir, 'servers.json'), list)
  }

  _openServer (secret, cachedName) {
    const id = cr.serverIdFromSecret(secret)
    if (this.servers.has(id)) return this.servers.get(id)
    const store = new ServerStore(path.join(this.storageDir, 'servers', id), id)
    store.open()
    const server = {
      id,
      secret,
      topic: cr.topicFromSecret(secret),
      store,
      cachedName,
      discovery: null,
      presence: new Map(), // clé -> présence signée reçue (directement ou relayée)
      lonelyDelay: C.LONELY_REFRESH_MIN,
      nextRefresh: Date.now() + C.LONELY_REFRESH_MIN
    }
    this.servers.set(id, server)
    return server
  }

  _joinTopic (server) {
    if (!this.swarm || server.discovery) return
    server.discovery = this.swarm.join(server.topic, { server: true, client: true })
  }

  // Résout quand notre présence sur un serveur a été annoncée sur la DHT.
  async flushed (serverId) {
    const server = this._getServer(serverId)
    if (server.discovery) await server.discovery.flushed()
  }

  _getServer (id) {
    const server = this.servers.get(id)
    if (!server) throw new Error('Serveur introuvable')
    return server
  }

  _serverName (server) {
    return server.store.name || server.cachedName || 'Serveur sans nom'
  }

  listServers () {
    return [...this.servers.values()].map((s) => ({ id: s.id, name: this._serverName(s) }))
  }

  createServer (name) {
    name = String(name || '').trim()
    if (!isName(name, C.MAX_SERVER_NAME_LENGTH)) throw new Error(`Le nom doit faire entre 1 et ${C.MAX_SERVER_NAME_LENGTH} caractères`)
    const server = this._addServer(cr.randomBytes(32), name)
    this._append(server, 'server', { name })
    this._append(server, 'channel', { id: cr.randomHex(8), name: 'général', kind: 'text' })
    this._append(server, 'channel', { id: cr.randomHex(8), name: 'Vocal', kind: 'voice' })
    this._append(server, 'profile', { name: this.name })
    this._saveServerList()
    this.emit('servers')
    return { id: server.id }
  }

  joinServer (invite) {
    const { secret, name } = decodeInvite(invite)
    const id = cr.serverIdFromSecret(secret)
    if (this.servers.has(id)) return { id, already: true }
    const server = this._addServer(secret, name)
    this._append(server, 'profile', { name: this.name })
    this.emit('servers')
    return { id, already: false }
  }

  _addServer (secret, name) {
    const server = this._openServer(secret, name)
    this._saveServerList()
    this._joinTopic(server)
    // Les pairs déjà connectés (via un autre serveur) peuvent aussi en faire partie.
    for (const peer of this.peers.values()) {
      if (peer.hello) this._send(peer, { t: 'join', proof: this._proof(server, peer.conn) })
    }
    return server
  }

  async leaveServer (id) {
    const server = this._getServer(id)
    if (this.voice && this.voice.server === id) this.setVoice(null)
    this._broadcastPresence(server, true)
    for (const peer of this.peers.values()) {
      if (peer.servers.delete(id)) this._send(peer, { t: 'part', s: id })
      peer.voice.delete(id)
      this._dropIfUseless(peer)
    }
    for (const dl of [...this.downloads.values()]) {
      if (dl.serverId === id) this._failDownload(dl, new Error('Serveur quitté'))
    }
    this.servers.delete(id)
    this._saveServerList()
    server.store.close()
    if (this.swarm) await this.swarm.leave(server.topic).catch(() => {})
    fs.rmSync(server.store.dir, { recursive: true, force: true })
    this.emit('servers')
  }

  getInvite (id) {
    const server = this._getServer(id)
    return encodeInvite(server.secret, this._serverName(server))
  }

  renameServer (id, name) {
    name = String(name || '').trim()
    if (!isName(name, C.MAX_SERVER_NAME_LENGTH)) throw new Error(`Le nom doit faire entre 1 et ${C.MAX_SERVER_NAME_LENGTH} caractères`)
    this._append(this._getServer(id), 'server', { name })
  }

  serverView (id) {
    const server = this._getServer(id)
    return {
      id,
      name: this._serverName(server),
      channels: server.store.channels(),
      members: this._members(server),
      voice: this.voiceMembers(id)
    }
  }

  _members (server) {
    const map = new Map()
    const add = (key, online) => {
      let m = map.get(key)
      if (!m) {
        m = { key, name: this._nameOf(server, key), online: false, me: key === this.key }
        map.set(key, m)
      }
      if (online) m.online = true
    }
    for (const key of server.store.authorKeys()) add(key, false)
    add(this.key, true)
    for (const peer of this.peers.values()) {
      if (peer.servers.has(server.id)) add(peer.key, true)
    }
    // Membres joignables seulement via un autre membre (présence relayée).
    for (const [key, entry] of server.presence) {
      if (key !== this.key && this._fresh(entry)) {
        add(key, true)
        const m = map.get(key)
        if (!this._direct(server, key)) m.relayed = true
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'))
  }

  _nameOf (server, key) {
    if (key === this.key) return this.name
    const peer = this.peers.get(key)
    if (peer && peer.name && peer.servers.has(server.id)) return peer.name
    const entry = server.presence.get(key)
    if (entry && entry.p.name) return entry.p.name
    return server.store.profileName(key) || 'Anonyme-' + key.slice(0, 4)
  }

  _direct (server, key) {
    const peer = this.peers.get(key)
    return peer && peer.servers.has(server.id) ? peer : null
  }

  _fresh (entry) {
    return !entry.p.off && Date.now() - entry.at < C.PRESENCE_TTL
  }

  // ---------------------------------------------------------------------------
  // Salons et messages

  createChannel (serverId, name, kind) {
    const server = this._getServer(serverId)
    if (kind !== 'text' && kind !== 'voice') throw new Error('Type de salon invalide')
    name = normalizeChannelName(name, kind)
    const channel = { id: cr.randomHex(8), name, kind }
    this._append(server, 'channel', channel)
    return channel
  }

  renameChannel (serverId, channelId, name) {
    const server = this._getServer(serverId)
    const channel = server.store.channel(channelId)
    if (!channel) throw new Error('Salon introuvable')
    this._append(server, 'channel', { id: channel.id, name: normalizeChannelName(name, channel.kind), kind: channel.kind })
  }

  deleteChannel (serverId, channelId) {
    const server = this._getServer(serverId)
    const channel = server.store.channel(channelId)
    if (!channel) throw new Error('Salon introuvable')
    if (this.voice && this.voice.server === serverId && this.voice.channel === channelId) this.setVoice(null)
    this._append(server, 'channel', { id: channel.id, name: channel.name, kind: channel.kind, deleted: true })
  }

  getMessages (serverId, channelId, opts = {}) {
    const server = this._getServer(serverId)
    const { messages, hasMore } = server.store.messages(channelId, {
      limit: Math.min(Math.max(Number(opts.limit) || 100, 1), 500),
      beforeId: typeof opts.beforeId === 'string' ? opts.beforeId : null
    })
    return { messages: messages.map((ev) => this.messageView(server.id, ev)), hasMore }
  }

  messageView (serverId, ev) {
    const server = this._getServer(serverId)
    return {
      id: eventId(ev),
      serverId,
      channel: ev.body.channel,
      author: ev.author,
      authorName: this._nameOf(server, ev.author),
      ts: ev.ts,
      text: ev.body.text,
      files: (ev.body.files || []).map((f) => ({ ...f, local: this.files.has(f.hash) }))
    }
  }

  // attachments : [{ path }] ou [{ name, data: Uint8Array }]
  async sendMessage (serverId, channelId, text, attachments = []) {
    const server = this._getServer(serverId)
    const channel = server.store.channel(channelId)
    if (!channel || channel.kind !== 'text') throw new Error('Salon introuvable')
    text = String(text || '').replace(/\s+$/, '')
    if (text.length > C.MAX_TEXT_LENGTH) throw new Error(`Message trop long (${C.MAX_TEXT_LENGTH} caractères max)`)
    if (!Array.isArray(attachments)) attachments = []
    if (attachments.length > C.MAX_FILES_PER_MESSAGE) throw new Error(`${C.MAX_FILES_PER_MESSAGE} fichiers maximum par message`)
    const files = []
    for (const a of attachments) {
      if (a && typeof a.path === 'string') files.push(await this.files.importFile(a.path))
      else if (a && a.data instanceof Uint8Array) files.push(this.files.importBuffer(a.data, a.name))
      else throw new Error('Pièce jointe invalide')
    }
    if (!text.trim() && files.length === 0) throw new Error('Message vide')
    const body = { channel: channelId, text }
    if (files.length) body.files = files
    const ev = this._append(server, 'msg', body)
    return this.messageView(server.id, ev)
  }

  _append (server, type, body) {
    const ev = createEvent({
      keyPair: this.keyPair,
      serverId: server.id,
      seq: server.store.nextSeq(this.key),
      type,
      body
    })
    server.store.add(ev)
    this._broadcastEvent(server, ev, null)
    this._onNewEvents(server, [ev])
    return ev
  }

  _onNewEvents (server, evs) {
    if (evs.some((ev) => ev.type === 'server')) {
      this._saveServerList()
      this.emit('servers')
    }
    this.emit('events', server.id, evs)
  }

  _broadcastEvent (server, ev, except) {
    for (const peer of this.peers.values()) {
      if (peer !== except && peer.servers.has(server.id)) this._send(peer, { t: 'ev', s: server.id, ev })
    }
  }

  // ---------------------------------------------------------------------------
  // Fichiers

  fileInfo (hash) {
    for (const server of this.servers.values()) {
      const info = server.store.fileInfo(hash)
      if (info) return info
    }
    return null
  }

  downloadFile (serverId, hash) {
    const server = this._getServer(serverId)
    if (!HEX64.test(hash)) return Promise.reject(new Error('Empreinte invalide'))
    if (this.files.has(hash)) return Promise.resolve(this.files.path(hash))
    const existing = this.downloads.get(hash)
    if (existing) return existing.promise
    const info = server.store.fileInfo(hash)
    if (!info) return Promise.reject(new Error('Fichier inconnu sur ce serveur'))

    const dl = { hash, serverId, size: info.size, tried: new Set(), peer: null, writer: null, timer: null, lastProgress: 0 }
    dl.promise = new Promise((resolve, reject) => {
      dl.resolve = resolve
      dl.reject = reject
    })
    this.downloads.set(hash, dl)
    this._nextSource(dl)
    return dl.promise
  }

  _nextSource (dl) {
    if (dl.writer) dl.writer.abort()
    dl.writer = null
    clearTimeout(dl.timer)
    const peer = [...this.peers.values()].find((p) => p.servers.has(dl.serverId) && !dl.tried.has(p.key))
    if (!peer) return this._failDownload(dl, new Error('Aucun pair connecté ne possède ce fichier pour le moment'))
    dl.tried.add(peer.key)
    dl.peer = peer
    dl.writer = this.files.createWriter(dl.hash, dl.size)
    this._send(peer, { t: 'fget', s: dl.serverId, h: dl.hash })
    this._armDownloadTimer(dl)
    this.emit('download', { hash: dl.hash, status: 'progress', received: 0, size: dl.size })
  }

  _armDownloadTimer (dl) {
    clearTimeout(dl.timer)
    dl.timer = setTimeout(() => this._nextSource(dl), C.FILE_TIMEOUT)
  }

  _failDownload (dl, err) {
    clearTimeout(dl.timer)
    if (dl.writer) dl.writer.abort()
    dl.writer = null
    this.downloads.delete(dl.hash)
    this.emit('download', { hash: dl.hash, status: 'failed', error: err.message })
    dl.reject(err)
  }

  _onFileData (peer, h, body) {
    const dl = this.downloads.get(h.h)
    if (!dl || dl.peer !== peer || !dl.writer) return
    if (h.o !== dl.writer.received || dl.writer.received + body.length > dl.size) return this._nextSource(dl)
    dl.writer.write(body)
    this._armDownloadTimer(dl)
    const now = Date.now()
    if (now - dl.lastProgress > 200) {
      dl.lastProgress = now
      this.emit('download', { hash: dl.hash, status: 'progress', received: dl.writer.received, size: dl.size })
    }
  }

  _onFileEnd (peer, h) {
    const dl = this.downloads.get(h.h)
    if (!dl || dl.peer !== peer || !dl.writer) return
    clearTimeout(dl.timer)
    const writer = dl.writer
    dl.writer = null
    if (!writer.finish()) return this._nextSource(dl)
    this.downloads.delete(dl.hash)
    this.emit('download', { hash: dl.hash, status: 'done', size: dl.size })
    dl.resolve(this.files.path(dl.hash))
  }

  _onFileNone (peer, h) {
    const dl = this.downloads.get(h.h)
    if (dl && dl.peer === peer) this._nextSource(dl)
  }

  async _upload (peer, serverId, hash) {
    const server = this.servers.get(serverId)
    const allowed = server && server.store.fileInfo(hash) && this.files.has(hash)
    if (!allowed || peer.uploads.has(hash) || peer.uploads.size >= MAX_UPLOADS_PER_PEER) {
      return this._send(peer, { t: 'fnone', h: hash })
    }
    peer.uploads.add(hash)
    const stream = this.files.createReader(hash)
    let offset = 0
    try {
      for await (const chunk of stream) {
        if (peer.conn.destroyed) return
        const ok = this._send(peer, { t: 'fdata', h: hash, o: offset }, chunk)
        offset += chunk.length
        if (!ok) await waitDrain(peer.conn)
      }
      if (peer.conn.destroyed) return
      this._send(peer, { t: 'fend', h: hash })
    } catch {
      this._send(peer, { t: 'fnone', h: hash })
    } finally {
      stream.destroy()
      peer.uploads.delete(hash)
    }
  }

  // ---------------------------------------------------------------------------
  // Vocal (les flux audio/vidéo passent en WebRTC, ici on ne gère que l'état)

  setVoice (state) {
    const prev = this.voice
    let next = null
    if (state) {
      const server = this._getServer(state.server)
      const channel = server.store.channel(state.channel)
      if (!channel || channel.kind !== 'voice') throw new Error('Salon vocal introuvable')
      next = {
        server: server.id,
        channel: channel.id,
        mute: !!state.mute,
        deaf: !!state.deaf,
        video: !!state.video,
        screen: !!state.screen
      }
    }
    this.voice = next
    if (prev && (!next || prev.server !== next.server)) {
      this._sendToServer(prev.server, { t: 'voice', s: prev.server, ch: null })
      const server = this.servers.get(prev.server)
      if (server) this._broadcastPresence(server)
      this.emit('voice', prev.server)
    }
    if (next) {
      this._sendToServer(next.server, this._voiceFrame())
      this._broadcastPresence(this.servers.get(next.server))
      this.emit('voice', next.server)
    }
  }

  _voiceFrame () {
    const v = this.voice
    return { t: 'voice', s: v.server, ch: v.channel, mute: v.mute, deaf: v.deaf, video: v.video, screen: v.screen }
  }

  voiceMembers (serverId) {
    const server = this._getServer(serverId)
    const out = {}
    const add = (channel, member) => {
      if (!out[channel]) out[channel] = []
      out[channel].push(member)
    }
    if (this.voice && this.voice.server === serverId) {
      const v = this.voice
      add(v.channel, { key: this.key, name: this.name, me: true, mute: v.mute, deaf: v.deaf, video: v.video, screen: v.screen })
    }
    for (const peer of this.peers.values()) {
      const v = peer.servers.has(serverId) && peer.voice.get(serverId)
      if (v) add(v.ch, { key: peer.key, name: this._nameOf(server, peer.key), me: false, mute: v.mute, deaf: v.deaf, video: v.video, screen: v.screen })
    }
    // État vocal des membres qu'on ne voit qu'au travers d'un autre membre.
    for (const [key, entry] of server.presence) {
      const v = entry.p.voice
      if (!v || key === this.key || this._direct(server, key) || !this._fresh(entry)) continue
      add(v.ch, { key, name: this._nameOf(server, key), me: false, relayed: true, mute: v.mute, deaf: v.deaf, video: v.video, screen: v.screen })
    }
    return out
  }

  // Signalisation WebRTC : directe si possible, sinon relayée (et signée).
  sendRtc (serverId, toKey, data) {
    const server = this._getServer(serverId)
    const direct = this._direct(server, toKey)
    if (direct) {
      this._send(direct, { t: 'rtc', s: serverId, d: data })
      return true
    }
    const r = { s: serverId, from: this.key, to: toKey, ts: Date.now(), d: data }
    let sig
    try {
      sig = cr.sign(rtcPayload(r), this.keyPair.secretKey).toString('hex')
    } catch {
      return false
    }
    return this._routeRtc(server, { t: 'rtc', ...r, sig, hops: 0 }, null)
  }

  _routeRtc (server, frame, from) {
    const direct = this._direct(server, frame.to)
    if (direct) {
      if (direct === from) return false
      this._send(direct, frame)
      return true
    }
    const entry = server.presence.get(frame.to)
    const via = entry && this._fresh(entry) && this._direct(server, entry.via)
    if (!via || via === from) return false
    this._send(via, frame)
    return true
  }

  // ---------------------------------------------------------------------------
  // Présence (relayée de proche en proche, signée par son auteur)

  _ownPresence (server, off = false) {
    const v = this.voice && this.voice.server === server.id ? this.voice : null
    const p = {
      key: this.key,
      name: this.name,
      ts: Date.now(),
      voice: v ? { ch: v.channel, mute: v.mute, deaf: v.deaf, video: v.video, screen: v.screen } : null
    }
    if (off) p.off = true
    return p
  }

  _broadcastPresence (server, off = false) {
    if (!server) return
    const p = this._ownPresence(server, off)
    const sig = cr.sign(presencePayload(server.id, p), this.keyPair.secretKey).toString('hex')
    this._sendToServer(server.id, { t: 'presence', s: server.id, p, sig })
  }

  _onPresence (peer, server, h) {
    const p = h.p
    if (!validPresence(p) || p.key === this.key || typeof h.sig !== 'string') return
    const prev = server.presence.get(p.key)
    if (prev && prev.p.ts >= p.ts) return // déjà vu (ou plus ancien)
    if (!cr.verify(presencePayload(server.id, p), Buffer.from(h.sig, 'hex'), Buffer.from(p.key, 'hex'))) return
    const before = prev ? presenceView(this, server, p.key, prev) : null
    const entry = { p, sig: h.sig, at: Date.now(), via: peer.key }
    server.presence.set(p.key, entry)
    // Relais aux autres membres directement connectés.
    for (const other of this.peers.values()) {
      if (other !== peer && other.key !== p.key && other.servers.has(server.id)) {
        this._send(other, { t: 'presence', s: server.id, p, sig: h.sig })
      }
    }
    this._presenceChanged(server, before, presenceView(this, server, p.key, entry))
  }

  _presenceChanged (server, before, after) {
    if (before === after) return
    this.emit('server-changed', server.id)
    this.emit('voice', server.id)
  }

  _expirePresence () {
    for (const server of this.servers.values()) {
      for (const [key, entry] of server.presence) {
        if (entry.expired || this._fresh(entry)) continue
        entry.expired = true
        if (!this._direct(server, key)) this._presenceChanged(server, 'x', 'y')
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Réseau

  _proof (server, conn, publicKey = this.keyPair.publicKey) {
    return cr.authProof(server.secret, conn.handshakeHash, publicKey)
  }

  _onConnection (conn) {
    const key = conn.remotePublicKey.toString('hex')
    const peer = {
      key,
      conn,
      name: null,
      hello: false,
      servers: new Set(),
      voice: new Map(),
      uploads: new Set(),
      dropTimer: null
    }
    const previous = this.peers.get(key)
    this.peers.set(key, peer)
    if (previous) previous.conn.destroy()

    const decoder = new FrameDecoder((header, body) => this._onFrame(peer, header, body))
    conn.on('data', (chunk) => {
      try {
        decoder.push(chunk)
      } catch (err) {
        this.emit('warning', err)
        conn.destroy()
      }
    })
    let lastError = null
    conn.on('error', (err) => {
      lastError = err
    })
    conn.on('close', () => {
      this.emit('debug', `déconnexion de ${key.slice(0, 8)}${lastError ? ' (' + lastError.message + ')' : ''}`)
      this._onClose(peer)
    })

    const proofs = [...this.servers.values()].map((s) => this._proof(s, conn))
    this._send(peer, { t: 'hello', v: C.PROTOCOL_VERSION, name: this.name, proofs })
  }

  _onClose (peer) {
    clearTimeout(peer.dropTimer)
    if (this.peers.get(peer.key) === peer) this.peers.delete(peer.key)
    for (const dl of [...this.downloads.values()]) {
      if (dl.peer === peer) this._nextSource(dl)
    }
    for (const serverId of peer.servers) {
      const server = this.servers.get(serverId)
      if (!server) continue
      // Les présences reçues par ce pair ne sont plus garanties : elles
      // seront rafraîchies par un autre chemin s'il en existe un.
      for (const entry of server.presence.values()) {
        if (entry.via === peer.key) entry.at = 0
      }
      this.emit('server-changed', serverId)
      this.emit('voice', serverId)
    }
    peer.servers.clear()
    peer.voice.clear()
  }

  _send (peer, header, body) {
    if (peer.conn.destroyed) return false
    return peer.conn.write(encodeFrame(header, body))
  }

  _sendToServer (serverId, header) {
    for (const peer of this.peers.values()) {
      if (peer.servers.has(serverId)) this._send(peer, header)
    }
  }

  _authorize (peer, server) {
    if (peer.servers.has(server.id)) return
    peer.servers.add(server.id)
    this._send(peer, { t: 'sync', s: server.id, have: server.store.vector() })
    if (this.voice && this.voice.server === server.id) this._send(peer, this._voiceFrame())
    // Notre présence, et celle des membres qu'il ne voit peut-être pas.
    const own = this._ownPresence(server)
    this._send(peer, { t: 'presence', s: server.id, p: own, sig: cr.sign(presencePayload(server.id, own), this.keyPair.secretKey).toString('hex') })
    for (const [key, entry] of server.presence) {
      if (key !== peer.key && this._fresh(entry)) this._send(peer, { t: 'presence', s: server.id, p: entry.p, sig: entry.sig })
    }
    this.emit('server-changed', server.id)
  }

  // Serveur partagé avec ce pair (il a prouvé en connaître le secret).
  _sharedServer (peer, serverId) {
    if (typeof serverId !== 'string' || !peer.servers.has(serverId)) return null
    return this.servers.get(serverId) || null
  }

  _onFrame (peer, h, body) {
    if (h.t === 'hello') return this._onHello(peer, h)
    if (!peer.hello) return

    switch (h.t) {
      case 'join': {
        // Le pair vient de rejoindre un serveur (ou nous répond) : s'il s'agit
        // d'un serveur commun, on renvoie notre propre preuve AVANT d'ouvrir la
        // synchronisation, pour qu'il nous autorise à son tour.
        if (typeof h.proof !== 'string') return
        for (const server of this.servers.values()) {
          if (!peer.servers.has(server.id) && h.proof === this._proof(server, peer.conn, peer.conn.remotePublicKey)) {
            if (!h.ack) this._send(peer, { t: 'join', proof: this._proof(server, peer.conn), ack: true })
            this._authorize(peer, server)
          }
        }
        return
      }
      case 'part': {
        if (!peer.servers.delete(h.s)) return
        const left = this.servers.get(h.s).presence.get(peer.key)
        if (left) left.at = 0
        const hadVoice = peer.voice.delete(h.s)
        this.emit('server-changed', h.s)
        if (hadVoice) this.emit('voice', h.s)
        this._dropIfUseless(peer)
        return
      }
      case 'name': {
        if (!isName(h.name, C.MAX_USER_NAME_LENGTH)) return
        peer.name = h.name
        for (const serverId of peer.servers) this.emit('server-changed', serverId)
        return
      }
      case 'sync': {
        const server = this._sharedServer(peer, h.s)
        if (!server || h.have === null || typeof h.have !== 'object' || Array.isArray(h.have)) return
        this._sendEvents(peer, server, server.store.eventsAfter(h.have))
        return
      }
      case 'evs':
      case 'ev': {
        const server = this._sharedServer(peer, h.s)
        if (!server) return
        const incoming = h.t === 'ev' ? [h.ev] : Array.isArray(h.evs) ? h.evs : []
        const added = []
        for (const ev of incoming) {
          if (verifyEvent(ev, server.id) && server.store.add(ev)) added.push(ev)
        }
        if (!added.length) return
        // Les messages en direct sont relayés aux autres pairs ; ceux issus d'une
        // synchronisation leur parviendront par la comparaison périodique.
        if (h.t === 'ev') this._broadcastEvent(server, added[0], peer)
        this._onNewEvents(server, added)
        return
      }
      case 'voice': {
        const server = this._sharedServer(peer, h.s)
        if (!server) return
        if (h.ch === null) peer.voice.delete(server.id)
        else if (typeof h.ch === 'string' && CHANNEL_ID.test(h.ch)) {
          peer.voice.set(server.id, { ch: h.ch, mute: !!h.mute, deaf: !!h.deaf, video: !!h.video, screen: !!h.screen })
        } else return
        this.emit('voice', server.id)
        return
      }
      case 'presence': {
        const server = this._sharedServer(peer, h.s)
        if (server) this._onPresence(peer, server, h)
        return
      }
      case 'rtc': {
        const server = this._sharedServer(peer, h.s)
        if (!server || h.d === null || typeof h.d !== 'object' || Array.isArray(h.d)) return
        if (h.to === undefined) return this.emit('rtc', server.id, peer.key, h.d)
        // Signal relayé : on vérifie que l'expéditeur annoncé l'a bien signé.
        if (typeof h.to !== 'string' || !HEX64.test(h.to) || typeof h.from !== 'string' || !HEX64.test(h.from)) return
        if (!Number.isSafeInteger(h.ts) || !Number.isSafeInteger(h.hops) || typeof h.sig !== 'string') return
        const r = { s: h.s, from: h.from, to: h.to, ts: h.ts, d: h.d }
        let ok = false
        try {
          ok = cr.verify(rtcPayload(r), Buffer.from(h.sig, 'hex'), Buffer.from(h.from, 'hex'))
        } catch {}
        if (!ok || h.from === this.key) return
        if (h.to === this.key) return this.emit('rtc', server.id, h.from, h.d)
        if (h.hops + 1 >= C.RTC_MAX_HOPS) return
        this._routeRtc(server, { t: 'rtc', ...r, sig: h.sig, hops: h.hops + 1 }, peer)
        return
      }
      case 'fget': {
        const server = this._sharedServer(peer, h.s)
        if (server && typeof h.h === 'string' && HEX64.test(h.h)) this._upload(peer, server.id, h.h)
        return
      }
      case 'fdata':
        if (typeof h.h === 'string' && Number.isSafeInteger(h.o)) this._onFileData(peer, h, body)
        return
      case 'fend':
        if (typeof h.h === 'string') this._onFileEnd(peer, h)
        return
      case 'fnone':
        if (typeof h.h === 'string') this._onFileNone(peer, h)
    }
  }

  _onHello (peer, h) {
    if (peer.hello) return
    peer.hello = true
    peer.name = isName(h.name, C.MAX_USER_NAME_LENGTH) ? h.name : null
    const proofs = new Set(Array.isArray(h.proofs) ? h.proofs.filter((p) => typeof p === 'string') : [])
    for (const server of this.servers.values()) {
      if (proofs.has(this._proof(server, peer.conn, peer.conn.remotePublicKey))) this._authorize(peer, server)
    }
    this._dropIfUseless(peer)
  }

  // Une connexion sans aucun serveur commun (intrus qui a vu le sujet sur la
  // DHT, ou ami d'un serveur qu'on a quitté) est fermée après un délai.
  _dropIfUseless (peer) {
    if (peer.servers.size > 0 || peer.dropTimer) return
    peer.dropTimer = setTimeout(() => {
      peer.dropTimer = null
      if (peer.servers.size === 0 && this.peers.get(peer.key) === peer) {
        this.emit('debug', `fermeture de ${peer.key.slice(0, 8)} : aucun serveur commun`)
        peer.conn.destroy()
      }
    }, this.uselessPeerGrace)
    if (peer.dropTimer.unref) peer.dropTimer.unref()
  }

  _sendEvents (peer, server, events) {
    let batch = []
    let size = 0
    for (const ev of events) {
      const evSize = Buffer.byteLength(JSON.stringify(ev))
      if (batch.length && size + evSize > C.SYNC_BATCH_BYTES) {
        this._send(peer, { t: 'evs', s: server.id, evs: batch })
        batch = []
        size = 0
      }
      batch.push(ev)
      size += evSize
    }
    if (batch.length) this._send(peer, { t: 'evs', s: server.id, evs: batch })
  }

  _tick () {
    const now = Date.now()
    if (!this._lastPresence || now - this._lastPresence >= C.PRESENCE_INTERVAL) {
      this._lastPresence = now
      for (const server of this.servers.values()) this._broadcastPresence(server)
    }
    this._expirePresence()
    const antiEntropy = now - this._lastAntiEntropy >= C.ANTI_ENTROPY_INTERVAL
    if (antiEntropy) this._lastAntiEntropy = now
    const connected = new Set()
    for (const peer of this.peers.values()) {
      for (const serverId of peer.servers) {
        const server = this.servers.get(serverId)
        if (!server) continue
        connected.add(serverId)
        // Comparaison périodique des historiques : rattrape ce qui a pu être manqué.
        if (antiEntropy) this._send(peer, { t: 'sync', s: serverId, have: server.store.vector() })
      }
    }
    // Hyperswarm ne relance la recherche de pairs que toutes les 10 minutes :
    // tant qu'on n'a trouvé personne sur un serveur, on la relance bien plus
    // souvent (5 s, 10 s, 20 s… jusqu'à 1 min).
    for (const server of this.servers.values()) {
      if (connected.has(server.id)) {
        server.lonelyDelay = C.LONELY_REFRESH_MIN
        server.nextRefresh = now + C.LONELY_REFRESH_MIN
      } else if (now >= server.nextRefresh && server.discovery) {
        server.discovery.refresh().catch(() => {})
        server.lonelyDelay = Math.min(server.lonelyDelay * 2, C.LONELY_REFRESH_MAX)
        server.nextRefresh = now + server.lonelyDelay
      }
    }
  }
}

function presencePayload (serverId, p) {
  return Buffer.from('dixcord/presence/v1\n' + canonical({ s: serverId, p }), 'utf8')
}

function rtcPayload (r) {
  return Buffer.from('dixcord/rtc/v1\n' + canonical(r), 'utf8')
}

function validPresence (p) {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return false
  if (!Object.keys(p).every((k) => ['key', 'name', 'ts', 'voice', 'off'].includes(k))) return false
  if (typeof p.key !== 'string' || !HEX64.test(p.key) || !Number.isSafeInteger(p.ts)) return false
  if (!isName(p.name, C.MAX_USER_NAME_LENGTH)) return false
  if (p.off !== undefined && p.off !== true) return false
  const v = p.voice
  if (v === null) return true
  if (typeof v !== 'object' || Array.isArray(v) || typeof v.ch !== 'string' || !CHANNEL_ID.test(v.ch)) return false
  return ['mute', 'deaf', 'video', 'screen'].every((k) => typeof v[k] === 'boolean') && Object.keys(v).length === 5
}

// Ce qu'une présence change à l'affichage (en ligne, pseudo, état vocal).
function presenceView (node, server, key, entry) {
  if (!node._fresh(entry)) return 'off'
  return JSON.stringify([entry.p.name, entry.p.voice])
}

function normalizeChannelName (name, kind) {
  name = String(name || '').trim()
  if (kind === 'text') name = name.toLowerCase().replace(/\s+/g, '-')
  if (!isName(name, C.MAX_CHANNEL_NAME_LENGTH)) throw new Error(`Le nom du salon doit faire entre 1 et ${C.MAX_CHANNEL_NAME_LENGTH} caractères`)
  return name
}

function writeJsonAtomic (file, data) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function waitDrain (stream) {
  if (stream.destroyed) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      stream.off('drain', done)
      stream.off('close', done)
      resolve()
    }
    stream.on('drain', done)
    stream.on('close', done)
  })
}

module.exports = { DixcordNode }

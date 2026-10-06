// Vocal, vidéo et partage d'écran en WebRTC, en maillage complet : chaque
// participant d'un salon vocal est relié directement à chacun des autres.
// La signalisation (offres, réponses, candidats ICE) passe par les
// connexions Hyperswarm : aucun serveur de signalisation.
//
// Quand deux participants n'arrivent pas à se relier directement (4G/5G,
// réseaux d'école ou d'entreprise…), un troisième participant leur sert de
// relais : il leur retransmet les flux qu'il reçoit de chacun.

import { storageGet, storageSet } from './ui.js'

const SPEAKING_THRESHOLD = 0.015
const SPEAKING_HOLD_MS = 350
const PENDING_SIGNAL_TTL = 15000
// Délai avant de raccrocher quand un participant disparaît sans dire au revoir
// (coupure passagère du lien Hyperswarm alors que l'appel WebRTC passe encore).
const ORPHAN_GRACE_MS = 20000
// Délai laissé à la liaison directe avant de passer par un relais.
const RELAY_AFTER_MS = 8000
const RELAY_CHECK_MS = 2000
const RELAY_RETRY_MS = 30000
// Chien de garde : relance la recherche de chemin réseau, puis recrée la
// connexion, si elle reste bloquée.
const ICE_RESTART_EVERY_MS = 10000
const ICE_RECREATE_AFTER_MS = 30000
const ICE_MAX_RESTARTS = 2
const ICE_MAX_RECREATES = 1

// Débits maximaux : en 4G ou sur un réseau chargé, la vidéo ne doit pas
// étouffer le son.
const BITRATES = {
  audio: 64000,
  camera: 600000,
  screen: 1500000,
  fwdCamera: 400000,
  fwdScreen: 1000000
}

export class VoiceManager {
  constructor ({ api, myKey, iceServers, platform, onChange, onSpeaking, onError, noDirect = [] }) {
    this.api = api
    this.myKey = myKey
    this.iceServers = iceServers
    this.platform = platform
    this.onChange = onChange
    this.onSpeaking = onSpeaking
    this.onError = onError
    // Diagnostic/tests : participants avec qui on simule l'échec de la liaison directe.
    this.noDirect = new Set(noDirect)

    this.serverId = null
    this.channelId = null
    this.muted = false
    this.deafened = false
    this.micStream = null
    this.cameraStream = null
    this.screenStream = null

    this.peers = new Map() // clé -> connexion WebRTC
    this.pendingSignals = new Map() // clé -> signaux reçus avant l'état vocal du pair
    this.deadSids = new Set() // connexions distantes terminées : leurs signaux en retard sont ignorés
    this.voiceMaps = new Map() // serveur -> { salon: [membres] }
    this.forwards = new Map() // demandeur -> Set(origines) : flux qu'on retransmet pour d'autres
    this.relays = new Map() // origine -> { via, since } : relais qu'on utilise pour une origine
    this.relayTried = new Map() // "origine:relais" -> date du refus
    this.recreated = new Map() // clé -> nombre de connexions recréées par le chien de garde

    this.audioCtx = null
    this.monitors = new Map()
    this.speaking = new Set()
    this._speakTimer = null
    this._relayTimer = null
    this._busy = false
    this._session = 0 // incrémenté à chaque départ : annule un « join » en cours
  }

  get connected () {
    return this.serverId !== null
  }

  // ---------------------------------------------------------------------------
  // Rejoindre / quitter

  async join (serverId, channelId) {
    if (this._busy || (this.serverId === serverId && this.channelId === channelId)) return
    this._busy = true
    try {
      if (this.serverId) await this.leave()
      const session = this._session
      await this.api.askMediaAccess('microphone').catch(() => {})
      let mic = null
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(), video: false })
      } catch {
        this.onError('Micro inaccessible : tu es connecté au vocal en écoute seule.')
      }
      if (session !== this._session) {
        if (mic) mic.getTracks().forEach((t) => t.stop())
        return
      }
      this.micStream = mic
      this.serverId = serverId
      this.channelId = channelId
      this._applyMute()
      if (this.micStream) this._monitor(this.myKey, this.micStream, null)
      this._startSpeakingLoop()
      this._relayTimer = setInterval(() => this._checkRelays(), RELAY_CHECK_MS)
      await this._publish()
      this._reconcile()
    } catch (err) {
      await this.leave()
      throw err
    } finally {
      this._busy = false
      this.onChange()
    }
  }

  async leave () {
    this._session++
    const wasConnected = this.serverId !== null
    for (const peer of [...this.peers.values()]) {
      this._signal(peer, { bye: true })
      this._closePeer(peer.key)
    }
    this.pendingSignals.clear()
    this.deadSids.clear()
    this.forwards.clear()
    this.relays.clear()
    this.relayTried.clear()
    this.recreated.clear()
    for (const stream of [this.micStream, this.cameraStream, this.screenStream]) {
      if (stream) stream.getTracks().forEach((t) => t.stop())
    }
    this.micStream = this.cameraStream = this.screenStream = null
    for (const m of this.monitors.values()) m.source.disconnect()
    this.monitors.clear()
    this.speaking.clear()
    clearInterval(this._speakTimer)
    clearInterval(this._relayTimer)
    this._speakTimer = this._relayTimer = null
    this.serverId = null
    this.channelId = null
    if (wasConnected) await this.api.setVoice(null).catch(() => {})
    this.onChange()
  }

  _publish () {
    return this.api.setVoice({
      server: this.serverId,
      channel: this.channelId,
      mute: this.muted || this.deafened || !this.micStream,
      deaf: this.deafened,
      video: !!this.cameraStream,
      screen: !!this.screenStream
    })
  }

  // Appelé à chaque changement d'état vocal sur un serveur.
  updateVoiceMap (serverId, map) {
    this.voiceMaps.set(serverId, map || {})
    if (serverId === this.serverId) this._reconcile()
  }

  _wanted () {
    const map = this.voiceMaps.get(this.serverId) || {}
    return new Set((map[this.channelId] || []).filter((m) => !m.me).map((m) => m.key))
  }

  _reconcile () {
    if (!this.serverId) return
    const wanted = this._wanted()
    for (const key of wanted) {
      const peer = this.peers.get(key)
      if (!peer) this._openPeer(key)
      else if (peer.orphanTimer) {
        clearTimeout(peer.orphanTimer)
        peer.orphanTimer = null
      }
    }
    for (const [key, peer] of [...this.peers]) {
      if (wanted.has(key) || peer.orphanTimer) continue
      if (peer.pc.connectionState !== 'connected') {
        this._closePeer(key)
        continue
      }
      peer.orphanTimer = setTimeout(() => {
        peer.orphanTimer = null
        if (this.peers.get(key) === peer && !this._wanted().has(key)) this._closePeer(key)
      }, ORPHAN_GRACE_MS)
    }
    for (const origin of [...this.relays.keys()]) {
      if (!wanted.has(origin)) this._stopRelay(origin)
    }
  }

  // ---------------------------------------------------------------------------
  // Micro, casque, caméra, écran

  setMuted (muted) {
    this.muted = muted
    if (!muted && this.deafened) this._setDeaf(false)
    this._applyMute()
    if (this.serverId) this._publish().catch(() => {})
    this.onChange()
  }

  setDeafened (deafened) {
    this._setDeaf(deafened)
    this._applyMute()
    if (this.serverId) this._publish().catch(() => {})
    this.onChange()
  }

  _setDeaf (deafened) {
    this.deafened = deafened
    for (const peer of this.peers.values()) {
      for (const el of peer.audioEls.values()) el.muted = deafened
    }
    this._updateRelayedAudio()
  }

  _applyMute () {
    const off = this.muted || this.deafened
    if (this.micStream) this.micStream.getAudioTracks().forEach((t) => { t.enabled = !off })
  }

  async toggleCamera () {
    if (!this.serverId) return
    if (this.cameraStream) {
      for (const peer of this.peers.values()) {
        if (peer.senders.camera) safely(() => peer.pc.removeTrack(peer.senders.camera))
        peer.senders.camera = null
      }
      this.cameraStream.getTracks().forEach((t) => t.stop())
      this.cameraStream = null
    } else {
      await this.api.askMediaAccess('camera').catch(() => {})
      const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(), audio: false })
      if (!this.serverId) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      this.cameraStream = stream
      this._sendMetaAll() // l'étiquette du flux arrive avant le flux lui-même
      const track = stream.getVideoTracks()[0]
      for (const peer of this.peers.values()) peer.senders.camera = peer.pc.addTrack(track, stream)
    }
    this._sendMetaAll()
    await this._publish().catch(() => {})
    this.onChange()
  }

  async startScreen (sourceId) {
    if (!this.serverId) return
    await this.api.selectScreenSource(sourceId)
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: this.platform === 'win32' })
    if (!this.serverId) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    if (this.screenStream) this.stopScreen()
    this.screenStream = stream
    const video = stream.getVideoTracks()[0]
    video.contentHint = 'detail' // privilégie la netteté (texte) plutôt que la fluidité
    video.addEventListener('ended', () => {
      if (this.screenStream === stream) this.stopScreen()
    })
    this._sendMetaAll()
    for (const peer of this.peers.values()) peer.senders.screen = stream.getTracks().map((t) => peer.pc.addTrack(t, stream))
    await this._publish().catch(() => {})
    this.onChange()
  }

  stopScreen () {
    if (!this.screenStream) return
    for (const peer of this.peers.values()) {
      for (const sender of peer.senders.screen) safely(() => peer.pc.removeTrack(sender))
      peer.senders.screen = []
    }
    this.screenStream.getTracks().forEach((t) => t.stop())
    this.screenStream = null
    this._sendMetaAll()
    if (this.serverId) this._publish().catch(() => {})
    this.onChange()
  }

  setOutputDevice (deviceId) {
    storageSet('dixcord.speaker', deviceId)
    for (const peer of this.peers.values()) {
      for (const el of peer.audioEls.values()) applySink(el)
    }
  }

  // Flux vidéo à afficher : caméras et écrans, locaux et distants (y compris
  // ceux qu'un autre participant nous retransmet).
  videoTiles () {
    const tiles = []
    if (this.cameraStream) tiles.push({ key: this.myKey, kind: 'camera', stream: this.cameraStream, local: true })
    if (this.screenStream) tiles.push({ key: this.myKey, kind: 'screen', stream: this.screenStream, local: true })
    const seen = new Set()
    for (const peer of this.peers.values()) {
      // Une liaison non établie annonce des pistes, mais aucune image n'y passe.
      if (peer.pc.connectionState !== 'connected') continue
      for (const stream of peer.streams.values()) {
        if (!stream.getVideoTracks().some((t) => t.readyState === 'live')) continue
        const { origin, kind } = this._attribution(peer, stream.id)
        if (origin === this.myKey || seen.has(origin + ':' + kind)) continue
        // Un flux direct l'emporte sur le même flux relayé.
        if (origin !== peer.key && this._directOk(origin)) continue
        seen.add(origin + ':' + kind)
        tiles.push({ key: origin, kind, stream, local: false })
      }
    }
    return tiles
  }

  // Pour le diagnostic (et les tests).
  stats () {
    return [...this.peers.values()].map((p) => ({
      key: p.key,
      sid: p.sid,
      connectionState: p.pc.connectionState,
      ice: p.pc.iceConnectionState + '/' + p.pc.iceGatheringState + '/' + p.pc.signalingState,
      candidates: p.localCandidates + '/' + p.remoteCandidates,
      relayedBy: this.relays.get(p.key) ? this.relays.get(p.key).via : null,
      remoteTracks: [...p.streams.values()]
        .filter((s) => this._attribution(p, s.id).origin === p.key)
        .flatMap((s) => s.getTracks().map((t) => t.kind)),
      relayedTracks: [...this.peers.values()].flatMap((r) => [...r.streams.values()]
        .filter((s) => r !== p && this._attribution(r, s.id).origin === p.key)
        .flatMap((s) => s.getTracks().map((t) => t.kind)))
    }))
  }

  // ---------------------------------------------------------------------------
  // Connexions WebRTC (« perfect negotiation »)

  _openPeer (key) {
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      // Liaison directe impossible (test) : on ne propose aucun chemin réseau.
      ...(this.noDirect.has(key) ? { iceTransportPolicy: 'relay' } : {})
    })
    const peer = {
      key,
      pc,
      sid: Math.random().toString(36).slice(2, 12), // identifie cette connexion
      remoteSid: null,
      orphanTimer: null,
      openedAt: Date.now(),
      lastRestart: Date.now(),
      restarts: 0,
      localCandidates: 0,
      remoteCandidates: 0,
      polite: this.myKey > key,
      makingOffer: false,
      ignoreOffer: false,
      queue: Promise.resolve(),
      senders: { audio: null, camera: null, screen: [] },
      fwdSenders: new Map(), // piste retransmise -> { sender, origin, kind }
      streams: new Map(),
      audioEls: new Map(),
      meta: { camera: null, screen: null, fwd: {} }
    }
    this.peers.set(key, peer)

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return
      peer.localCandidates++
      this._signal(peer, { candidate: candidate.toJSON() })
    }
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true
        await pc.setLocalDescription()
        this._signal(peer, { description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } })
        this._tuneSenders(peer)
      } catch (err) {
        console.warn('Négociation WebRTC :', err)
      } finally {
        peer.makingOffer = false
      }
    }
    pc.ontrack = (ev) => this._onTrack(peer, ev)
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState
      if (peer.orphanTimer && (st === 'failed' || st === 'disconnected' || st === 'closed')) return this._closePeer(key)
      if (st === 'failed') pc.restartIce()
      if (st === 'connected') this._tuneSenders(peer)
      this._checkRelays()
      this._refreshMonitors()
      this.onChange()
    }

    const mic = this.micStream && this.micStream.getAudioTracks()[0]
    if (mic) peer.senders.audio = pc.addTrack(mic, this.micStream)
    else pc.addTransceiver('audio', { direction: 'recvonly' })
    const cam = this.cameraStream && this.cameraStream.getVideoTracks()[0]
    if (cam) peer.senders.camera = pc.addTrack(cam, this.cameraStream)
    if (this.screenStream) peer.senders.screen = this.screenStream.getTracks().map((t) => pc.addTrack(t, this.screenStream))
    this._signal(peer, this._metaPayload(peer))

    const pending = this.pendingSignals.get(key)
    if (pending) {
      this.pendingSignals.delete(key)
      const now = Date.now()
      for (const { data, at } of pending) if (now - at < PENDING_SIGNAL_TTL) this._deliver(this.peers.get(key), data)
    }
    this.onChange()
    return peer
  }

  _closePeer (key) {
    const peer = this.peers.get(key)
    if (!peer) return
    this.peers.delete(key)
    clearTimeout(peer.orphanTimer)
    if (peer.remoteSid) {
      if (this.deadSids.size > 500) this.deadSids.clear()
      this.deadSids.add(peer.remoteSid)
    }
    safely(() => peer.pc.close())
    for (const el of peer.audioEls.values()) {
      el.pause()
      el.srcObject = null
    }
    for (const [origin, m] of [...this.monitors]) {
      if (m.owner === key) {
        m.source.disconnect()
        this.monitors.delete(origin)
        this.speaking.delete(origin)
      }
    }
    // Relais : on ne retransmet plus rien pour lui, ni rien venant de lui.
    this.forwards.delete(key)
    for (const other of this.peers.values()) this._unforward(other, (f) => f.origin === key)
    for (const [origin, r] of [...this.relays]) {
      if (r.via === key) this.relays.delete(origin)
    }
    this.onChange()
  }

  handleSignal (serverId, from, data) {
    if (serverId !== this.serverId || !data || typeof data !== 'object') return
    const peer = this.peers.get(from)
    if (peer) return this._deliver(peer, data)
    if (data.bye) return this.pendingSignals.delete(from)
    // Le signal peut précéder de peu l'état vocal du pair : on le garde.
    const list = this.pendingSignals.get(from) || []
    if (list.length < 200) list.push({ data, at: Date.now() })
    this.pendingSignals.set(from, list)
  }

  _deliver (peer, data) {
    const sid = typeof data.sid === 'string' ? data.sid : null
    if (sid && this.deadSids.has(sid)) return // signal en retard d'une connexion terminée
    if (sid && peer.remoteSid && sid !== peer.remoteSid) {
      if (data.bye) return // au revoir d'une ancienne connexion
      // Le correspondant a recréé sa connexion WebRTC : on recrée la nôtre.
      this._closePeer(peer.key)
      peer = this._openPeer(peer.key)
    }
    if (sid && !peer.remoteSid) peer.remoteSid = sid
    if (data.bye) return this._closePeer(peer.key)
    if (data.relay) return this._onRelayRequest(peer, data.relay)
    if (data.relayAck) return this._onRelayAck(peer, data.relayAck)
    this._enqueueSignal(peer, data)
  }

  _enqueueSignal (peer, data) {
    // Les signaux d'un pair sont traités dans l'ordre, un par un.
    peer.queue = peer.queue.then(() => this._applySignal(peer, data)).catch((err) => console.warn('Signal WebRTC :', err))
  }

  async _applySignal (peer, data) {
    const pc = peer.pc
    if (pc.signalingState === 'closed') return
    if (data.meta) {
      const fwd = {}
      if (data.meta.fwd && typeof data.meta.fwd === 'object') {
        for (const [id, f] of Object.entries(data.meta.fwd).slice(0, 50)) {
          if (f && typeof f.from === 'string' && /^[0-9a-f]{64}$/.test(f.from) && ['audio', 'camera', 'screen'].includes(f.kind)) fwd[id] = { from: f.from, kind: f.kind }
        }
      }
      peer.meta = { camera: strOrNull(data.meta.camera), screen: strOrNull(data.meta.screen), fwd }
      this._refreshMonitors()
      this.onChange()
      return
    }
    if (data.description) {
      const { type, sdp } = data.description
      if ((type !== 'offer' && type !== 'answer') || typeof sdp !== 'string') return
      const collision = type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable')
      peer.ignoreOffer = !peer.polite && collision
      if (peer.ignoreOffer) return
      await pc.setRemoteDescription({ type, sdp })
      if (type === 'offer') {
        await pc.setLocalDescription()
        this._signal(peer, { description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } })
      }
      this._tuneSenders(peer)
    } else if (data.candidate) {
      peer.remoteCandidates++
      try {
        await pc.addIceCandidate(data.candidate)
      } catch (err) {
        if (!peer.ignoreOffer) throw err
      }
    }
  }

  // À qui appartient un flux reçu : au pair lui-même, ou à un participant
  // dont il nous retransmet les flux.
  _attribution (peer, streamId) {
    const f = peer.meta.fwd[streamId]
    if (f) return { origin: f.from, kind: f.kind }
    return { origin: peer.key, kind: streamId === peer.meta.screen ? 'screen' : streamId === peer.meta.camera ? 'camera' : 'audio' }
  }

  _onTrack (peer, ev) {
    const stream = ev.streams[0] || new MediaStream([ev.track])
    if (!peer.streams.has(stream.id)) {
      peer.streams.set(stream.id, stream)
      stream.addEventListener('removetrack', (e) => {
        if (stream.getTracks().length === 0) {
          peer.streams.delete(stream.id)
          const el = peer.audioEls.get(stream.id)
          if (el) {
            el.srcObject = null
            peer.audioEls.delete(stream.id)
          }
        }
        // Retransmission : la piste disparaît aussi chez ceux à qui on la relayait.
        for (const other of this.peers.values()) this._unforward(other, (f) => f.track === e.track)
        this._refreshMonitors()
        this.onChange()
      })
    }
    if (ev.track.kind === 'audio' && !peer.audioEls.has(stream.id)) {
      const el = new Audio()
      el.autoplay = true
      el.srcObject = stream
      el.muted = this.deafened
      applySink(el)
      el.play().catch(() => {})
      peer.audioEls.set(stream.id, el)
    }
    this._refreshMonitors()
    for (const type of ['mute', 'unmute', 'ended']) ev.track.addEventListener(type, () => this.onChange())
    // Si on relaie ce pair pour d'autres participants, on leur transmet la nouvelle piste.
    for (const [requester, origins] of this.forwards) {
      if (origins.has(peer.key)) this._forwardTo(this.peers.get(requester), peer)
    }
    this._updateRelayedAudio()
    this.onChange()
  }

  // N'envoie que pour la connexion courante d'un pair (pas une ancienne).
  _signal (peer, data) {
    if (this.serverId && this.peers.get(peer.key) === peer) {
      this.api.sendRtc(this.serverId, peer.key, { ...data, sid: peer.sid }).catch(() => {})
    }
  }

  _metaPayload (peer) {
    const fwd = {}
    for (const f of peer.fwdSenders.values()) fwd[f.streamId] = { from: f.origin, kind: f.kind }
    return { meta: { camera: this.cameraStream ? this.cameraStream.id : null, screen: this.screenStream ? this.screenStream.id : null, fwd } }
  }

  _sendMetaAll () {
    for (const peer of this.peers.values()) this._signal(peer, this._metaPayload(peer))
  }

  // Débits maximaux et priorité du son, appliqués après chaque négociation.
  _tuneSenders (peer) {
    const mic = this.micStream && this.micStream.getAudioTracks()[0]
    const cam = this.cameraStream && this.cameraStream.getVideoTracks()[0]
    const screen = this.screenStream && this.screenStream.getVideoTracks()[0]
    const fwdKinds = new Map([...peer.fwdSenders.values()].map((f) => [f.track, f.kind]))
    for (const sender of peer.pc.getSenders()) {
      const track = sender.track
      if (!track) continue
      let profile
      if (track.kind === 'audio') profile = { maxBitrate: BITRATES.audio, priority: 'high', networkPriority: 'high' }
      else if (track === cam) profile = { maxBitrate: BITRATES.camera, maxFramerate: 24 }
      else if (track === screen) profile = { maxBitrate: BITRATES.screen, maxFramerate: 15 }
      else if (fwdKinds.get(track) === 'screen') profile = { maxBitrate: BITRATES.fwdScreen, maxFramerate: 15 }
      else profile = { maxBitrate: BITRATES.fwdCamera, maxFramerate: 24 }
      if (track === mic) profile.priority = 'high'
      const params = sender.getParameters()
      if (!params.encodings || !params.encodings.length) continue
      const enc = params.encodings[0]
      if (Object.entries(profile).every(([k, v]) => enc[k] === v)) continue
      Object.assign(enc, profile)
      sender.setParameters(params).catch(() => {})
    }
  }

  // ---------------------------------------------------------------------------
  // Relais par un autre participant

  _directOk (key) {
    const peer = this.peers.get(key)
    return !!peer && peer.pc.connectionState === 'connected' && !this.noDirect.has(key)
  }

  _watchdog () {
    const now = Date.now()
    for (const peer of [...this.peers.values()]) {
      if (peer.pc.connectionState === 'connected' || this.noDirect.has(peer.key) || peer.orphanTimer) continue
      const recreated = this.recreated.get(peer.key) || 0
      if (now - peer.openedAt > ICE_RECREATE_AFTER_MS && recreated < ICE_MAX_RECREATES) {
        // Toujours rien : on repart d'une connexion neuve (le correspondant suivra).
        this.recreated.set(peer.key, recreated + 1)
        this._closePeer(peer.key)
        if (this._wanted().has(peer.key)) this._openPeer(peer.key)
      } else if (now - peer.lastRestart > ICE_RESTART_EVERY_MS && peer.restarts < ICE_MAX_RESTARTS) {
        // Au-delà, la liaison directe est sans doute impossible : le relais prend le relais.
        peer.lastRestart = now
        peer.restarts++
        safely(() => peer.pc.restartIce())
      }
    }
  }

  _checkRelays () {
    if (!this.serverId) return
    this._watchdog()
    const now = Date.now()
    for (const key of this._wanted()) {
      const peer = this.peers.get(key)
      const relay = this.relays.get(key)
      if (this._directOk(key)) {
        // La liaison directe fonctionne : plus besoin de relais.
        if (relay) this._stopRelay(key)
        continue
      }
      const failed = !peer || peer.pc.connectionState === 'failed' || now - peer.openedAt > RELAY_AFTER_MS || this.noDirect.has(key)
      if (!failed) continue
      if (relay && this._directOk(relay.via)) continue
      if (relay) this.relays.delete(key)
      // Choix d'un relais : un participant joignable directement, qui n'a pas déjà refusé.
      const candidate = [...this.peers.values()].find((r) => {
        if (r.key === key || !this._directOk(r.key)) return false
        const refused = this.relayTried.get(key + ':' + r.key)
        return !refused || now - refused > RELAY_RETRY_MS
      })
      if (!candidate) continue
      this.relays.set(key, { via: candidate.key, since: now, acked: false })
      this._signal(candidate, { relay: { want: key, on: true } })
    }
  }

  _stopRelay (origin) {
    const relay = this.relays.get(origin)
    if (!relay) return
    this.relays.delete(origin)
    const via = this.peers.get(relay.via)
    if (via) this._signal(via, { relay: { want: origin, on: false } })
    this._refreshMonitors()
    this.onChange()
  }

  // Un participant nous demande de lui retransmettre les flux d'un autre.
  _onRelayRequest (requester, req) {
    if (!req || typeof req.want !== 'string') return
    const origins = this.forwards.get(requester.key) || new Set()
    if (!req.on) {
      origins.delete(req.want)
      this._unforward(requester, (f) => f.origin === req.want)
      return
    }
    const source = this.peers.get(req.want)
    const ok = !!source && this._directOk(req.want) && req.want !== requester.key
    this._signal(requester, { relayAck: { want: req.want, ok } })
    if (!ok) return
    origins.add(req.want)
    this.forwards.set(requester.key, origins)
    this._forwardTo(requester, source)
  }

  _onRelayAck (relayPeer, ack) {
    if (!ack || typeof ack.want !== 'string') return
    const relay = this.relays.get(ack.want)
    if (!relay || relay.via !== relayPeer.key) return
    if (ack.ok) {
      relay.acked = true
      this._refreshMonitors()
    } else {
      this.relayTried.set(ack.want + ':' + relayPeer.key, Date.now())
      this.relays.delete(ack.want)
    }
    this.onChange()
  }

  // Ajoute à la connexion `requester` les pistes reçues de `source`.
  _forwardTo (requester, source) {
    if (!requester || !source) return
    let added = false
    for (const stream of source.streams.values()) {
      const { origin, kind } = this._attribution(source, stream.id)
      if (origin !== source.key) continue // on ne relaie pas un flux déjà relayé
      for (const track of stream.getTracks()) {
        if (track.readyState !== 'live' || [...requester.fwdSenders.values()].some((f) => f.track === track)) continue
        const sender = requester.pc.addTrack(track, stream)
        requester.fwdSenders.set(sender, { sender, track, origin, kind, streamId: stream.id })
        added = true
      }
    }
    if (added) this._signal(requester, this._metaPayload(requester))
  }

  _unforward (peer, match) {
    let removed = false
    for (const [sender, f] of [...peer.fwdSenders]) {
      if (!match(f)) continue
      safely(() => peer.pc.removeTrack(sender))
      peer.fwdSenders.delete(sender)
      removed = true
    }
    if (removed) this._signal(peer, this._metaPayload(peer))
  }

  // Un flux relayé n'est audible que si on passe effectivement par ce relais
  // (évite d'entendre quelqu'un en double).
  _updateRelayedAudio () {
    for (const peer of this.peers.values()) {
      for (const [streamId, el] of peer.audioEls) {
        const { origin } = this._attribution(peer, streamId)
        if (origin === peer.key) continue
        const relay = this.relays.get(origin)
        el.muted = this.deafened || !relay || relay.via !== peer.key
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Détection de la parole (contour vert autour de l'avatar)

  // Pour chaque participant, on écoute le flux micro qui fonctionne
  // réellement : la liaison directe si elle est établie, sinon le relais.
  _refreshMonitors () {
    const best = new Map() // origine -> { stream, owner }
    for (const peer of this.peers.values()) {
      if (peer.pc.connectionState !== 'connected') continue
      for (const stream of peer.streams.values()) {
        if (!stream.getAudioTracks().length) continue
        const { origin, kind } = this._attribution(peer, stream.id)
        if (kind === 'screen' || origin === this.myKey) continue
        const relayed = origin !== peer.key
        if (relayed) {
          const relay = this.relays.get(origin)
          if (!relay || relay.via !== peer.key || best.has(origin)) continue
        }
        if (!relayed || !best.has(origin)) best.set(origin, { stream, owner: peer.key })
      }
    }
    for (const [origin, m] of [...this.monitors]) {
      if (origin === this.myKey) continue
      const want = best.get(origin)
      if (!want || want.stream !== m.stream) {
        m.source.disconnect()
        this.monitors.delete(origin)
        this.speaking.delete(origin)
      }
    }
    for (const [origin, { stream, owner }] of best) {
      if (!this.monitors.has(origin)) this._monitor(origin, stream, owner)
    }
    this._updateRelayedAudio()
  }

  _monitor (key, stream, owner) {
    try {
      if (!this.audioCtx) this.audioCtx = new AudioContext()
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {})
      const source = this.audioCtx.createMediaStreamSource(stream)
      const analyser = this.audioCtx.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      this.monitors.set(key, { source, analyser, stream, owner, data: new Float32Array(analyser.fftSize), last: 0 })
    } catch (err) {
      console.warn('Analyse audio indisponible :', err)
    }
  }

  _startSpeakingLoop () {
    if (this._speakTimer) return
    this._speakTimer = setInterval(() => {
      const now = performance.now()
      let changed = false
      for (const [key, m] of this.monitors) {
        m.analyser.getFloatTimeDomainData(m.data)
        let sum = 0
        for (let i = 0; i < m.data.length; i++) sum += m.data[i] * m.data[i]
        const rms = Math.sqrt(sum / m.data.length)
        const silenced = key === this.myKey && (this.muted || this.deafened)
        if (rms > SPEAKING_THRESHOLD && !silenced) m.last = now
        const speaking = now - m.last < SPEAKING_HOLD_MS
        if (speaking !== this.speaking.has(key)) {
          changed = true
          if (speaking) this.speaking.add(key)
          else this.speaking.delete(key)
        }
      }
      if (changed) this.onSpeaking(this.speaking)
    }, 100)
  }
}

function audioConstraints () {
  const id = storageGet('dixcord.mic')
  return { deviceId: id ? { ideal: id } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
}

function videoConstraints () {
  const id = storageGet('dixcord.camera')
  return { deviceId: id ? { ideal: id } : undefined, width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24, max: 30 } }
}

function applySink (el) {
  const id = storageGet('dixcord.speaker')
  if (typeof el.setSinkId === 'function') el.setSinkId(id || '').catch(() => {})
}

function strOrNull (v) {
  return typeof v === 'string' && v.length < 200 ? v : null
}

function safely (fn) {
  try {
    fn()
  } catch {}
}

// Vocal, vidéo et partage d'écran en WebRTC, en maillage complet : chaque
// participant d'un salon vocal est relié directement à chacun des autres.
// La signalisation (offres, réponses, candidats ICE) passe par les
// connexions Hyperswarm déjà établies : aucun serveur de signalisation.

import { storageGet, storageSet } from './ui.js'

const SPEAKING_THRESHOLD = 0.015
const SPEAKING_HOLD_MS = 350
const PENDING_SIGNAL_TTL = 15000
// Délai avant de raccrocher quand un participant disparaît sans dire au revoir
// (coupure passagère du lien Hyperswarm alors que l'appel WebRTC passe encore).
const ORPHAN_GRACE_MS = 20000

export class VoiceManager {
  constructor ({ api, myKey, iceServers, platform, onChange, onSpeaking, onError }) {
    this.api = api
    this.myKey = myKey
    this.iceServers = iceServers
    this.platform = platform
    this.onChange = onChange
    this.onSpeaking = onSpeaking
    this.onError = onError

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

    this.audioCtx = null
    this.monitors = new Map()
    this.speaking = new Set()
    this._speakTimer = null
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
      if (this.micStream) this._monitor(this.myKey, this.micStream)
      this._startSpeakingLoop()
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
    for (const stream of [this.micStream, this.cameraStream, this.screenStream]) {
      if (stream) stream.getTracks().forEach((t) => t.stop())
    }
    this.micStream = this.cameraStream = this.screenStream = null
    for (const m of this.monitors.values()) m.source.disconnect()
    this.monitors.clear()
    this.speaking.clear()
    clearInterval(this._speakTimer)
    this._speakTimer = null
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
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: this.platform === 'win32' })
    if (!this.serverId) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    if (this.screenStream) this.stopScreen()
    this.screenStream = stream
    stream.getVideoTracks()[0].addEventListener('ended', () => {
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

  // Flux vidéo à afficher : caméras et écrans, locaux et distants.
  videoTiles () {
    const tiles = []
    if (this.cameraStream) tiles.push({ key: this.myKey, kind: 'camera', stream: this.cameraStream, local: true })
    if (this.screenStream) tiles.push({ key: this.myKey, kind: 'screen', stream: this.screenStream, local: true })
    for (const peer of this.peers.values()) {
      for (const stream of peer.streams.values()) {
        if (!stream.getVideoTracks().some((t) => t.readyState === 'live')) continue
        tiles.push({ key: peer.key, kind: stream.id === peer.meta.screen ? 'screen' : 'camera', stream, local: false })
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
      remoteTracks: [...p.streams.values()].flatMap((s) => s.getTracks().map((t) => t.kind))
    }))
  }

  // ---------------------------------------------------------------------------
  // Connexions WebRTC (« perfect negotiation »)

  _openPeer (key) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers })
    const peer = {
      key,
      pc,
      sid: Math.random().toString(36).slice(2, 12), // identifie cette connexion
      remoteSid: null,
      orphanTimer: null,
      polite: this.myKey > key,
      makingOffer: false,
      ignoreOffer: false,
      queue: Promise.resolve(),
      senders: { audio: null, camera: null, screen: [] },
      streams: new Map(),
      audioEls: new Map(),
      meta: { camera: null, screen: null }
    }
    this.peers.set(key, peer)

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this._signal(peer, { candidate: candidate.toJSON() })
    }
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true
        await pc.setLocalDescription()
        this._signal(peer, { description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } })
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
      this.onChange()
    }

    const mic = this.micStream && this.micStream.getAudioTracks()[0]
    if (mic) peer.senders.audio = pc.addTrack(mic, this.micStream)
    else pc.addTransceiver('audio', { direction: 'recvonly' })
    const cam = this.cameraStream && this.cameraStream.getVideoTracks()[0]
    if (cam) peer.senders.camera = pc.addTrack(cam, this.cameraStream)
    if (this.screenStream) peer.senders.screen = this.screenStream.getTracks().map((t) => pc.addTrack(t, this.screenStream))
    this._signal(peer, this._metaPayload())

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
    const monitor = this.monitors.get(key)
    if (monitor) monitor.source.disconnect()
    this.monitors.delete(key)
    this.speaking.delete(key)
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
      peer.meta = { camera: strOrNull(data.meta.camera), screen: strOrNull(data.meta.screen) }
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
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate)
      } catch (err) {
        if (!peer.ignoreOffer) throw err
      }
    }
  }

  _onTrack (peer, ev) {
    const stream = ev.streams[0] || new MediaStream([ev.track])
    if (!peer.streams.has(stream.id)) {
      peer.streams.set(stream.id, stream)
      stream.addEventListener('removetrack', () => {
        if (stream.getTracks().length === 0) {
          peer.streams.delete(stream.id)
          const el = peer.audioEls.get(stream.id)
          if (el) {
            el.srcObject = null
            peer.audioEls.delete(stream.id)
          }
        }
        this.onChange()
      })
    }
    if (ev.track.kind === 'audio') {
      if (!peer.audioEls.has(stream.id)) {
        const el = new Audio()
        el.autoplay = true
        el.srcObject = stream
        el.muted = this.deafened
        applySink(el)
        el.play().catch(() => {})
        peer.audioEls.set(stream.id, el)
      }
      if (stream.id !== peer.meta.screen && !this.monitors.has(peer.key)) this._monitor(peer.key, stream)
    }
    for (const type of ['mute', 'unmute', 'ended']) ev.track.addEventListener(type, () => this.onChange())
    this.onChange()
  }

  // N'envoie que pour la connexion courante d'un pair (pas une ancienne).
  _signal (peer, data) {
    if (this.serverId && this.peers.get(peer.key) === peer) {
      this.api.sendRtc(this.serverId, peer.key, { ...data, sid: peer.sid }).catch(() => {})
    }
  }

  _metaPayload () {
    return { meta: { camera: this.cameraStream ? this.cameraStream.id : null, screen: this.screenStream ? this.screenStream.id : null } }
  }

  _sendMetaAll () {
    for (const peer of this.peers.values()) this._signal(peer, this._metaPayload())
  }

  // ---------------------------------------------------------------------------
  // Détection de la parole (contour vert autour de l'avatar)

  _monitor (key, stream) {
    try {
      if (!this.audioCtx) this.audioCtx = new AudioContext()
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {})
      const source = this.audioCtx.createMediaStreamSource(stream)
      const analyser = this.audioCtx.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      this.monitors.set(key, { source, analyser, data: new Float32Array(analyser.fftSize), last: 0 })
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
  return { deviceId: id ? { ideal: id } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } }
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

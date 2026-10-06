import {
  h, clear, classes, icon, avatar, colorFor, nameColorFor, initials, dayKey, formatDay, formatTime,
  formatStamp, formatSize, linkify, openModal, toast, popupMenu, storageGet, storageSet
} from './ui.js'
import { VoiceManager } from './voice.js'

const api = window.dixcord
const $ = (sel) => document.querySelector(sel)

const AUTO_DOWNLOAD_MAX = 8 * 1024 * 1024
const GROUP_WINDOW = 7 * 60 * 1000
const MAX_PENDING = 10

const state = {
  me: null,
  servers: [],
  serverId: null,
  server: null, // vue du serveur courant (salons, membres, vocal)
  channelId: null, // salon textuel affiché
  view: 'empty', // 'chat' | 'voice' | 'empty'
  voiceViewChannel: null,
  voiceLabel: null, // { channel, server } du vocal en cours
  messages: [],
  hasMore: false,
  loadingMore: false,
  stickToBottom: true,
  unread: new Map(), // "serveur:salon" -> nombre
  lastChannel: new Map(),
  pending: [], // pièces jointes en attente d'envoi
  downloads: new Map(), // empreinte -> { received, size }
  failed: new Set(),
  focusedTile: null,
  namesSignature: ''
}

let voice = null
const videoEls = new Map()

// -----------------------------------------------------------------------------
// Démarrage

async function boot () {
  const init = await api.init()
  state.me = init.me
  state.servers = init.servers
  voice = new VoiceManager({
    api,
    myKey: init.me.key,
    iceServers: init.iceServers,
    platform: init.platform,
    noDirect: init.noDirect,
    onChange: onVoiceChange,
    onSpeaking: updateSpeaking,
    onError: (message) => toast(message, 'error')
  })
  window.__dixcord = { state, voice } // diagnostic
  api.onEvent(onEvent)
  bindStaticHandlers()
  if (state.servers.length) await selectServer(state.servers[0].id)
  else renderAll()
  if (!state.me.named) showWelcome()
}

function onEvent (ev) {
  switch (ev.type) {
    case 'messages':
      return onMessages(ev.serverId, ev.messages)
    case 'server-changed':
      return scheduleServerRefresh(ev.serverId)
    case 'servers':
      state.servers = ev.servers
      if (state.serverId && !state.servers.some((s) => s.id === state.serverId)) {
        selectServer(state.servers.length ? state.servers[0].id : null)
      } else {
        renderServerBar()
        if (state.server) {
          const s = state.servers.find((x) => x.id === state.serverId)
          if (s && s.name !== state.server.name) scheduleServerRefresh(state.serverId)
        }
      }
      return
    case 'voice':
      voice.updateVoiceMap(ev.serverId, ev.voice)
      if (ev.serverId === state.serverId && state.server) {
        state.server.voice = ev.voice
        renderChannels()
        if (state.view === 'voice') renderVoiceView()
      }
      return
    case 'rtc':
      return voice.handleSignal(ev.serverId, ev.from, ev.data)
    case 'download':
      if (ev.status === 'progress') {
        state.downloads.set(ev.hash, { received: ev.received, size: ev.size })
        refreshAttachments(ev.hash)
      }
      return
    case 'me':
      state.me = ev.me
      renderUserPanel()
  }
}

// -----------------------------------------------------------------------------
// Navigation

async function selectServer (id) {
  if (!id) {
    state.serverId = null
    state.server = null
    state.channelId = null
    state.view = 'empty'
    state.messages = []
    renderAll()
    return
  }
  let view
  try {
    view = await api.getServer(id)
  } catch (err) {
    toast(err.message, 'error')
    return
  }
  state.serverId = id
  state.server = view
  state.namesSignature = namesSignature(view)
  voice.updateVoiceMap(id, view.voice)
  const texts = view.channels.filter((c) => c.kind === 'text')
  const last = state.lastChannel.get(id)
  state.channelId = texts.some((c) => c.id === last) ? last : texts.length ? texts[0].id : null
  state.view = voice.serverId === id && voice.channelId && state.voiceViewChannel === voice.channelId ? 'voice' : 'chat'
  if (state.view === 'chat' && !state.channelId) state.view = 'empty'
  state.messages = []
  state.pending = []
  renderAll()
  await loadMessages()
}

function selectTextChannel (channelId) {
  state.channelId = channelId
  state.lastChannel.set(state.serverId, channelId)
  state.view = 'chat'
  state.unread.delete(state.serverId + ':' + channelId)
  state.pending = []
  renderServerBar()
  renderChannels()
  renderMain()
  renderPending()
  loadMessages()
  $('#composer-input').focus()
}

async function openVoiceChannel (channelId) {
  state.view = 'voice'
  state.voiceViewChannel = channelId
  renderChannels()
  renderMain()
  if (voice.serverId === state.serverId && voice.channelId === channelId) return
  const channel = findChannel(channelId)
  state.voiceLabel = { channel: channel ? channel.name : '', server: state.server.name }
  try {
    await voice.join(state.serverId, channelId)
  } catch (err) {
    toast(err.message, 'error')
  }
}

function goToVoice () {
  if (!voice.serverId) return
  const open = () => {
    state.view = 'voice'
    state.voiceViewChannel = voice.channelId
    renderChannels()
    renderMain()
  }
  if (state.serverId === voice.serverId) open()
  else {
    state.voiceViewChannel = voice.channelId
    selectServer(voice.serverId).then(open)
  }
}

function findChannel (id) {
  return state.server ? state.server.channels.find((c) => c.id === id) || null : null
}

const refreshTimers = new Map()
function scheduleServerRefresh (serverId) {
  if (serverId !== state.serverId || refreshTimers.has(serverId)) return
  refreshTimers.set(serverId, setTimeout(() => {
    refreshTimers.delete(serverId)
    if (serverId === state.serverId) refreshServer()
  }, 80))
}

async function refreshServer () {
  const id = state.serverId
  let view
  try {
    view = await api.getServer(id)
  } catch {
    return
  }
  if (id !== state.serverId) return
  state.server = view
  voice.updateVoiceMap(id, view.voice)

  // Salon textuel supprimé ou premier salon reçu après synchronisation.
  const texts = view.channels.filter((c) => c.kind === 'text')
  if (!texts.some((c) => c.id === state.channelId)) {
    state.channelId = texts.length ? texts[0].id : null
    if (state.view !== 'voice') state.view = state.channelId ? 'chat' : 'empty'
    loadMessages()
  }
  if (voice.serverId === id && !view.channels.some((c) => c.id === voice.channelId)) {
    voice.leave()
    toast('Le salon vocal a été supprimé.')
  }
  if (state.view === 'voice' && !view.channels.some((c) => c.id === state.voiceViewChannel)) {
    state.view = state.channelId ? 'chat' : 'empty'
  }
  if (voice.serverId === id && state.voiceLabel) {
    const vc = findChannel(voice.channelId)
    if (vc) state.voiceLabel = { channel: vc.name, server: view.name }
  }

  const signature = namesSignature(view)
  const namesChanged = signature !== state.namesSignature
  state.namesSignature = signature
  renderServerHeader()
  renderChannels()
  renderMembers()
  renderMain()
  renderUserPanel()
  if (namesChanged && state.view === 'chat') renderMessages()
}

function namesSignature (view) {
  return view.members.map((m) => m.key + '=' + m.name).join('|')
}

function memberName (key, fallback) {
  const m = state.server && state.server.members.find((x) => x.key === key)
  return m ? m.name : fallback || 'Anonyme-' + key.slice(0, 4)
}

// -----------------------------------------------------------------------------
// Messages

async function loadMessages () {
  const { serverId, channelId } = state
  state.messages = []
  state.hasMore = false
  if (!serverId || !channelId) return renderMessages()
  let res
  try {
    res = await api.getMessages(serverId, channelId, { limit: 100 })
  } catch (err) {
    return toast(err.message, 'error')
  }
  if (serverId !== state.serverId || channelId !== state.channelId) return
  state.messages = res.messages
  state.hasMore = res.hasMore
  state.stickToBottom = true
  renderMessages()
  autoDownload(state.messages)
}

async function loadOlder () {
  if (!state.hasMore || state.loadingMore || !state.messages.length) return
  state.loadingMore = true
  const { serverId, channelId } = state
  try {
    const res = await api.getMessages(serverId, channelId, { limit: 100, beforeId: state.messages[0].id })
    if (serverId !== state.serverId || channelId !== state.channelId) return
    const container = $('#messages')
    const fromBottom = container.scrollHeight - container.scrollTop
    state.messages = res.messages.concat(state.messages)
    state.hasMore = res.hasMore
    renderMessages({ preserve: fromBottom })
    autoDownload(res.messages)
  } catch (err) {
    toast(err.message, 'error')
  } finally {
    state.loadingMore = false
  }
}

function compareMessages (a, b) {
  return a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

function onMessages (serverId, messages) {
  let currentChanged = false
  for (const m of messages) {
    const current = serverId === state.serverId && m.channel === state.channelId && state.view === 'chat'
    const visibleChannel = serverId === state.serverId && m.channel === state.channelId
    if (visibleChannel) {
      if (!state.messages.some((x) => x.id === m.id)) {
        state.messages.push(m)
        currentChanged = true
      }
    }
    const fromOther = m.author !== state.me.key
    if (fromOther && !current) {
      const k = serverId + ':' + m.channel
      state.unread.set(k, (state.unread.get(k) || 0) + 1)
    }
    if (fromOther && Date.now() - m.ts < 60000 && !document.hasFocus()) notify(serverId, m)
  }
  if (currentChanged) {
    state.messages.sort(compareMessages)
    renderMessages()
    autoDownload(messages.filter((m) => serverId === state.serverId && m.channel === state.channelId))
  }
  renderServerBar()
  if (serverId === state.serverId) renderChannels()
  updateTitle()
}

function notify (serverId, m) {
  if (typeof Notification === 'undefined') return
  const server = state.servers.find((s) => s.id === serverId)
  const body = m.text ? m.text.slice(0, 200) : `📎 ${m.files.length} fichier(s)`
  try {
    const n = new Notification(`${m.authorName} — ${server ? server.name : 'Dixcord'}`, { body, silent: false })
    n.onclick = async () => {
      window.focus()
      if (state.serverId !== serverId) await selectServer(serverId)
      if (findChannel(m.channel)) selectTextChannel(m.channel)
    }
  } catch {}
}

function updateTitle () {
  let total = 0
  for (const n of state.unread.values()) total += n
  document.title = total ? `(${total}) Dixcord` : 'Dixcord'
}

function renderMessages ({ preserve = null } = {}) {
  const container = $('#messages')
  clear(container)
  const channel = findChannel(state.channelId)
  if (!channel) return

  if (state.hasMore) {
    container.append(h('button', { class: 'load-more', type: 'button', onclick: loadOlder }, 'Charger les messages précédents'))
  } else {
    container.append(h('div', { class: 'channel-start' },
      h('div', { class: 'channel-start-icon' }, icon('hash', 40)),
      h('h2', {}, `Bienvenue dans #${channel.name} !`),
      h('p', {}, `C’est le début du salon #${channel.name}. Les messages sont stockés chez chaque membre et se synchronisent entre vous.`)
    ))
  }

  let prev = null
  for (const m of state.messages) {
    const newDay = !prev || dayKey(prev.ts) !== dayKey(m.ts)
    if (newDay) container.append(h('div', { class: 'day-divider' }, h('span', {}, formatDay(m.ts))))
    const grouped = !newDay && prev.author === m.author && m.ts - prev.ts < GROUP_WINDOW
    container.append(renderMessage(m, grouped))
    prev = m
  }

  if (preserve !== null) container.scrollTop = container.scrollHeight - preserve
  else if (state.stickToBottom) container.scrollTop = container.scrollHeight
}

function renderMessage (m, grouped) {
  const name = memberName(m.author, m.authorName)
  const author = h('span', { class: 'author' }, name)
  author.style.color = nameColorFor(m.author)
  return h('div', { class: classes('message', { grouped }), dataset: { id: m.id } },
    h('div', { class: 'gutter' },
      grouped ? h('time', { class: 'hover-time', title: new Date(m.ts).toLocaleString('fr-FR') }, formatTime(m.ts)) : avatar(m.author, name, 40)
    ),
    h('div', { class: 'message-content' },
      grouped ? null : h('div', { class: 'message-header' }, author, h('time', { class: 'timestamp', title: new Date(m.ts).toLocaleString('fr-FR') }, formatStamp(m.ts))),
      m.text ? h('div', { class: 'message-text' }, linkify(m.text, openLink)) : null,
      m.files.length ? h('div', { class: 'attachments' }, m.files.map((f) => renderAttachment(m.serverId, f))) : null
    )
  )
}

function openLink (url) {
  api.openExternal(url).catch((err) => toast(err.message, 'error'))
}

// -----------------------------------------------------------------------------
// Pièces jointes

const isImage = (mime) => /^image\/(png|jpeg|gif|webp|bmp)$/.test(mime)
const isVideo = (mime) => /^video\/(mp4|webm)$/.test(mime)
const isAudio = (mime) => /^audio\/(mpeg|ogg|wav|mp4|flac)$/.test(mime)

function renderAttachment (serverId, f) {
  const wrap = h('div', { class: 'attachment', dataset: { hash: f.hash } })
  fillAttachment(wrap, serverId, f)
  return wrap
}

function fillAttachment (wrap, serverId, f) {
  clear(wrap)
  const url = 'dxc://file/' + f.hash
  const save = () => api.saveFile(f.hash).then((ok) => ok && toast('Fichier enregistré.')).catch((err) => toast(err.message, 'error'))

  if (f.local && isImage(f.mime)) {
    const img = h('img', { class: 'attachment-image', src: url, alt: f.name, title: f.name, onclick: () => showImage(url, f, save) })
    img.addEventListener('load', keepBottom)
    wrap.append(img, h('button', { class: 'attachment-save', type: 'button', title: 'Enregistrer', onclick: save }, icon('download', 18)))
    return
  }
  if (f.local && isVideo(f.mime)) {
    const video = h('video', { class: 'attachment-video', src: url, controls: true, preload: 'metadata' })
    video.addEventListener('loadedmetadata', keepBottom)
    wrap.append(video)
  }

  const progress = state.downloads.get(f.hash)
  const failed = state.failed.has(f.hash)
  let action
  if (f.local) action = h('button', { class: 'icon-btn', type: 'button', title: 'Enregistrer sous…', onclick: save }, icon('download', 22))
  else if (progress) action = h('div', { class: 'spinner', title: 'Téléchargement…' })
  else action = h('button', { class: 'icon-btn', type: 'button', title: 'Télécharger', onclick: () => startDownload(serverId, f, false) }, icon('download', 22))

  let sizeText = formatSize(f.size)
  if (progress) sizeText = `${formatSize(progress.received)} / ${formatSize(f.size)}`
  const card = h('div', { class: 'file-card' },
    h('div', { class: 'file-icon' }, icon('file', 30)),
    h('div', { class: 'file-meta' },
      h('div', { class: 'file-name', title: f.name }, f.name),
      h('div', { class: 'file-size' }, sizeText),
      progress ? h('div', { class: 'progress' }, progressBar(progress.received / Math.max(1, f.size))) : null,
      failed && !f.local ? h('div', { class: 'file-error' }, 'Aucun membre connecté ne l’a pour l’instant. Réessaie plus tard.') : null
    ),
    action
  )
  wrap.append(card)
  if (f.local && isAudio(f.mime)) wrap.append(h('audio', { class: 'attachment-audio', src: url, controls: true, preload: 'none' }))
}

function progressBar (ratio) {
  const bar = h('div', { class: 'progress-bar' })
  bar.style.width = Math.round(Math.min(1, ratio) * 100) + '%'
  return bar
}

function keepBottom () {
  if (state.stickToBottom) {
    const c = $('#messages')
    c.scrollTop = c.scrollHeight
  }
}

function autoDownload (messages) {
  for (const m of messages) {
    for (const f of m.files) {
      const media = isImage(f.mime) || isVideo(f.mime)
      if (!f.local && media && f.size <= AUTO_DOWNLOAD_MAX && !state.failed.has(f.hash) && !state.downloads.has(f.hash)) {
        startDownload(m.serverId, f, true)
      }
    }
  }
}

async function startDownload (serverId, f, auto) {
  state.failed.delete(f.hash)
  state.downloads.set(f.hash, { received: 0, size: f.size })
  refreshAttachments(f.hash)
  try {
    await api.downloadFile(serverId, f.hash)
    for (const m of state.messages) for (const x of m.files) if (x.hash === f.hash) x.local = true
    f.local = true
  } catch (err) {
    state.failed.add(f.hash)
    if (!auto) toast(err.message, 'error')
  } finally {
    state.downloads.delete(f.hash)
    refreshAttachments(f.hash)
  }
}

function refreshAttachments (hash) {
  for (const wrap of document.querySelectorAll(`.attachment[data-hash="${hash}"]`)) {
    const id = wrap.closest('.message')?.dataset.id
    const m = state.messages.find((x) => x.id === id)
    const f = m && m.files.find((x) => x.hash === hash)
    if (f) fillAttachment(wrap, m.serverId, f)
  }
}

function showImage (url, f, save) {
  openModal({
    title: f.name,
    className: 'image-modal',
    body: h('img', { class: 'lightbox-image', src: url, alt: f.name }),
    actions: [{ label: 'Enregistrer', kind: 'secondary', onClick: save }, { label: 'Fermer', kind: 'primary' }]
  })
}

// -----------------------------------------------------------------------------
// Zone de saisie

function bindStaticHandlers () {
  const input = $('#composer-input')
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      sendCurrent()
    }
  })
  input.addEventListener('input', autoResize)
  input.addEventListener('paste', onPaste)
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault()
    sendCurrent()
  })
  $('#attach-btn').addEventListener('click', async () => {
    try {
      const paths = await api.pickFiles()
      for (const p of paths) addPending({ path: p, name: p.split(/[\\/]/).pop() })
    } catch (err) {
      toast(err.message, 'error')
    }
  })

  const chat = $('#chat-view')
  let dragDepth = 0
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files')
  chat.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || !state.channelId) return
    dragDepth++
    chat.classList.add('dragging')
  })
  chat.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0
      chat.classList.remove('dragging')
    }
  })
  chat.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault()
  })
  chat.addEventListener('drop', async (e) => {
    e.preventDefault()
    dragDepth = 0
    chat.classList.remove('dragging')
    if (!state.channelId) return
    for (const file of e.dataTransfer.files) await addFile(file)
  })

  const messages = $('#messages')
  messages.addEventListener('scroll', () => {
    state.stickToBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60
    if (messages.scrollTop < 40) loadOlder()
  })

  window.addEventListener('focus', () => {
    if (state.view === 'chat' && state.serverId && state.channelId) {
      state.unread.delete(state.serverId + ':' + state.channelId)
      renderServerBar()
      renderChannels()
      updateTitle()
    }
  })
}

async function addFile (file) {
  let path = ''
  try {
    path = api.pathForFile(file)
  } catch {}
  if (path) return addPending({ path, name: file.name, size: file.size })
  if (file.size > 100 * 1024 * 1024) return toast('Fichier trop volumineux (100 Mo max).', 'error')
  addPending({ name: file.name || `image-${Date.now()}.png`, size: file.size, data: new Uint8Array(await file.arrayBuffer()) })
}

async function onPaste (e) {
  const files = [...(e.clipboardData ? e.clipboardData.files : [])]
  if (!files.length) return
  e.preventDefault()
  for (const file of files) await addFile(file)
}

function addPending (item) {
  if (state.pending.length >= MAX_PENDING) return toast(`${MAX_PENDING} fichiers maximum par message.`, 'error')
  state.pending.push(item)
  renderPending()
}

function renderPending () {
  const box = $('#pending-files')
  clear(box)
  box.hidden = state.pending.length === 0
  state.pending.forEach((p, i) => {
    box.append(h('div', { class: 'pending-file', title: p.name },
      icon('file', 18),
      h('span', { class: 'pending-name' }, p.name),
      p.size ? h('span', { class: 'pending-size' }, formatSize(p.size)) : null,
      h('button', {
        class: 'icon-btn small',
        type: 'button',
        title: 'Retirer',
        onclick: () => {
          state.pending.splice(i, 1)
          renderPending()
        }
      }, icon('x', 14))
    ))
  })
}

function autoResize () {
  const input = $('#composer-input')
  input.style.height = 'auto'
  input.style.height = Math.min(input.scrollHeight, 220) + 'px'
}

async function sendCurrent () {
  const input = $('#composer-input')
  const text = input.value
  if (!text.trim() && !state.pending.length) return
  if (!state.serverId || !state.channelId) return
  const pending = state.pending
  const attachments = pending.map((p) => (p.path ? { path: p.path } : { name: p.name, data: p.data }))
  input.value = ''
  state.pending = []
  renderPending()
  autoResize()
  state.stickToBottom = true
  try {
    await api.sendMessage(state.serverId, state.channelId, text, attachments)
  } catch (err) {
    input.value = text
    state.pending = pending
    renderPending()
    autoResize()
    toast(err.message, 'error')
  }
}

// -----------------------------------------------------------------------------
// Rendu de la structure

function renderAll () {
  renderServerBar()
  renderServerHeader()
  renderChannels()
  renderMembers()
  renderUserPanel()
  renderMain()
  renderPending()
  renderMessages()
  updateTitle()
}

function renderServerBar () {
  const bar = $('#server-bar')
  clear(bar)
  for (const s of state.servers) {
    const active = s.id === state.serverId
    const unread = [...state.unread.keys()].some((k) => k.startsWith(s.id + ':'))
    const btn = h('button', { class: classes('server-icon', { active }), type: 'button', title: s.name, onclick: () => selectServer(s.id) }, initials(s.name))
    btn.style.setProperty('--server-color', colorFor(s.id))
    bar.append(h('div', { class: classes('server-item', { active, unread }) }, h('span', { class: 'pill' }), btn))
  }
  if (state.servers.length) bar.append(h('div', { class: 'server-separator' }))
  bar.append(h('div', { class: 'server-item' }, h('span', { class: 'pill' }),
    h('button', { class: 'server-icon add', type: 'button', title: 'Créer ou rejoindre un serveur', onclick: showAddServer }, icon('plus', 24))))
}

function renderServerHeader () {
  const header = $('#server-header')
  clear(header)
  if (!state.server) {
    header.append(h('div', { class: 'server-title static' }, 'Dixcord'))
    return
  }
  header.append(h('button', { class: 'server-title', type: 'button', onclick: (e) => showServerMenu(e.currentTarget) },
    h('span', { class: 'server-title-text' }, state.server.name), icon('chevron-down', 18)))
}

function renderChannels () {
  const list = $('#channel-list')
  clear(list)
  if (!state.server) return
  const channels = state.server.channels
  if (!channels.length) {
    list.append(h('div', { class: 'sync-hint' }, 'Synchronisation en attente… Les salons apparaîtront dès qu’un autre membre du serveur sera en ligne.'))
  }
  list.append(sectionHeader('Salons textuels', () => showCreateChannel('text')))
  for (const c of channels.filter((x) => x.kind === 'text')) list.append(channelItem(c))
  list.append(sectionHeader('Salons vocaux', () => showCreateChannel('voice')))
  for (const c of channels.filter((x) => x.kind === 'voice')) {
    list.append(channelItem(c))
    const members = state.server.voice[c.id] || []
    if (members.length) list.append(voiceMembersList(members))
  }
}

function sectionHeader (label, onAdd) {
  return h('div', { class: 'section-header' },
    h('span', {}, label),
    h('button', { class: 'icon-btn small', type: 'button', title: 'Créer un salon', onclick: onAdd }, icon('plus', 16)))
}

function channelItem (c) {
  const active = c.kind === 'text' ? state.view === 'chat' && c.id === state.channelId : state.view === 'voice' && c.id === state.voiceViewChannel
  const unread = c.kind === 'text' && !active && state.unread.has(state.serverId + ':' + c.id)
  const connected = c.kind === 'voice' && voice.serverId === state.serverId && voice.channelId === c.id
  return h('div', {
    class: classes('channel', c.kind, { active, unread, connected }),
    role: 'button',
    tabindex: '0',
    title: c.name,
    dataset: { channel: c.id },
    onclick: () => (c.kind === 'text' ? selectTextChannel(c.id) : openVoiceChannel(c.id)),
    onkeydown: (e) => { if (e.key === 'Enter') e.currentTarget.click() }
  },
  icon(c.kind === 'text' ? 'hash' : 'volume', 20),
  h('span', { class: 'channel-name' }, c.name),
  h('span', { class: 'channel-actions' },
    h('button', { class: 'icon-btn small', type: 'button', title: 'Renommer', onclick: (e) => { e.stopPropagation(); showRenameChannel(c) } }, icon('edit', 15)),
    h('button', { class: 'icon-btn small', type: 'button', title: 'Supprimer', onclick: (e) => { e.stopPropagation(); confirmDeleteChannel(c) } }, icon('trash', 15))
  ))
}

function voiceMembersList (members) {
  return h('div', { class: 'voice-members' }, members.map((m) =>
    h('div', { class: classes('voice-member', { speaking: voice.speaking.has(m.key) }), dataset: { key: m.key } },
      avatar(m.key, m.name, 24),
      h('span', { class: 'voice-member-name' }, m.name),
      m.screen ? h('span', { class: 'live-badge' }, 'EN DIRECT') : null,
      m.video ? icon('video', 14) : null,
      m.deaf ? icon('headphones-off', 14) : m.mute ? icon('mic-off', 14) : null
    )
  ))
}

function renderMembers () {
  const list = $('#member-list')
  clear(list)
  if (!state.server) return
  const online = state.server.members.filter((m) => m.online)
  const offline = state.server.members.filter((m) => !m.online)
  const row = (m) => {
    const av = avatar(m.key, m.name, 32)
    const how = m.relayed ? '\nConnecté via un autre membre (pas de liaison directe)' : ''
    return h('div', { class: classes('member', { offline: !m.online }), title: 'Clé : ' + m.key + how },
      h('div', { class: 'avatar-wrap' }, av, h('span', { class: classes('status-dot', { online: m.online }) })),
      h('span', { class: 'member-name' }, m.name, m.me ? h('span', { class: 'me-tag' }, ' (toi)') : null))
  }
  list.append(h('h3', {}, `En ligne — ${online.length}`), ...online.map(row))
  if (offline.length) list.append(h('h3', {}, `Hors ligne — ${offline.length}`), ...offline.map(row))
}

function renderUserPanel () {
  const status = $('#voice-status')
  clear(status)
  status.hidden = !voice.serverId
  if (voice.serverId) {
    const label = state.voiceLabel || { channel: '', server: '' }
    status.append(
      h('div', { class: 'voice-status-row' },
        h('button', { class: 'voice-status-info', type: 'button', onclick: goToVoice, title: 'Afficher le salon vocal' },
          h('div', { class: 'voice-connected' }, 'Vocal connecté'),
          h('div', { class: 'voice-where' }, `${label.channel} / ${label.server}`)),
        h('button', { class: 'icon-btn', type: 'button', title: 'Se déconnecter du vocal', onclick: () => voice.leave() }, icon('phone-off', 20))
      ),
      h('div', { class: 'voice-status-actions' },
        h('button', { class: classes('pill-btn', { on: !!voice.cameraStream }), type: 'button', onclick: toggleCamera }, icon(voice.cameraStream ? 'video' : 'video-off', 18), 'Caméra'),
        h('button', { class: classes('pill-btn', { on: !!voice.screenStream }), type: 'button', onclick: toggleScreen }, icon('monitor', 18), 'Écran')
      )
    )
  }

  const panel = $('#user-panel')
  clear(panel)
  if (!state.me) return
  const micOff = voice.muted || voice.deafened
  panel.append(
    h('div', { class: 'avatar-wrap' }, avatar(state.me.key, state.me.name, 32), h('span', { class: 'status-dot online' })),
    h('div', { class: 'user-info', title: 'Ta clé publique : ' + state.me.key },
      h('div', { class: 'user-name' }, state.me.name),
      h('div', { class: 'user-tag' }, '#' + state.me.key.slice(0, 8))),
    h('button', { class: classes('icon-btn', { danger: micOff }), type: 'button', title: micOff ? 'Réactiver le micro' : 'Couper le micro', onclick: () => voice.setMuted(!micOff) }, icon(micOff ? 'mic-off' : 'mic', 20)),
    h('button', { class: classes('icon-btn', { danger: voice.deafened }), type: 'button', title: voice.deafened ? 'Réactiver le son' : 'Couper le son', onclick: () => voice.setDeafened(!voice.deafened) }, icon(voice.deafened ? 'headphones-off' : 'headphones', 20)),
    h('button', { class: 'icon-btn', type: 'button', title: 'Paramètres', onclick: showSettings }, icon('settings', 20))
  )
}

function renderMain () {
  $('#chat-view').hidden = state.view !== 'chat'
  $('#voice-view').hidden = state.view !== 'voice'
  $('#empty-view').hidden = state.view !== 'empty'
  renderChannelHeader()
  if (state.view === 'voice') renderVoiceView()
  if (state.view === 'empty') renderEmpty()
  if (state.view === 'chat') {
    const c = findChannel(state.channelId)
    $('#composer-input').placeholder = c ? `Envoyer un message dans #${c.name}` : ''
  }
}

function renderChannelHeader () {
  const header = $('#channel-header')
  clear(header)
  if (state.view === 'chat') {
    const c = findChannel(state.channelId)
    if (c) header.append(icon('hash', 24), h('h1', {}, c.name))
  } else if (state.view === 'voice') {
    const c = findChannel(state.voiceViewChannel)
    if (c) header.append(icon('volume', 24), h('h1', {}, c.name))
  }
  header.append(h('div', { class: 'header-spacer' }))
  if (state.server) {
    const online = state.server.members.filter((m) => m.online && !m.me).length
    header.append(
      h('span', { class: 'peer-count', title: 'Membres connectés directement à toi' }, icon('users', 18), String(online)),
      h('button', { class: 'icon-btn', type: 'button', title: 'Inviter des amis', onclick: showInvite }, icon('user-plus', 22))
    )
  }
}

function renderEmpty () {
  const view = $('#empty-view')
  clear(view)
  if (!state.server) {
    view.append(h('div', { class: 'empty-card' },
      h('div', { class: 'logo' }, 'Dx'),
      h('h2', {}, 'Bienvenue sur Dixcord'),
      h('p', {}, 'Un Discord maison sans aucun serveur : les messages, fichiers et appels passent directement d’un membre à l’autre.'),
      h('div', { class: 'empty-actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => showAddServer('create') }, 'Créer un serveur'),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => showAddServer('join') }, 'Rejoindre avec une invitation'))
    ))
    return
  }
  view.append(h('div', { class: 'empty-card' },
    h('h2', {}, 'Aucun salon textuel'),
    h('p', {}, state.server.channels.length
      ? 'Crée un salon textuel avec le bouton + à côté de « Salons textuels ».'
      : 'Les salons de ce serveur apparaîtront dès qu’un autre membre sera en ligne. Tu peux aussi en créer un.'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => showCreateChannel('text') }, 'Créer un salon textuel')
  ))
}

// -----------------------------------------------------------------------------
// Vocal

function onVoiceChange () {
  renderUserPanel()
  if (state.server) renderChannels()
  if (state.view === 'voice') renderVoiceView()
}

function updateSpeaking (speaking) {
  for (const el of document.querySelectorAll('[data-key]')) el.classList.toggle('speaking', speaking.has(el.dataset.key))
}

function videoFor (stream, { mirror = false } = {}) {
  let el = videoEls.get(stream.id)
  if (!el) {
    el = h('video', { autoplay: true, playsInline: true, muted: true })
    videoEls.set(stream.id, el)
  }
  // Un flux relayé peut porter le même identifiant qu'un autre flux.
  if (el.srcObject !== stream) el.srcObject = stream
  el.classList.toggle('mirror', mirror)
  el.play().catch(() => {})
  return el
}

function renderVoiceView () {
  const view = $('#voice-view')
  const channel = findChannel(state.voiceViewChannel)
  clear(view)
  if (!channel) return
  const here = voice.serverId === state.serverId && voice.channelId === channel.id
  const members = state.server.voice[channel.id] || []
  const tiles = here ? voice.videoTiles() : []

  // Libère les éléments vidéo des flux disparus.
  const live = new Set(tiles.map((t) => t.stream.id))
  for (const [id, el] of videoEls) {
    if (!live.has(id)) {
      el.srcObject = null
      videoEls.delete(id)
    }
  }

  const grid = h('div', { class: 'voice-grid' })
  if (!members.length) grid.append(h('div', { class: 'voice-empty' }, here ? 'Connexion…' : 'Personne n’est dans ce salon pour l’instant.'))
  for (const m of members) {
    const cam = tiles.find((t) => t.key === m.key && t.kind === 'camera')
    const id = 'member:' + m.key
    const tile = h('div', {
      class: classes('tile', { speaking: voice.speaking.has(m.key), focused: state.focusedTile === id, 'has-video': !!cam }),
      dataset: { key: m.key },
      onclick: () => toggleFocus(id)
    },
    cam ? videoFor(cam.stream, { mirror: cam.local }) : avatar(m.key, m.name, 80),
    h('div', { class: 'tile-label' },
      m.deaf ? icon('headphones-off', 16) : m.mute ? icon('mic-off', 16) : null,
      h('span', {}, m.name + (m.me ? ' (toi)' : '')))
    )
    grid.append(tile)
  }
  for (const t of tiles.filter((x) => x.kind === 'screen')) {
    const id = 'screen:' + t.stream.id
    grid.append(h('div', { class: classes('tile', 'screen', 'has-video', { focused: state.focusedTile === id }), onclick: () => toggleFocus(id) },
      videoFor(t.stream),
      h('div', { class: 'tile-label' }, icon('monitor', 16), h('span', {}, `Écran de ${t.local ? 'toi' : memberName(t.key)}`)),
      h('span', { class: 'live-badge corner' }, 'EN DIRECT')))
  }

  const micOff = voice.muted || voice.deafened
  const controls = here
    ? h('div', { class: 'voice-controls' },
      ctrl(micOff ? 'mic-off' : 'mic', micOff ? 'Réactiver le micro' : 'Couper le micro', () => voice.setMuted(!micOff), micOff),
      ctrl(voice.cameraStream ? 'video' : 'video-off', voice.cameraStream ? 'Couper la caméra' : 'Activer la caméra', toggleCamera, false, !!voice.cameraStream),
      ctrl('monitor', voice.screenStream ? 'Arrêter le partage' : 'Partager l’écran', toggleScreen, false, !!voice.screenStream),
      ctrl(voice.deafened ? 'headphones-off' : 'headphones', voice.deafened ? 'Réactiver le son' : 'Couper le son', () => voice.setDeafened(!voice.deafened), voice.deafened),
      ctrl('phone-off', 'Quitter le vocal', () => voice.leave(), true, false, 'hangup'))
    : h('div', { class: 'voice-controls' }, h('button', { class: 'btn primary', type: 'button', onclick: () => openVoiceChannel(channel.id) }, 'Rejoindre le vocal'))

  view.append(grid, controls)
}

function ctrl (iconName, title, onClick, danger = false, on = false, extra = '') {
  return h('button', { class: classes('ctrl-btn', extra, { danger, on }), type: 'button', title, 'aria-label': title, onclick: onClick }, icon(iconName, 22))
}

function toggleFocus (id) {
  state.focusedTile = state.focusedTile === id ? null : id
  renderVoiceView()
}

async function toggleCamera () {
  try {
    await voice.toggleCamera()
  } catch (err) {
    toast('Caméra inaccessible : ' + err.message, 'error')
  }
}

async function toggleScreen () {
  if (voice.screenStream) return voice.stopScreen()
  let sources
  try {
    sources = await api.getScreenSources()
  } catch (err) {
    return toast('Partage d’écran impossible : ' + err.message, 'error')
  }
  if (!sources.length) return toast('Aucun écran ni fenêtre à partager.', 'error')
  const close = openModal({
    title: 'Que veux-tu partager ?',
    className: 'wide',
    body: h('div', { class: 'source-grid' }, sources.map((s) =>
      h('button', {
        class: 'source',
        type: 'button',
        onclick: async () => {
          close()
          try {
            await voice.startScreen(s.id)
          } catch (err) {
            toast('Partage d’écran impossible : ' + err.message, 'error')
          }
        }
      },
      s.thumbnail ? h('img', { src: s.thumbnail, alt: '' }) : h('div', { class: 'source-placeholder' }, icon('monitor', 40)),
      h('span', {}, s.name))
    ))
  })
}

// -----------------------------------------------------------------------------
// Fenêtres de dialogue

function field (label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null)
}

function showWelcome () {
  const input = h('input', { type: 'text', maxlength: '32', placeholder: 'Ton pseudo', autofocus: true })
  openModal({
    title: 'Bienvenue sur Dixcord !',
    dismissible: false,
    body: [
      h('p', {}, 'Ici, pas de serveur central : ton application se connecte directement à celles de tes amis. Commence par choisir un pseudo.'),
      field('Pseudo', input, 'Tu pourras le changer plus tard dans les paramètres.')
    ],
    actions: [{
      label: 'C’est parti',
      kind: 'primary',
      submit: true,
      onClick: async (close) => {
        try {
          state.me = await api.setName(input.value)
          renderUserPanel()
          close()
        } catch (err) {
          toast(err.message, 'error')
        }
      }
    }]
  })
}

function showAddServer (mode) {
  const nameInput = h('input', { type: 'text', maxlength: '48', placeholder: 'Le serveur de ' + (state.me ? state.me.name : 'moi'), autofocus: mode !== 'join' })
  const inviteInput = h('input', { type: 'text', placeholder: 'dixcord:…', autofocus: mode === 'join' })
  const close = openModal({
    title: 'Ajouter un serveur',
    body: [
      h('section', { class: 'add-section' },
        h('h3', {}, 'Créer un serveur'),
        field('Nom du serveur', nameInput),
        h('button', {
          class: 'btn primary',
          type: 'button',
          onclick: async () => {
            try {
              const { id } = await api.createServer(nameInput.value || nameInput.placeholder)
              close()
              state.servers = await api.init().then((r) => r.servers)
              await selectServer(id)
              showInvite()
            } catch (err) {
              toast(err.message, 'error')
            }
          }
        }, 'Créer')),
      h('div', { class: 'or' }, h('span', {}, 'ou')),
      h('section', { class: 'add-section' },
        h('h3', {}, 'Rejoindre un serveur'),
        field('Code d’invitation', inviteInput, 'Demande-le à un membre du serveur.'),
        h('button', {
          class: 'btn primary',
          type: 'button',
          onclick: async () => {
            try {
              const { id, already } = await api.joinServer(inviteInput.value)
              close()
              state.servers = await api.init().then((r) => r.servers)
              await selectServer(id)
              toast(already ? 'Tu fais déjà partie de ce serveur.' : 'Serveur rejoint ! Recherche des autres membres…')
            } catch (err) {
              toast(err.message, 'error')
            }
          }
        }, 'Rejoindre'))
    ]
  })
}

async function showInvite () {
  if (!state.serverId) return
  let code
  try {
    code = await api.getInvite(state.serverId)
  } catch (err) {
    return toast(err.message, 'error')
  }
  const area = h('textarea', { class: 'invite-code', readonly: true, rows: '3', spellcheck: 'false' }, code)
  area.addEventListener('focus', () => area.select())
  openModal({
    title: `Inviter des amis sur ${state.server.name}`,
    body: [
      h('p', {}, 'Envoie ce code à tes amis (par SMS, mail…). Ils le colleront dans « Rejoindre un serveur ».'),
      area,
      h('p', { class: 'warning' }, 'Ce code est la clé du serveur : toute personne qui l’a peut le rejoindre et lire tout l’historique. Ne le partage qu’avec des personnes de confiance.')
    ],
    actions: [
      { label: 'Fermer', kind: 'secondary' },
      {
        label: 'Copier',
        kind: 'primary',
        onClick: async () => {
          await api.copyText(code)
          toast('Code d’invitation copié !')
        }
      }
    ]
  })
}

function showServerMenu (anchor) {
  popupMenu(anchor, [
    { label: 'Inviter des amis', icon: 'user-plus', onClick: showInvite },
    { label: 'Renommer le serveur', icon: 'edit', onClick: showRenameServer },
    { label: 'Créer un salon', icon: 'plus-circle', onClick: () => showCreateChannel('text') },
    { label: 'Quitter le serveur', icon: 'log-out', danger: true, onClick: confirmLeaveServer }
  ])
}

function promptName ({ title, label, value, max, confirm, onSubmit }) {
  const input = h('input', { type: 'text', maxlength: String(max), value, autofocus: true })
  openModal({
    title,
    body: field(label, input),
    actions: [
      { label: 'Annuler', kind: 'secondary' },
      {
        label: confirm,
        kind: 'primary',
        submit: true,
        onClick: async (close) => {
          try {
            await onSubmit(input.value)
            close()
          } catch (err) {
            toast(err.message, 'error')
          }
        }
      }
    ]
  })
}

function showRenameServer () {
  promptName({
    title: 'Renommer le serveur',
    label: 'Nom du serveur',
    value: state.server.name,
    max: 48,
    confirm: 'Renommer',
    onSubmit: (name) => api.renameServer(state.serverId, name)
  })
}

function showCreateChannel (kind) {
  if (!state.serverId) return
  const input = h('input', { type: 'text', maxlength: '32', placeholder: kind === 'text' ? 'nouveau-salon' : 'Nouveau salon', autofocus: true })
  const radio = (value, label, desc, iconName) => h('label', { class: 'kind-option' },
    h('input', { type: 'radio', name: 'kind', value, checked: kind === value }),
    icon(iconName, 22),
    h('span', { class: 'kind-text' }, h('strong', {}, label), h('small', {}, desc)))
  const kinds = h('div', { class: 'kind-options' },
    radio('text', 'Textuel', 'Messages, images, fichiers', 'hash'),
    radio('voice', 'Vocal', 'Voix, vidéo et partage d’écran', 'volume'))
  openModal({
    title: 'Créer un salon',
    body: [kinds, field('Nom du salon', input)],
    actions: [
      { label: 'Annuler', kind: 'secondary' },
      {
        label: 'Créer',
        kind: 'primary',
        submit: true,
        onClick: async (close) => {
          const chosen = kinds.querySelector('input:checked').value
          try {
            const channel = await api.createChannel(state.serverId, input.value || input.placeholder, chosen)
            close()
            await refreshServer()
            if (channel.kind === 'text') selectTextChannel(channel.id)
          } catch (err) {
            toast(err.message, 'error')
          }
        }
      }
    ]
  })
}

function showRenameChannel (c) {
  promptName({
    title: 'Renommer le salon',
    label: 'Nom du salon',
    value: c.name,
    max: 32,
    confirm: 'Renommer',
    onSubmit: (name) => api.renameChannel(state.serverId, c.id, name)
  })
}

function confirmDeleteChannel (c) {
  openModal({
    title: 'Supprimer le salon',
    body: h('p', {}, `Supprimer ${c.kind === 'text' ? '#' : ''}${c.name} pour tous les membres ?`),
    actions: [
      { label: 'Annuler', kind: 'secondary' },
      {
        label: 'Supprimer',
        kind: 'danger',
        onClick: async (close) => {
          try {
            await api.deleteChannel(state.serverId, c.id)
            close()
          } catch (err) {
            toast(err.message, 'error')
          }
        }
      }
    ]
  })
}

function confirmLeaveServer () {
  const server = state.server
  openModal({
    title: `Quitter ${server.name}`,
    body: h('p', {}, 'Ton historique local de ce serveur sera effacé. Tu pourras revenir avec un code d’invitation, et récupérer l’historique auprès des autres membres.'),
    actions: [
      { label: 'Annuler', kind: 'secondary' },
      {
        label: 'Quitter le serveur',
        kind: 'danger',
        onClick: async (close) => {
          try {
            if (voice.serverId === server.id) await voice.leave()
            await api.leaveServer(server.id)
            close()
          } catch (err) {
            toast(err.message, 'error')
          }
        }
      }
    ]
  })
}

async function showSettings () {
  const nameInput = h('input', { type: 'text', maxlength: '32', value: state.me.name })
  let devices = []
  try {
    devices = await navigator.mediaDevices.enumerateDevices()
  } catch {}
  const select = (kind, storageKey, emptyLabel) => {
    const current = storageGet(storageKey) || ''
    const list = devices.filter((d) => d.kind === kind)
    return h('select', { dataset: { key: storageKey } },
      h('option', { value: '' }, emptyLabel),
      list.map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === current }, d.label || `Périphérique ${i + 1}`)))
  }
  const mic = select('audioinput', 'dixcord.mic', 'Micro par défaut')
  const cam = select('videoinput', 'dixcord.camera', 'Caméra par défaut')
  const out = select('audiooutput', 'dixcord.speaker', 'Sortie par défaut')
  openModal({
    title: 'Paramètres',
    body: [
      field('Pseudo', nameInput),
      field('Micro', mic, 'Pris en compte à la prochaine connexion au vocal.'),
      field('Caméra', cam),
      field('Sortie audio', out),
      h('div', { class: 'field' },
        h('span', { class: 'field-label' }, 'Ton identité'),
        h('code', { class: 'identity' }, state.me.key),
        h('span', { class: 'field-hint' }, 'Ta clé publique : elle t’identifie auprès des autres membres. La clé secrète reste sur ton ordinateur.'))
    ],
    actions: [
      { label: 'Annuler', kind: 'secondary' },
      {
        label: 'Enregistrer',
        kind: 'primary',
        submit: true,
        onClick: async (close) => {
          try {
            if (nameInput.value.trim() !== state.me.name) state.me = await api.setName(nameInput.value)
            storageSet('dixcord.mic', mic.value)
            storageSet('dixcord.camera', cam.value)
            voice.setOutputDevice(out.value)
            renderUserPanel()
            close()
          } catch (err) {
            toast(err.message, 'error')
          }
        }
      }
    ]
  })
}

boot().catch((err) => {
  console.error(err)
  toast('Erreur au démarrage : ' + err.message, 'error')
})

'use strict'

const {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  session,
  dialog,
  shell,
  clipboard,
  desktopCapturer,
  systemPreferences
} = require('electron')
const path = require('path')
const fs = require('fs')
const { Readable } = require('stream')
const { DixcordNode } = require('../core/node')
const { HEX64 } = require('../core/events')
const { sanitizeFileName } = require('../core/files')

// --profile=nom : dossier de données séparé, pour lancer plusieurs clients
// sur la même machine (pratique pour tester).
const profileArg = process.argv.find((a) => a.startsWith('--profile='))
if (process.env.DIXCORD_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.DIXCORD_DATA_DIR))
} else if (profileArg) {
  const profile = profileArg.slice('--profile='.length).replace(/[^\w-]/g, '')
  if (profile) app.setPath('userData', path.join(app.getPath('appData'), 'dixcord-' + profile))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'dxc', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

const RENDERER_DIR = path.join(__dirname, '..', 'renderer')
const APP_ORIGIN = 'dxc://app'
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
}
// Types de pièces jointes affichables directement dans l'application.
const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp',
  'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/flac'
])
const DEFAULT_SETTINGS = {
  // Serveurs STUN publics : aident WebRTC à traverser les box/NAT pour le vocal.
  // Ajoute un serveur TURN ici si le vocal ne passe pas chez certains amis.
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ]
}

let node = null
let mainWindow = null
let settings = DEFAULT_SETTINGS
let pendingScreenSource = null
let lastScreenSources = [] // sources proposées dans le sélecteur de partage d'écran

function loadSettings () {
  const file = path.join(app.getPath('userData'), 'settings.json')
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (Array.isArray(data.iceServers)) return { ...DEFAULT_SETTINGS, ...data }
  } catch {}
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(DEFAULT_SETTINGS, null, 2))
  } catch {}
  return DEFAULT_SETTINGS
}

// Variables d'environnement utilisées par les tests : DHT locale au lieu
// des nœuds publics.
function swarmOptions () {
  if (!process.env.DIXCORD_BOOTSTRAP) return {}
  const DHT = require('hyperdht')
  const bootstrap = process.env.DIXCORD_BOOTSTRAP.split(',').map((entry) => {
    const [host, port] = entry.trim().split(':')
    return { host, port: Number(port) }
  })
  const opts = { dht: new DHT({ bootstrap, host: process.env.DIXCORD_DHT_HOST || undefined, ephemeral: true }) }
  // Tests : refuse les connexions directes avec ces membres (comme en 4G).
  const blocked = new Set((process.env.DIXCORD_NO_DIRECT || '').split(',').filter(Boolean))
  if (blocked.size) opts.firewall = (remotePublicKey) => blocked.has(remotePublicKey.toString('hex'))
  return opts
}

function send (type, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dx:event', { type, ...payload })
}

function wireNodeEvents () {
  node.on('events', (serverId, evs) => {
    const messages = evs.filter((ev) => ev.type === 'msg').map((ev) => node.messageView(serverId, ev))
    if (messages.length) send('messages', { serverId, messages })
    if (evs.some((ev) => ev.type !== 'msg')) send('server-changed', { serverId })
  })
  node.on('server-changed', (serverId) => send('server-changed', { serverId }))
  node.on('servers', () => send('servers', { servers: node.listServers() }))
  node.on('voice', (serverId) => {
    if (node.servers.has(serverId)) send('voice', { serverId, voice: node.voiceMembers(serverId) })
  })
  node.on('rtc', (serverId, from, data) => send('rtc', { serverId, from, data }))
  node.on('download', (info) => send('download', info))
  node.on('me', () => send('me', { me: node.me() }))
  node.on('warning', (err) => console.warn('[dixcord]', err && err.message))
}

const handlers = {
  init: () => ({
    me: node.me(),
    servers: node.listServers(),
    iceServers: settings.iceServers,
    platform: process.platform,
    // Tests : simule l'échec de la liaison WebRTC directe avec ces membres.
    noDirect: process.env.DIXCORD_DEBUG && process.env.DIXCORD_NO_DIRECT ? process.env.DIXCORD_NO_DIRECT.split(',') : []
  }),
  setName: (name) => node.setName(name),
  createServer: (name) => node.createServer(name),
  joinServer: (invite) => node.joinServer(invite),
  leaveServer: (serverId) => node.leaveServer(serverId),
  getInvite: (serverId) => node.getInvite(serverId),
  renameServer: (serverId, name) => node.renameServer(serverId, name),
  getServer: (serverId) => node.serverView(serverId),
  getMessages: (serverId, channelId, opts) => node.getMessages(serverId, channelId, opts || {}),
  sendMessage: (serverId, channelId, text, attachments) => node.sendMessage(serverId, channelId, text, attachments),
  createChannel: (serverId, name, kind) => node.createChannel(serverId, name, kind),
  renameChannel: (serverId, channelId, name) => node.renameChannel(serverId, channelId, name),
  deleteChannel: (serverId, channelId) => node.deleteChannel(serverId, channelId),
  downloadFile: async (serverId, hash) => {
    await node.downloadFile(serverId, hash)
    return true
  },
  pickFiles: async () => {
    const res = await dialog.showOpenDialog(mainWindow, { title: 'Joindre des fichiers', properties: ['openFile', 'multiSelections'] })
    return res.canceled ? [] : res.filePaths
  },
  saveFile: async (hash) => {
    if (!HEX64.test(hash) || !node.files.has(hash)) throw new Error('Fichier pas encore téléchargé')
    const info = node.fileInfo(hash)
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Enregistrer le fichier',
      defaultPath: path.join(app.getPath('downloads'), sanitizeFileName(info ? info.name : hash))
    })
    if (res.canceled || !res.filePath) return false
    await node.files.copyTo(hash, res.filePath)
    return true
  },
  openExternal: (url) => {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Lien non autorisé')
    return shell.openExternal(u.toString())
  },
  copyText: (text) => clipboard.writeText(String(text)),
  setVoice: (state) => node.setVoice(state),
  sendRtc: (serverId, to, data) => node.sendRtc(serverId, to, data),
  askMediaAccess: async (kind) => {
    if (process.platform !== 'darwin' || (kind !== 'microphone' && kind !== 'camera')) return true
    return systemPreferences.askForMediaAccess(kind)
  },
  getScreenSources: async () => {
    const opts = { types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } }
    lastScreenSources = await desktopCapturer.getSources(opts)
    // Sur certains bureaux Linux, la première énumération revient vide.
    if (!lastScreenSources.length) lastScreenSources = await desktopCapturer.getSources(opts)
    return lastScreenSources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL() }))
  },
  selectScreenSource: (id) => {
    pendingScreenSource = typeof id === 'string' ? id : null
  }
}

function registerIpc () {
  for (const [name, fn] of Object.entries(handlers)) {
    ipcMain.handle('dx:' + name, async (event, ...args) => {
      if (!event.senderFrame || !event.senderFrame.url.startsWith(APP_ORIGIN + '/')) {
        return { ok: false, error: 'Origine non autorisée' }
      }
      try {
        return { ok: true, value: await fn(...args) }
      } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) }
      }
    })
  }
}

async function handleProtocol (request) {
  const url = new URL(request.url)
  if (url.host === 'app') {
    const file = path.normalize(path.join(RENDERER_DIR, decodeURIComponent(url.pathname)))
    const type = STATIC_TYPES[path.extname(file)]
    if (!file.startsWith(RENDERER_DIR + path.sep) || !type) return new Response('Introuvable', { status: 404 })
    try {
      return new Response(await fs.promises.readFile(file), { headers: { 'content-type': type } })
    } catch {
      return new Response('Introuvable', { status: 404 })
    }
  }
  if (url.host === 'file') {
    const hash = url.pathname.slice(1)
    if (!HEX64.test(hash) || !node.files.has(hash)) return new Response('Introuvable', { status: 404 })
    const info = node.fileInfo(hash)
    const type = info && INLINE_TYPES.has(info.mime) ? info.mime : 'application/octet-stream'
    const file = node.files.path(hash)
    const size = (await fs.promises.stat(file)).size
    const headers = {
      'content-type': type,
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'"
    }
    // Requêtes partielles : nécessaires pour se déplacer dans une vidéo.
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '')
    if (range && size > 0) {
      let start = range[1] === '' ? size - Number(range[2]) : Number(range[1])
      let end = range[1] === '' || range[2] === '' ? size - 1 : Number(range[2])
      start = Math.max(0, start)
      end = Math.min(size - 1, end)
      if (start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
      return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
        status: 206,
        headers: { ...headers, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}` }
      })
    }
    return new Response(Readable.toWeb(fs.createReadStream(file)), { headers: { ...headers, 'content-length': String(size) } })
  }
  return new Response('Introuvable', { status: 404 })
}

function setupSession () {
  const ses = session.defaultSession
  const allowed = new Set(['media', 'display-capture', 'notifications', 'clipboard-sanitized-write', 'fullscreen', 'speaker-selection'])
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))

  // Partage d'écran : la source a été choisie dans l'interface juste avant,
  // parmi celles qu'on vient d'énumérer (inutile de les redemander).
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    const wanted = pendingScreenSource
    pendingScreenSource = null
    try {
      let source = lastScreenSources.find((s) => s.id === wanted)
      if (!source && wanted) {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
        source = sources.find((s) => s.id === wanted)
      }
      if (!source) return callback({})
      callback(process.platform === 'win32' ? { video: source, audio: 'loopback' } : { video: source })
    } catch {
      callback({})
    }
  })
}

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    title: 'Dixcord',
    backgroundColor: '#313338',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true
    }
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.loadURL(APP_ORIGIN + '/index.html')
}

// Aucune navigation ni nouvelle fenêtre : les liens s'ouvrent dans le navigateur.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_ORIGIN + '/')) event.preventDefault()
  })
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  settings = loadSettings()
  node = new DixcordNode({ storageDir: path.join(app.getPath('userData'), 'data'), swarmOptions })
  wireNodeEvents()
  await node.start()
  if (process.env.DIXCORD_DEBUG) {
    global.__dixcordNode = node // accessible aux tests de bout en bout
    const short = (k) => k.toString('hex').slice(0, 8)
    console.log('[dixcord] identité', node.key.slice(0, 8), 'serveurs', node.servers.size)
    node.swarm.on('connection', (conn) => console.log('[dixcord] connexion avec', short(conn.remotePublicKey)))
    node.on('debug', (message) => console.log('[dixcord]', message))
    node.on('server-changed', (id) => console.log('[dixcord] pairs du serveur', id.slice(0, 8), [...node.peers.values()].filter((p) => p.servers.has(id)).map((p) => p.key.slice(0, 8))))
  }
  protocol.handle('dxc', handleProtocol)
  setupSession()
  registerIpc()
  createWindow()
}).catch((err) => {
  dialog.showErrorBox('Dixcord', 'Impossible de démarrer : ' + (err && err.message))
  app.exit(1)
})

app.on('window-all-closed', () => app.quit())

let quitting = false
app.on('before-quit', (event) => {
  if (quitting || !node) return
  event.preventDefault()
  quitting = true
  const force = setTimeout(() => app.exit(0), 3000)
  node.stop().catch(() => {}).finally(() => {
    clearTimeout(force)
    app.quit()
  })
})

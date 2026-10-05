'use strict'

// Pont minimal et explicite entre l'interface (sans accès à Node) et le
// processus principal.

const { contextBridge, ipcRenderer, webUtils } = require('electron')

async function call (name, ...args) {
  const res = await ipcRenderer.invoke('dx:' + name, ...args)
  if (!res || !res.ok) throw new Error(res ? res.error : 'Erreur inconnue')
  return res.value
}

const methods = [
  'init', 'setName', 'createServer', 'joinServer', 'leaveServer', 'getInvite', 'renameServer',
  'getServer', 'getMessages', 'sendMessage', 'createChannel', 'renameChannel', 'deleteChannel',
  'downloadFile', 'pickFiles', 'saveFile', 'openExternal', 'copyText', 'setVoice', 'sendRtc',
  'askMediaAccess', 'getScreenSources', 'selectScreenSource'
]

const api = {}
for (const name of methods) api[name] = (...args) => call(name, ...args)

api.pathForFile = (file) => webUtils.getPathForFile(file)
api.onEvent = (callback) => {
  const listener = (_event, message) => callback(message)
  ipcRenderer.on('dx:event', listener)
  return () => ipcRenderer.removeListener('dx:event', listener)
}

contextBridge.exposeInMainWorld('dixcord', api)

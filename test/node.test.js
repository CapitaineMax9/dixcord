'use strict'

// Tests d'intégration : de vrais nœuds Dixcord qui se trouvent via une DHT
// locale (testnet) et communiquent par Hyperswarm, comme en conditions réelles.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { once } = require('events')
const createTestnet = require('hyperdht/testnet')
const { DixcordNode } = require('../src/core/node')
const cr = require('../src/core/crypto')
const { createEvent } = require('../src/core/events')

async function setup (t) {
  const testnet = await createTestnet(3)
  const nodes = []
  const dirs = []
  t.after(async () => {
    for (const node of nodes) await node.stop().catch(() => {})
    await testnet.destroy()
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
  })
  const tmpDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dixcord-node-'))
    dirs.push(dir)
    return dir
  }
  const make = async (name, dir = tmpDir(), opts = {}) => {
    const { swarm = {}, ...rest } = opts
    const node = new DixcordNode({ storageDir: dir, swarmOptions: () => ({ dht: testnet.createNode(), ...swarm }), ...rest })
    await node.start()
    if (name) node.setName(name)
    nodes.push(node)
    return node
  }
  return { make, tmpDir }
}

async function waitFor (fn, what = 'condition', timeout = 20000) {
  const start = Date.now()
  while (true) {
    try {
      if (fn()) return
    } catch {}
    if (Date.now() - start > timeout) throw new Error('Délai dépassé : ' + what)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function channelsOf (node, serverId) {
  const channels = node.serverView(serverId).channels
  return { text: channels.find((c) => c.kind === 'text'), voice: channels.find((c) => c.kind === 'voice') }
}

const isOnline = (node, serverId, key) => node.serverView(serverId).members.some((m) => m.key === key && m.online)

test('deux pairs rejoignent un serveur et discutent', async (t) => {
  const { make } = await setup(t)
  const alice = await make('Alice')
  const bob = await make('Bob')

  const { id } = alice.createServer('Les potes')
  await alice.flushed(id)
  const joined = bob.joinServer(alice.getInvite(id))
  assert.equal(joined.id, id)
  assert.equal(bob.serverView(id).name, 'Les potes') // nom lu dans l'invitation

  await waitFor(() => bob.serverView(id).channels.length === 2, 'synchronisation des salons')
  const { text } = channelsOf(bob, id)
  assert.equal(text.name, 'général')

  await alice.sendMessage(id, text.id, 'Salut Bob !')
  await waitFor(() => bob.getMessages(id, text.id).messages.length === 1, 'réception du message')
  const received = bob.getMessages(id, text.id).messages[0]
  assert.equal(received.text, 'Salut Bob !')
  assert.equal(received.authorName, 'Alice')

  await bob.sendMessage(id, text.id, 'Salut Alice !')
  await waitFor(() => alice.getMessages(id, text.id).messages.length === 2, 'réponse')

  assert.ok(isOnline(alice, id, bob.key))
  assert.ok(isOnline(bob, id, alice.key))
  assert.deepEqual(bob.joinServer(alice.getInvite(id)), { id, already: true })
})

test('l’historique manqué est rattrapé, même relayé par un tiers', async (t) => {
  const { make, tmpDir } = await setup(t)
  const alice = await make('Alice')
  const bobDir = tmpDir()
  let bob = await make('Bob', bobDir)

  const { id } = alice.createServer('Archives')
  await alice.flushed(id)
  const invite = alice.getInvite(id)
  bob.joinServer(invite)
  await waitFor(() => isOnline(alice, id, bob.key) && bob.serverView(id).channels.length === 2, 'connexion de Bob')
  const { text } = channelsOf(alice, id)

  await bob.stop() // Bob se déconnecte
  for (const word of ['un', 'deux', 'trois']) await alice.sendMessage(id, text.id, word)

  const carol = await make('Carol')
  carol.joinServer(invite)
  await waitFor(() => carol.getMessages(id, text.id).messages.length === 3, 'Carol récupère l’historique')
  await carol.flushed(id)

  await alice.stop() // Alice part : seule Carol détient ses messages
  bob = await make(null, bobDir) // Bob revient avec son historique local
  assert.equal(bob.me().name, 'Bob')
  await waitFor(() => bob.getMessages(id, text.id).messages.length === 3, 'Bob rattrape via Carol')
  const msgs = bob.getMessages(id, text.id).messages
  assert.deepEqual(msgs.map((m) => m.text), ['un', 'deux', 'trois'])
  assert.equal(msgs[0].authorName, 'Alice')
})

test('un pair qui redémarre se reconnecte aussitôt au même pair', async (t) => {
  const { make, tmpDir } = await setup(t)
  const alice = await make('Alice')
  const bobDir = tmpDir()
  let bob = await make('Bob', bobDir)
  const { id } = alice.createServer('Fidèles')
  await alice.flushed(id)
  bob.joinServer(alice.getInvite(id))
  await waitFor(() => isOnline(alice, id, bob.key), 'connexion initiale')
  const { text } = channelsOf(alice, id)
  for (let i = 0; i < 3; i++) {
    await bob.stop()
    await waitFor(() => !isOnline(alice, id, bob.key), 'déconnexion de Bob')
    await alice.sendMessage(id, text.id, 'pendant l’absence ' + i)
    bob = await make(null, bobDir)
    await waitFor(() => bob.getMessages(id, text.id).messages.length === i + 1, 'reconnexion et rattrapage', 10000)
  }
})

test('deux membres qui ne peuvent pas se connecter se voient via un troisième', async (t) => {
  const { make, tmpDir } = await setup(t)
  // Bob et Carol refusent de se connecter directement (comme deux appareils en 4G).
  const blocked = new Set()
  const firewall = { swarm: { firewall: (remotePublicKey) => blocked.has(remotePublicKey.toString('hex')) } }
  const alice = await make('Alice')
  const bob = await make('Bob', tmpDir(), firewall)
  const carol = await make('Carol', tmpDir(), firewall)
  blocked.add(bob.key)
  blocked.add(carol.key)

  const { id } = alice.createServer('Relais')
  await alice.flushed(id)
  bob.joinServer(alice.getInvite(id))
  carol.joinServer(alice.getInvite(id))
  await waitFor(() => isOnline(alice, id, bob.key) && isOnline(alice, id, carol.key), 'Alice voit Bob et Carol')
  assert.ok(!bob.peers.has(carol.key), 'pas de connexion directe Bob-Carol')

  // Présence relayée par Alice.
  await waitFor(() => isOnline(bob, id, carol.key) && isOnline(carol, id, bob.key), 'Bob et Carol se voient en ligne')
  const seen = bob.serverView(id).members.find((m) => m.key === carol.key)
  assert.equal(seen.name, 'Carol')
  assert.equal(seen.relayed, true)

  // État vocal relayé.
  const { voice } = channelsOf(alice, id)
  carol.setVoice({ server: id, channel: voice.id, mute: true })
  await waitFor(() => (bob.voiceMembers(id)[voice.id] || []).some((m) => m.key === carol.key && m.mute), 'Bob voit Carol dans le vocal')

  // Signalisation WebRTC relayée et authentifiée.
  const signal = once(carol, 'rtc')
  assert.equal(bob.sendRtc(id, carol.key, { description: { type: 'offer', sdp: 'v=0' } }), true)
  const [, from, data] = await signal
  assert.equal(from, bob.key)
  assert.equal(data.description.type, 'offer')

  // Alice ne peut pas se faire passer pour Bob auprès de Carol.
  let forged = false
  carol.on('rtc', (_s, f, d) => { if (d.forged) forged = true })
  const r = { s: id, from: bob.key, to: carol.key, ts: Date.now(), d: { forged: true } }
  alice._send(alice.peers.get(carol.key), { t: 'rtc', ...r, sig: 'ab'.repeat(64), hops: 0 })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(forged, false)

  // Carol quitte l'application : Bob la voit hors ligne aussitôt.
  await carol.stop()
  await waitFor(() => !isOnline(bob, id, carol.key) && !bob.voiceMembers(id)[voice.id], 'Carol hors ligne pour Bob', 3000)
})

test('les serveurs sont cloisonnés, y compris sur une connexion partagée', async (t) => {
  const { make } = await setup(t)
  const alice = await make('Alice')
  const bob = await make('Bob')
  const carol = await make('Carol')

  const s1 = alice.createServer('Serveur 1').id
  const s2 = carol.createServer('Serveur 2').id
  await Promise.all([alice.flushed(s1), carol.flushed(s2)])
  bob.joinServer(alice.getInvite(s1))
  bob.joinServer(carol.getInvite(s2))

  await waitFor(() => bob.peers.get(alice.key)?.servers.has(s1) && bob.peers.get(carol.key)?.servers.has(s2), 'connexions de Bob')
  assert.deepEqual([...bob.peers.get(carol.key).servers], [s2])
  assert.deepEqual([...alice.peers.get(bob.key).servers], [s1])

  // Carol rejoint Serveur 1 alors qu'elle est déjà connectée à Bob : ils
  // doivent s'authentifier mutuellement sur la connexion existante.
  carol.joinServer(alice.getInvite(s1))
  await waitFor(
    () => bob.peers.get(carol.key).servers.has(s1) && carol.peers.get(bob.key).servers.has(s1),
    'authentification mutuelle sur Serveur 1'
  )
  await waitFor(() => carol.serverView(s1).channels.length === 2, 'synchronisation de Carol')
})

test('un intrus qui connaît le sujet DHT mais pas le secret ne reçoit rien', async (t) => {
  const { make, tmpDir } = await setup(t)
  const alice = await make('Alice', tmpDir(), { uselessPeerGrace: 1500 })
  const mallory = await make('Mallory')
  const { id } = alice.createServer('Privé')
  const server = alice.servers.get(id)
  await alice.flushed(id)

  const frames = []
  const original = mallory._onFrame.bind(mallory)
  mallory._onFrame = (peer, h, body) => {
    frames.push(h.t)
    return original(peer, h, body)
  }
  mallory.swarm.join(server.topic, { server: true, client: true })
  await waitFor(() => alice.peers.get(mallory.key)?.hello, 'connexion de Mallory')

  const peer = mallory.peers.get(alice.key)
  mallory._send(peer, { t: 'join', proof: 'f'.repeat(64) })
  mallory._send(peer, { t: 'sync', s: id, have: {} })
  mallory._send(peer, { t: 'fget', s: id, h: 'a'.repeat(64) })
  await alice.sendMessage(id, channelsOf(alice, id).text.id, 'secret')
  await new Promise((resolve) => setTimeout(resolve, 500))

  assert.equal(alice.peers.get(mallory.key).servers.size, 0)
  assert.deepEqual(frames, ['hello'])
  assert.ok(!alice.serverView(id).members.some((m) => m.key === mallory.key))

  // Sans serveur commun, Alice finit par fermer la connexion.
  await new Promise((resolve) => peer.conn.on('close', resolve))
  assert.ok(frames.every((f) => f === 'hello'))
})

test('un message falsifié au nom d’un autre est rejeté', async (t) => {
  const { make } = await setup(t)
  const alice = await make('Alice')
  const bob = await make('Bob')
  const { id } = alice.createServer('Confiance')
  await alice.flushed(id)
  bob.joinServer(alice.getInvite(id))
  await waitFor(() => bob.peers.get(alice.key)?.servers.has(id) && bob.serverView(id).channels.length === 2, 'connexion')
  const { text } = channelsOf(bob, id)

  // Bob signe avec sa clé un message qui prétend venir d'Alice.
  const forged = createEvent({ keyPair: bob.keyPair, serverId: id, seq: 99, type: 'msg', body: { channel: text.id, text: 'faux' } })
  forged.author = alice.key
  bob._send(bob.peers.get(alice.key), { t: 'ev', s: id, ev: forged })
  await bob.sendMessage(id, text.id, 'vrai')
  await waitFor(() => alice.getMessages(id, text.id).messages.length === 1, 'message légitime')
  assert.deepEqual(alice.getMessages(id, text.id).messages.map((m) => m.text), ['vrai'])
})

test('transfert de fichiers vérifié par empreinte', async (t) => {
  const { make, tmpDir } = await setup(t)
  const alice = await make('Alice')
  const bob = await make('Bob')
  const { id } = alice.createServer('Partage')
  await alice.flushed(id)
  bob.joinServer(alice.getInvite(id))
  await waitFor(() => bob.peers.get(alice.key)?.servers.has(id) && bob.serverView(id).channels.length === 2, 'connexion')
  const { text } = channelsOf(alice, id)

  const content = cr.randomBytes(300 * 1024 + 123)
  const file = path.join(tmpDir(), 'photo vacances.png')
  fs.writeFileSync(file, content)
  await alice.sendMessage(id, text.id, 'Regarde !', [{ path: file }])

  await waitFor(() => bob.getMessages(id, text.id).messages.length === 1, 'message avec pièce jointe')
  const [att] = bob.getMessages(id, text.id).messages[0].files
  assert.equal(att.name, 'photo vacances.png')
  assert.equal(att.mime, 'image/png')
  assert.equal(att.size, content.length)
  assert.equal(att.local, false)

  const saved = await bob.downloadFile(id, att.hash)
  assert.ok(fs.readFileSync(saved).equals(content))
  assert.equal(bob.getMessages(id, text.id).messages[0].files[0].local, true)
  assert.equal(bob.fileInfo(att.hash).name, 'photo vacances.png')

  // Envoi depuis un tampon (image collée) dans l'autre sens.
  await bob.sendMessage(id, text.id, '', [{ name: 'note.txt', data: new Uint8Array(Buffer.from('coucou')) }])
  await waitFor(() => alice.getMessages(id, text.id).messages.length === 2, 'second message')
  const note = alice.getMessages(id, text.id).messages[1].files[0]
  assert.equal(fs.readFileSync(await alice.downloadFile(id, note.hash), 'utf8'), 'coucou')

  await assert.rejects(alice.downloadFile(id, 'b'.repeat(64)))
})

test('état vocal et signalisation WebRTC relayés', async (t) => {
  const { make } = await setup(t)
  const alice = await make('Alice')
  const bob = await make('Bob')
  const { id } = alice.createServer('Vocal')
  await alice.flushed(id)
  bob.joinServer(alice.getInvite(id))
  await waitFor(() => bob.peers.get(alice.key)?.servers.has(id) && bob.serverView(id).channels.length === 2, 'connexion')
  const { voice } = channelsOf(alice, id)

  alice.setVoice({ server: id, channel: voice.id, mute: true })
  await waitFor(() => (bob.voiceMembers(id)[voice.id] || []).some((m) => m.key === alice.key && m.mute), 'état vocal')
  assert.deepEqual(alice.voiceMembers(id)[voice.id].map((m) => m.me), [true])

  const signal = once(bob, 'rtc')
  assert.equal(alice.sendRtc(id, bob.key, { description: { type: 'offer', sdp: 'v=0' } }), true)
  const [serverId, from, data] = await signal
  assert.equal(serverId, id)
  assert.equal(from, alice.key)
  assert.deepEqual(data, { description: { type: 'offer', sdp: 'v=0' } })

  alice.setVoice(null)
  await waitFor(() => !bob.voiceMembers(id)[voice.id], 'sortie du vocal')
  assert.throws(() => alice.setVoice({ server: id, channel: channelsOf(alice, id).text.id }))
})

test('salons : création, renommage, suppression ; quitter un serveur', async (t) => {
  const { make } = await setup(t)
  const alice = await make('Alice')
  const bob = await make('Bob')
  const { id } = alice.createServer('Organisation')
  await alice.flushed(id)
  bob.joinServer(alice.getInvite(id))
  await waitFor(() => bob.peers.get(alice.key)?.servers.has(id) && bob.serverView(id).channels.length === 2, 'connexion')

  const ch = bob.createChannel(id, 'Jeux Vidéo', 'text')
  assert.equal(ch.name, 'jeux-vidéo')
  await waitFor(() => alice.serverView(id).channels.some((c) => c.name === 'jeux-vidéo'), 'nouveau salon')
  alice.renameChannel(id, ch.id, 'jeux')
  alice.renameServer(id, 'Orga')
  await waitFor(() => bob.serverView(id).channels.some((c) => c.name === 'jeux') && bob.serverView(id).name === 'Orga', 'renommages')
  bob.deleteChannel(id, ch.id)
  await waitFor(() => !alice.serverView(id).channels.some((c) => c.id === ch.id), 'suppression')

  await bob.leaveServer(id)
  assert.deepEqual(bob.listServers(), [])
  await waitFor(() => !isOnline(alice, id, bob.key), 'départ de Bob')
})

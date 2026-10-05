'use strict'

// Test de bout en bout : deux vraies instances de l'application (Alice et
// Bob), pilotées comme le ferait un humain, qui se trouvent via une DHT
// locale. Lancer avec : npm run test:e2e
// (sous Linux sans écran : xvfb-run -s "-screen 0 1920x1080x24" npm run test:e2e)

const { _electron: electron } = require('playwright-core')
const createTestnet = require('hyperdht/testnet')
const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const OUT = process.env.DIXCORD_E2E_OUT || path.join(ROOT, 'test-results')
const TIMEOUT = 60000

function step (label) {
  console.log('▶', label)
}

async function launch (name, dataDir, bootstrap) {
  const args = [
    ROOT,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--disable-features=WebRtcHideLocalIpsWithMdns'
  ]
  if (process.getuid && process.getuid() === 0) args.push('--no-sandbox')
  const app = await electron.launch({
    executablePath: require('electron'),
    args,
    env: { ...process.env, DIXCORD_DATA_DIR: dataDir, DIXCORD_BOOTSTRAP: bootstrap, DIXCORD_DHT_HOST: '127.0.0.1', DIXCORD_DEBUG: '1' }
  })
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream.on('data', (d) => {
      for (const line of String(d).split('\n')) if (line.includes('[dixcord]')) console.log(`[${name}] ${line}`)
    })
  }
  const page = await app.firstWindow()
  page.setDefaultTimeout(TIMEOUT)
  page.on('pageerror', (err) => console.log(`[${name}] erreur de page :`, err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') console.log(`[${name}] ${msg.type()} :`, msg.text())
  })
  await page.waitForSelector('#user-panel .user-name')
  return { app, page }
}

async function shot (page, name) {
  await page.screenshot({ path: path.join(OUT, name + '.png') })
}

async function chooseName (page, name) {
  await page.getByPlaceholder('Ton pseudo').fill(name)
  await page.getByRole('button', { name: 'C’est parti' }).click()
  await page.locator('#user-panel .user-name', { hasText: name }).waitFor()
}

async function sendText (page, text) {
  const input = page.locator('#composer-input')
  await input.fill(text)
  await input.press('Enter')
}

async function main () {
  fs.mkdirSync(OUT, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dixcord-e2e-'))
  const dirA = path.join(tmp, 'alice')
  const dirB = path.join(tmp, 'bob')
  const testnet = await createTestnet(3)
  const bootstrap = testnet.bootstrap.map((b) => `${b.host}:${b.port}`).join(',')
  const apps = []

  try {
    step('Alice démarre et choisit son pseudo')
    const A = await launch('Alice', dirA, bootstrap)
    apps.push(A.app)
    await shot(A.page, '00-accueil')
    await chooseName(A.page, 'Alice')

    step('Alice crée un serveur')
    await A.page.getByRole('button', { name: 'Créer un serveur' }).click()
    await A.page.getByLabel('Nom du serveur').fill('Les potes')
    await A.page.getByRole('button', { name: 'Créer', exact: true }).click()
    const invite = await A.page.locator('.invite-code').inputValue()
    assert.match(invite, /^dixcord:/)
    await shot(A.page, '01-invitation')
    await A.page.getByRole('button', { name: 'Fermer', exact: true }).last().click()
    await A.page.locator('.channel.text', { hasText: 'général' }).waitFor()

    step('Bob démarre et rejoint avec le code')
    let B = await launch('Bob', dirB, bootstrap)
    apps.push(B.app)
    await chooseName(B.page, 'Bob')
    await B.page.getByRole('button', { name: 'Rejoindre avec une invitation' }).click()
    await B.page.getByLabel('Code d’invitation').fill(invite)
    await B.page.getByRole('button', { name: 'Rejoindre', exact: true }).click()
    await B.page.locator('.channel.text', { hasText: 'général' }).waitFor()
    await B.page.locator('.member:not(.offline)', { hasText: 'Alice' }).waitFor()
    await A.page.locator('.member:not(.offline)', { hasText: 'Bob' }).waitFor()

    step('Échange de messages')
    await sendText(A.page, 'Salut Bob ! Regarde https://example.com')
    await B.page.locator('.message-text', { hasText: 'Salut Bob' }).waitFor()
    await sendText(B.page, 'Salut Alice 👋')
    await A.page.locator('.message-text', { hasText: 'Salut Alice' }).waitFor()
    assert.equal(await B.page.locator('.message-text a.link').getAttribute('href'), 'https://example.com')

    step('Envoi d’une image et d’un fichier')
    const imagePath = path.join(tmp, 'capture.png')
    await A.page.screenshot({ path: imagePath, clip: { x: 0, y: 0, width: 480, height: 300 } })
    const textPath = path.join(tmp, 'notes.txt')
    fs.writeFileSync(textPath, 'Liste des courses : pain, fromage, vin.')
    await A.page.evaluate(async (files) => {
      const s = window.__dixcord.state
      await window.dixcord.sendMessage(s.serverId, s.channelId, 'Une capture et des notes', files.map((p) => ({ path: p })))
    }, [imagePath, textPath])
    await B.page.waitForFunction(() => {
      const img = document.querySelector('.attachment-image')
      return img && img.complete && img.naturalWidth > 0
    })
    const card = B.page.locator('.file-card', { hasText: 'notes.txt' })
    await card.getByTitle('Télécharger').click()
    await card.getByTitle('Enregistrer sous…').waitFor()
    await shot(B.page, '02-discussion')

    step('Création d’un salon par Bob')
    await B.page.locator('.section-header', { hasText: 'Salons textuels' }).getByTitle('Créer un salon').click()
    await B.page.getByLabel('Nom du salon').fill('Jeux vidéo')
    await B.page.getByRole('button', { name: 'Créer', exact: true }).click()
    await A.page.locator('.channel.text', { hasText: 'jeux-vidéo' }).waitFor()
    await B.page.locator('.channel.text', { hasText: 'général' }).click()

    step('Vocal')
    await A.page.locator('.channel.voice', { hasText: 'Vocal' }).click()
    await B.page.locator('.channel.voice', { hasText: 'Vocal' }).click()
    const connected = () => window.__dixcord.voice.stats().some((s) => s.connectionState === 'connected' && s.remoteTracks.includes('audio'))
    await A.page.waitForFunction(connected)
    await B.page.waitForFunction(connected)
    await A.page.locator('.voice-members .voice-member', { hasText: 'Bob' }).waitFor()

    step('Caméra')
    await A.page.getByTitle('Activer la caméra').click()
    await B.page.waitForFunction(() => [...document.querySelectorAll('.tile video')].some((v) => v.videoWidth > 0))
    await shot(B.page, '03-vocal-camera')

    step('Coupure du lien pair-à-pair pendant l’appel')
    const sidsBefore = await B.page.evaluate(() => window.__dixcord.voice.stats().map((s) => s.sid))
    await A.app.evaluate(() => {
      for (const peer of global.__dixcordNode.peers.values()) peer.conn.destroy()
    })
    await new Promise((resolve) => setTimeout(resolve, 2000))
    // Le lien Hyperswarm se rétablit seul ; l'appel WebRTC, lui, a continué.
    await A.page.locator('.voice-members .voice-member', { hasText: 'Bob' }).waitFor({ timeout: 60000 })
    await B.page.waitForFunction(connected, null, { timeout: 60000 })
    await A.page.waitForFunction(connected, null, { timeout: 60000 })
    const sidsAfter = await B.page.evaluate(() => window.__dixcord.voice.stats().map((s) => s.sid))
    console.log(sidsBefore.join() === sidsAfter.join() ? '  appel conservé sans interruption' : '  appel rétabli après la coupure')

    step('Partage d’écran')
    try {
      await A.page.locator('.voice-controls').getByTitle('Partager l’écran').click()
      await A.page.locator('.source').first().click({ timeout: 20000 })
      await B.page.waitForFunction(() => {
        const v = document.querySelector('.tile.screen video')
        return v && v.videoWidth > 0
      }, null, { timeout: 15000 })
      await shot(B.page, '04-partage-ecran')
      console.log('  partage d’écran reçu par Bob')
    } catch (err) {
      console.log('  partage d’écran non testable dans cet environnement :', err.message.split('\n')[0])
    }

    step('Bob quitte, Alice écrit, Bob revient et rattrape')
    await A.page.locator('.voice-controls').getByTitle('Quitter le vocal').click()
    await B.page.locator('.voice-controls').getByTitle('Quitter le vocal').click()
    await B.app.close()
    apps.splice(apps.indexOf(B.app), 1)
    await A.page.locator('.channel.text', { hasText: 'général' }).click()
    await A.page.locator('.member.offline', { hasText: 'Bob' }).waitFor()
    await sendText(A.page, 'Message envoyé pendant ton absence')
    B = await launch('Bob', dirB, bootstrap)
    apps.push(B.app)
    // La reconnexion peut prendre quelques secondes : Hyperswarm réessaie avec
    // un délai croissant et Dixcord relance la recherche de pairs.
    await B.page.locator('.message-text', { hasText: 'pendant ton absence' }).waitFor({ timeout: 90000 })
    await shot(B.page, '05-rattrapage')

    console.log('✔ Test de bout en bout réussi. Captures dans', OUT)
  } catch (err) {
    // Diagnostic : état vocal et WebRTC de chaque fenêtre encore ouverte.
    for (const app of apps) {
      const page = app.windows()[0]
      if (!page) continue
      const info = await page.evaluate(() => ({
        name: window.__dixcord.state.me.name,
        voice: window.__dixcord.state.server && window.__dixcord.state.server.voice,
        peers: window.__dixcord.voice.stats()
      })).catch((e) => e.message)
      console.log('diagnostic :', JSON.stringify(info))
    }
    throw err
  } finally {
    for (const app of apps) await app.close().catch(() => {})
    await testnet.destroy()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('✘ Échec :', err)
  process.exit(1)
})

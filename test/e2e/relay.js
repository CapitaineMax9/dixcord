'use strict'

// Test de bout en bout « réseaux difficiles » : trois applications, dont deux
// (Bob et Carol) ne peuvent pas se relier directement, comme deux appareils
// en 4G/5G. Elles doivent quand même se voir en ligne, discuter et
// s'entendre, grâce à Alice qui sert de relais.
// Lancer avec : npm run test:e2e:relay
// (sous Linux sans écran : xvfb-run -s "-screen 0 1920x1080x24" npm run test:e2e:relay)

const { _electron: electron } = require('playwright-core')
const createTestnet = require('hyperdht/testnet')
const crypto = require('hypercore-crypto')
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

// Identité fixée à l'avance, pour connaître les clés avant le lancement.
function prepareProfile (dir) {
  const seed = crypto.randomBytes(32)
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'data', 'identity.json'), JSON.stringify({ seed: seed.toString('hex'), name: null }))
  return crypto.keyPair(seed).publicKey.toString('hex')
}

async function launch (name, dataDir, bootstrap, noDirect = []) {
  const packaged = process.env.DIXCORD_E2E_EXECUTABLE
  const args = [
    ...(packaged ? [] : [ROOT]),
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--disable-features=WebRtcHideLocalIpsWithMdns'
  ]
  if (process.getuid && process.getuid() === 0) args.push('--no-sandbox')
  const app = await electron.launch({
    executablePath: packaged ? path.resolve(packaged) : require('electron'),
    args,
    env: {
      ...process.env,
      DIXCORD_DATA_DIR: dataDir,
      DIXCORD_BOOTSTRAP: bootstrap,
      DIXCORD_DHT_HOST: '127.0.0.1',
      DIXCORD_DEBUG: '1',
      DIXCORD_NO_DIRECT: noDirect.join(',')
    }
  })
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream.on('data', (d) => {
      for (const line of String(d).split('\n')) if (line.includes('[dixcord]') && !line.includes('pairs du serveur')) console.log(`[${name}] ${line}`)
    })
  }
  const page = await app.firstWindow()
  page.setDefaultTimeout(TIMEOUT)
  page.on('pageerror', (err) => console.log(`[${name}] erreur de page :`, err.message))
  await page.getByPlaceholder('Ton pseudo').fill(name)
  await page.getByRole('button', { name: 'C’est parti' }).click()
  await page.locator('#user-panel .user-name', { hasText: name }).waitFor()
  return { app, page }
}

async function join (page, invite) {
  await page.getByRole('button', { name: 'Rejoindre avec une invitation' }).click()
  await page.getByLabel('Code d’invitation').fill(invite)
  await page.getByRole('button', { name: 'Rejoindre', exact: true }).click()
  await page.locator('.channel.text', { hasText: 'général' }).waitFor()
}

async function main () {
  fs.mkdirSync(OUT, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dixcord-relay-'))
  const dirs = { a: path.join(tmp, 'a'), b: path.join(tmp, 'b'), c: path.join(tmp, 'c') }
  const keyB = prepareProfile(dirs.b)
  const keyC = prepareProfile(dirs.c)
  const testnet = await createTestnet(3)
  const bootstrap = testnet.bootstrap.map((b) => `${b.host}:${b.port}`).join(',')
  const apps = []

  try {
    step('Alice crée un serveur ; Bob et Carol (sans liaison directe possible) le rejoignent')
    const A = await launch('Alice', dirs.a, bootstrap)
    apps.push(A.app)
    await A.page.getByRole('button', { name: 'Créer un serveur' }).click()
    await A.page.getByLabel('Nom du serveur').fill('4G')
    await A.page.getByRole('button', { name: 'Créer', exact: true }).click()
    const invite = await A.page.locator('.invite-code').inputValue()
    await A.page.getByRole('button', { name: 'Fermer', exact: true }).last().click()

    const B = await launch('Bob', dirs.b, bootstrap, [keyC])
    apps.push(B.app)
    const C = await launch('Carol', dirs.c, bootstrap, [keyB])
    apps.push(C.app)
    await join(B.page, invite)
    await join(C.page, invite)

    step('Bob et Carol se voient en ligne')
    await B.page.locator('.member:not(.offline)', { hasText: 'Carol' }).waitFor()
    await C.page.locator('.member:not(.offline)', { hasText: 'Bob' }).waitFor()
    assert.equal(await B.page.evaluate((k) => !!window.__dixcord.state.server.members.find((m) => m.key === k && m.relayed), keyC), true)

    step('Messages entre Bob et Carol')
    await C.page.locator('#composer-input').fill('Coucou Bob, tu me lis ?')
    await C.page.locator('#composer-input').press('Enter')
    await B.page.locator('.message-text', { hasText: 'Coucou Bob' }).waitFor()

    step('Vocal à trois : Bob et Carol s’entendent via Alice')
    for (const X of [A, B, C]) await X.page.locator('.channel.voice', { hasText: 'Vocal' }).click()
    const hears = (key) => window.__dixcord.voice.stats().some((s) => s.key === key && s.relayedTracks.includes('audio'))
    await B.page.waitForFunction(hears, keyC)
    await C.page.waitForFunction(hears, keyB)
    const via = await B.page.evaluate((k) => window.__dixcord.voice.stats().find((s) => s.key === k).relayedBy, keyC)
    console.log('  Bob entend Carol via', via.slice(0, 8))
    // Le flux relayé est bien audible (non coupé) chez Bob.
    const audible = await B.page.evaluate((k) => {
      const v = window.__dixcord.voice
      return [...v.peers.values()].some((p) => [...p.audioEls].some(([id, el]) => v._attribution(p, id).origin === k && !el.muted))
    }, keyC)
    assert.equal(audible, true)

    step('Caméra de Carol relayée jusqu’à Bob')
    await C.page.getByTitle('Activer la caméra').click()
    await B.page.waitForFunction((k) => {
      const tile = document.querySelector(`.tile[data-key="${k}"] video`)
      return tile && tile.videoWidth > 0
    }, keyC)
    await B.page.screenshot({ path: path.join(OUT, '06-vocal-relaye.png') })

    console.log('✔ Test « réseaux difficiles » réussi.')
  } catch (err) {
    for (const app of apps) {
      const page = app.windows()[0]
      if (!page) continue
      const info = await page.evaluate(() => ({
        name: window.__dixcord.state.me.name,
        members: window.__dixcord.state.server && window.__dixcord.state.server.members,
        voice: window.__dixcord.state.server && window.__dixcord.state.server.voice,
        stats: window.__dixcord.voice.stats()
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

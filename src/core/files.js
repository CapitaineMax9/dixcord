'use strict'

// Stockage des pièces jointes, adressé par contenu : chaque fichier est
// rangé sous son empreinte SHA-256, ce qui permet de vérifier qu'un pair
// nous a bien envoyé le bon fichier.

const fs = require('fs')
const path = require('path')
const nodeCrypto = require('crypto')
const { Transform } = require('stream')
const { pipeline } = require('stream/promises')
const C = require('./constants')
const { HEX64 } = require('./events')
const { randomHex } = require('./crypto')

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar'
}

function guessMime (name) {
  return MIME_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream'
}

function sanitizeFileName (name) {
  // eslint-disable-next-line no-control-regex
  let clean = path.basename(String(name || '')).replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim()
  if (clean.length > C.MAX_FILE_NAME_LENGTH) {
    const ext = path.extname(clean).slice(0, 16)
    clean = clean.slice(0, C.MAX_FILE_NAME_LENGTH - ext.length) + ext
  }
  return clean || 'fichier'
}

class FileStore {
  constructor (dir) {
    this.dir = dir
    this.tmpDir = path.join(dir, 'tmp')
  }

  init () {
    fs.mkdirSync(this.dir, { recursive: true })
    fs.rmSync(this.tmpDir, { recursive: true, force: true })
    fs.mkdirSync(this.tmpDir, { recursive: true })
  }

  path (hash) {
    if (typeof hash !== 'string' || !HEX64.test(hash)) throw new Error('Empreinte invalide')
    return path.join(this.dir, hash)
  }

  has (hash) {
    try {
      return fs.statSync(this.path(hash)).isFile()
    } catch {
      return false
    }
  }

  async importFile (srcPath) {
    const stat = await fs.promises.stat(srcPath)
    if (!stat.isFile()) throw new Error('Ce n’est pas un fichier')
    if (stat.size > C.MAX_FILE_SIZE) throw new Error(`Fichier trop volumineux (max ${C.MAX_FILE_SIZE / 1024 / 1024} Mo)`)
    const tmp = path.join(this.tmpDir, randomHex(8))
    const hash = nodeCrypto.createHash('sha256')
    let size = 0
    try {
      await pipeline(
        fs.createReadStream(srcPath),
        new Transform({
          transform (chunk, _enc, cb) {
            hash.update(chunk)
            size += chunk.length
            cb(null, chunk)
          }
        }),
        fs.createWriteStream(tmp)
      )
    } catch (err) {
      fs.rmSync(tmp, { force: true })
      throw err
    }
    const digest = hash.digest('hex')
    this._commit(tmp, digest)
    const name = sanitizeFileName(srcPath)
    return { hash: digest, name, size, mime: guessMime(name) }
  }

  importBuffer (data, name) {
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    if (buf.length > C.MAX_FILE_SIZE) throw new Error('Fichier trop volumineux')
    const digest = nodeCrypto.createHash('sha256').update(buf).digest('hex')
    const tmp = path.join(this.tmpDir, randomHex(8))
    fs.writeFileSync(tmp, buf)
    this._commit(tmp, digest)
    const clean = sanitizeFileName(name)
    return { hash: digest, name: clean, size: buf.length, mime: guessMime(clean) }
  }

  _commit (tmp, hash) {
    const final = this.path(hash)
    if (fs.existsSync(final)) fs.rmSync(tmp, { force: true })
    else fs.renameSync(tmp, final)
  }

  // Réception d'un fichier par morceaux ; finish() vérifie taille et empreinte.
  createWriter (hash, expectedSize) {
    const tmp = path.join(this.tmpDir, randomHex(8))
    const fd = fs.openSync(tmp, 'w', 0o600)
    const digest = nodeCrypto.createHash('sha256')
    let size = 0
    let closed = false
    const close = () => {
      if (!closed) fs.closeSync(fd)
      closed = true
    }
    return {
      get received () {
        return size
      },
      write: (chunk) => {
        fs.writeSync(fd, chunk)
        digest.update(chunk)
        size += chunk.length
      },
      finish: () => {
        close()
        if (size !== expectedSize || digest.digest('hex') !== hash) {
          fs.rmSync(tmp, { force: true })
          return false
        }
        this._commit(tmp, hash)
        return true
      },
      abort: () => {
        close()
        fs.rmSync(tmp, { force: true })
      }
    }
  }

  createReader (hash) {
    return fs.createReadStream(this.path(hash), { highWaterMark: C.FILE_CHUNK_SIZE })
  }

  async copyTo (hash, dest) {
    await fs.promises.copyFile(this.path(hash), dest)
  }
}

module.exports = { FileStore, guessMime, sanitizeFileName }

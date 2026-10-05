'use strict'

const { MAX_FRAME_SIZE } = require('./constants')

// Format d'une trame :
//   [u32 longueur totale L][u32 longueur en-tête H][en-tête JSON (H octets)][données binaires (L - 4 - H octets)]

function encodeFrame (header, body = null) {
  const head = Buffer.from(JSON.stringify(header), 'utf8')
  const bodyLength = body ? body.length : 0
  const total = 4 + head.length + bodyLength
  if (total > MAX_FRAME_SIZE) throw new Error('Trame trop volumineuse')
  const out = Buffer.allocUnsafe(4 + total)
  out.writeUInt32BE(total, 0)
  out.writeUInt32BE(head.length, 4)
  head.copy(out, 8)
  if (body) Buffer.from(body.buffer, body.byteOffset, body.length).copy(out, 8 + head.length)
  return out
}

class FrameDecoder {
  constructor (onFrame, maxFrameSize = MAX_FRAME_SIZE) {
    this.onFrame = onFrame
    this.maxFrameSize = maxFrameSize
    this.chunks = []
    this.length = 0
    this.need = 4
    this.frameLength = -1
  }

  push (chunk) {
    this.chunks.push(chunk)
    this.length += chunk.length
    while (this.length >= this.need) {
      const buf = this._take(this.need)
      if (this.frameLength < 0) {
        const len = buf.readUInt32BE(0)
        if (len < 4 || len > this.maxFrameSize) throw new Error('Trame invalide')
        this.frameLength = len
        this.need = len
        continue
      }
      this.frameLength = -1
      this.need = 4
      const headLength = buf.readUInt32BE(0)
      if (headLength > buf.length - 4) throw new Error('En-tête de trame invalide')
      const header = JSON.parse(buf.toString('utf8', 4, 4 + headLength))
      if (header === null || typeof header !== 'object' || Array.isArray(header)) {
        throw new Error('En-tête de trame invalide')
      }
      this.onFrame(header, buf.subarray(4 + headLength))
    }
  }

  _take (n) {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.length)
    const rest = all.subarray(n)
    this.chunks = rest.length ? [rest] : []
    this.length = rest.length
    return all.subarray(0, n)
  }
}

module.exports = { encodeFrame, FrameDecoder }

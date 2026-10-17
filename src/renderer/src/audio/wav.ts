/** Mono 32-bit float WAV, the format recorded takes are kept in. */

export function encodeWavMono(pcm: Float32Array, rate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + pcm.length * 4)
  const v = new DataView(buf)
  const str = (o: number, s: string): void => [...s].forEach((c, k) => v.setUint8(o + k, c.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length * 4, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 3, true) // IEEE float
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 4, true)
  v.setUint16(32, 4, true)
  v.setUint16(34, 32, true)
  str(36, 'data')
  v.setUint32(40, pcm.length * 4, true)
  new Float32Array(buf, 44).set(pcm)
  return new Uint8Array(buf)
}

/** Reads back what `encodeWavMono` wrote (float or 16-bit mono/stereo, first channel kept). */
export function decodeWavMono(bytes: Uint8Array): { pcm: Float32Array; rate: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let o = 12
  let fmt = 3
  let channels = 1
  let rate = 48000
  let bits = 32
  while (o + 8 <= bytes.length) {
    const id = String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3))
    const size = v.getUint32(o + 4, true)
    if (id === 'fmt ') {
      fmt = v.getUint16(o + 8, true)
      channels = v.getUint16(o + 10, true)
      rate = v.getUint32(o + 12, true)
      bits = v.getUint16(o + 22, true)
    } else if (id === 'data') {
      const frames = Math.floor(size / ((bits / 8) * channels))
      const pcm = new Float32Array(frames)
      for (let i = 0; i < frames; i++) {
        const p = o + 8 + i * (bits / 8) * channels
        pcm[i] = fmt === 3 ? v.getFloat32(p, true) : v.getInt16(p, true) / 32768
      }
      return { pcm, rate }
    }
    o += 8 + size + (size % 2)
  }
  throw new Error('No audio data in this WAV file.')
}

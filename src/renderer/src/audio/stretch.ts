/**
 * WSOLA time-stretching: lays overlapping windows of the input down at a slower spacing, nudging
 * each one (within ±15 ms) to where its waveform lines up best with the last, so the pitch stays
 * put. Good on full mixes down to about 70% speed; slower gets a little phasey.
 */
export function wsola(channels: Float32Array[], rate: number, sr: number): Float32Array[] {
  const N = Math.round(sr * 0.05) & ~1
  const Hs = N / 2
  const Ha = Hs * rate
  const search = Math.round(sr * 0.015)
  const win = new Float32Array(N)
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)
  const len = channels[0].length
  const outLen = Math.ceil(len / rate) + N
  const outs = channels.map(() => new Float32Array(outLen))
  const norm = new Float32Array(outLen)
  // align on a mono mix
  const mono = new Float32Array(len)
  for (const ch of channels) for (let i = 0; i < len; i++) mono[i] += ch[i] / channels.length
  let prev = 0
  for (let k = 0; k * Hs < outLen - N; k++) {
    const target = Math.round(k * Ha)
    let best = 0
    if (k > 0) {
      // the natural continuation of the previous window should match the new one's start
      const cont = prev + Hs
      let bestScore = -Infinity
      for (let d = -search; d <= search; d += 2) {
        const at = target + d
        if (at < 0 || at + Hs >= len || cont + Hs >= len) continue
        let s = 0
        for (let i = 0; i < Hs; i += 4) s += mono[cont + i] * mono[at + i]
        if (s > bestScore) {
          bestScore = s
          best = d
        }
      }
    }
    const from = Math.max(0, Math.min(len - 1, target + best))
    const o = k * Hs
    for (let c = 0; c < channels.length; c++) {
      const x = channels[c]
      const y = outs[c]
      for (let i = 0; i < N && from + i < len; i++) y[o + i] += x[from + i] * win[i]
    }
    for (let i = 0; i < N; i++) norm[o + i] += win[i]
    prev = from
  }
  for (const y of outs) for (let i = 0; i < outLen; i++) if (norm[i] > 0.1) y[i] /= norm[i]
  return outs.map((y) => y.subarray(0, Math.ceil(len / rate)))
}

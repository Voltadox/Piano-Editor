/**
 * Cleaning up a recorded take before and after tuning: filling dropouts in the middle of a sound,
 * bringing it to a standard level, and a gentle gate so the mic's hiss between phrases isn't
 * brought up with the voice. Pure functions on PCM, run inside the tune worker.
 */

/** Loudness a sung take is brought to: the RMS of its singing, about −18 dBFS, a usual lead-vocal level. */
const TARGET_RMS = 0.125
/** The most a quiet take is boosted: ×8, +18 dB. */
const MAX_GAIN = 8
/** Sound either side of a dropout must be at least this loud (−50 dBFS) for it to count as a cut. */
const SOUND = 0.003

function rms(x: Float32Array, a: number, b: number): number {
  let s = 0
  for (let i = Math.max(0, a); i < Math.min(x.length, b); i++) s += x[i] * x[i]
  return Math.sqrt(s / Math.max(1, b - a))
}

/** The pitch period (samples) of the stretch just before `at`, by autocorrelation; 5 ms if there's none. */
function periodBefore(x: Float32Array, at: number, rate: number): number {
  const len = Math.round(rate * 0.02)
  const lo = Math.round(rate / 500)
  const hi = Math.round(rate / 60)
  if (at - len - hi < 0) return Math.round(rate * 0.005)
  let best = Math.round(rate * 0.005)
  let bestScore = 0.3
  for (let lag = lo; lag <= hi; lag++) {
    let xy = 0
    let xx = 0
    let yy = 0
    for (let i = at - len; i < at; i++) {
      xy += x[i] * x[i - lag]
      xx += x[i] * x[i]
      yy += x[i - lag] * x[i - lag]
    }
    const score = xy / Math.sqrt(xx * yy + 1e-12)
    if (score > bestScore) [bestScore, best] = [score, lag]
  }
  return best
}

/**
 * Fills short dropouts (exact silence of 0.3–30 ms with sound either side, as a mic's noise gate
 * makes when it chatters) by carrying on the waveform from just before, one period at a time, and
 * blending back into the real sound after. Returns the input itself when there was nothing to fill.
 */
export function repairDropouts(x: Float32Array, rate: number): { pcm: Float32Array; repaired: number } {
  let y: Float32Array | null = null
  let repaired = 0
  const w = Math.round(rate * 0.005)
  const blend = Math.round(rate * 0.003)
  for (let i = 0; i < x.length; ) {
    if (x[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < x.length && x[j] === 0) j++
    if (j - i >= 16 && j - i <= rate * 0.03 && i >= w && j + w <= x.length && rms(x, i - w, i) > SOUND && rms(x, j, j + w) > SOUND) {
      y ??= x.slice()
      const p = periodBefore(y, i, rate)
      for (let k = i; k < j; k++) y[k] = y[k - p]
      // fade from the carried-on waveform into the real sound as it comes back
      for (let k = j; k < Math.min(x.length, j + blend); k++) {
        const t = (k - j) / blend
        y[k] = x[k] * t + y[k - p] * (1 - t)
      }
      repaired++
    }
    i = j
  }
  return { pcm: y ?? x, repaired }
}

/**
 * How often per minute the mic dropped to exact silence just after making a sound (within 20 ms
 * of something above −65 dBFS). A clean mic never does; a noise gate or noise suppression
 * outside Keyfall (Windows "Voice clarity", mic enhancements, headset software) does it constantly.
 */
export function gateFlickers(x: Float32Array, rate: number): number {
  const w = Math.round(rate * 0.02)
  let count = 0
  for (let i = 0; i < x.length; ) {
    if (x[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < x.length && x[j] === 0) j++
    if (j - i >= 16 && i > 0 && rms(x, i - w, i) > 10 ** (-65 / 20)) count++
    i = j
  }
  return count / Math.max(1 / 60, x.length / rate / 60)
}

/**
 * The gain that brings a take's singing to TARGET_RMS. Mic takes come in far quieter than the
 * soundfont (there's no automatic gain on the mic). Measured on the louder 20 ms stretches only,
 * so pauses and breaths don't count; never more than MAX_GAIN, and never past full scale.
 */
export function levelGain(pcm: Float32Array, rate: number): number {
  const win = Math.max(1, Math.round(rate * 0.02))
  const levels: number[] = []
  for (let a = 0; a + win <= pcm.length; a += win) {
    const r = rms(pcm, a, a + win)
    if (r > 0.002) levels.push(r)
  }
  if (levels.length < 10) return 1
  levels.sort((p, q) => p - q)
  const loud = levels[Math.floor(levels.length * 0.8)]
  let peak = 0
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]))
  return Math.max(0.5, Math.min(MAX_GAIN, TARGET_RMS / loud, 0.95 / Math.max(peak, 1e-6)))
}

/**
 * A gentle gate, as a gain per sample (0..1): it opens on singing and closes in the gaps between
 * phrases, so mic hiss and the flicker of a mic's own noise gate aren't turned up with the voice.
 * Thresholds follow the take: it opens 12 dB over the hiss (or 30 dB under the singing, if that's
 * higher) and closes once the sound has sat within 6 dB of the hiss for 120 ms, so the hiss itself
 * can't hold it open. It opens 5 ms early so a word's first consonant isn't clipped,
 * and only goes down to −26 dB, so breaths stay faintly there.
 */
export function gateGain(x: Float32Array, rate: number): Float32Array {
  const hop = Math.round(rate * 0.005)
  const frames = Math.ceil(x.length / hop)
  const level = new Float32Array(frames)
  for (let f = 0; f < frames; f++) level[f] = rms(x, f * hop - hop / 2, f * hop + hop * 1.5)
  const sorted = [...level].filter((v) => v > 1e-6).sort((p, q) => p - q)
  const out = new Float32Array(x.length).fill(1)
  if (sorted.length < 20) return out
  const sung = sorted.filter((v) => v > 0.002)
  const loud = sung.length ? sung[Math.floor(sung.length * 0.8)] : sorted[sorted.length - 1]
  // the hiss is the quietest tenth of the take, unless that's barely under the singing: then the
  // take has no quiet stretches to measure (a mic that cuts to dead silence between phrases)
  const quietest = sorted[Math.floor(sorted.length * 0.1)]
  const hiss = quietest > loud * 10 ** (-20 / 20) ? loud * 10 ** (-40 / 20) : quietest
  const open = Math.max(loud * 10 ** (-30 / 20), hiss * 10 ** (12 / 20), 10 ** (-70 / 20))
  const close = Math.min(open * 0.8, Math.max(open / 2, hiss * 10 ** (6 / 20)))
  const floor = 0.05
  const holdFrames = Math.round(0.12 / 0.005)
  const target = new Float32Array(frames)
  let isOpen = false
  let quietFor = 0
  for (let f = 0; f < frames; f++) {
    if (level[f] > open) [isOpen, quietFor] = [true, 0]
    else if (isOpen && level[f] < close && ++quietFor > holdFrames) isOpen = false
    else if (level[f] >= close) quietFor = 0
    target[f] = isOpen ? 1 : floor
  }
  // look ahead one frame, so the gate is already open when a word starts
  for (let f = 0; f < frames - 1; f++) if (target[f + 1] === 1) target[f] = 1
  // smooth: open in 3 ms, close over 60 ms
  const up = 1 - Math.exp(-1 / (rate * 0.003))
  const down = 1 - Math.exp(-1 / (rate * 0.06))
  let g = target[0]
  for (let i = 0; i < x.length; i++) {
    const t = target[Math.min(frames - 1, Math.floor(i / hop))]
    g += (t - g) * (t > g ? up : down)
    out[i] = g
  }
  return out
}

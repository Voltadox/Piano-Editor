/**
 * Voice pitch detection (YIN) and pitch/formant shifting (TD-PSOLA) for recorded takes.
 * Pure functions on PCM, run inside the tune worker.
 */

/** Analysis frames are this far apart, in seconds. */
export const HOP_SEC = 0.01

const LOWEST_HZ = 60
const HIGHEST_HZ = 1000

export const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440)

/**
 * Fundamental frequency per frame in Hz (0 where the voice is silent or unpitched),
 * found on a 16 kHz copy of the audio for speed.
 */
export function detectPitch(pcm: Float32Array, rate: number): Float32Array {
  const factor = Math.max(1, Math.round(rate / 16000))
  const sr = rate / factor
  const n = Math.floor(pcm.length / factor)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let k = 0; k < factor; k++) s += pcm[i * factor + k]
    x[i] = s / factor
  }
  const frames = Math.ceil(pcm.length / (rate * HOP_SEC))
  const hop = sr * HOP_SEC
  const W = Math.round(sr * 0.03)
  const tauMin = Math.floor(sr / HIGHEST_HZ)
  const tauMax = Math.ceil(sr / LOWEST_HZ)
  const d = new Float32Array(tauMax + 2)
  const f0 = new Float32Array(frames)

  for (let f = 0; f < frames; f++) {
    const start = Math.round(f * hop - W / 2)
    if (start < 0 || start + W + tauMax + 1 >= n) continue
    let energy = 0
    for (let j = 0; j < W; j++) energy += x[start + j] * x[start + j]
    if (Math.sqrt(energy / W) < 0.008) continue
    // cumulative mean normalised difference
    let running = 0
    d[0] = 1
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      let sum = 0
      for (let j = 0; j < W; j++) {
        const diff = x[start + j] - x[start + j + tau]
        sum += diff * diff
      }
      running += sum
      d[tau] = running > 0 ? (sum * tau) / running : 1
    }
    let tau = -1
    for (let t = tauMin; t <= tauMax; t++) {
      if (d[t] < 0.15) {
        while (t + 1 <= tauMax && d[t + 1] < d[t]) t++
        tau = t
        break
      }
    }
    if (tau < 0) continue
    // parabolic interpolation around the dip
    const a = d[tau - 1]
    const b = d[tau]
    const c = d[tau + 1]
    const denom = a - 2 * b + c
    const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0
    f0[f] = sr / (tau + Math.max(-0.5, Math.min(0.5, shift)))
  }
  return cleanPitch(f0)
}

/** Removes one-frame blips and octave jumps that detection makes on breathy or mumbled sounds. */
function cleanPitch(f0: Float32Array): Float32Array {
  const out = new Float32Array(f0)
  for (let i = 0; i < f0.length; i++) {
    if (!f0[i]) continue
    const around: number[] = []
    for (let k = -3; k <= 3; k++) if (f0[i + k] > 0) around.push(f0[i + k])
    if (around.length < 3) {
      out[i] = 0
      continue
    }
    around.sort((p, q) => p - q)
    const med = around[around.length >> 1]
    const r = f0[i] / med
    if (r > 1.8 && r < 2.2) out[i] = f0[i] / 2
    else if (r > 0.45 && r < 0.56) out[i] = f0[i] * 2
  }
  return out
}

export interface TuneSettings {
  mode: 'off' | 'key' | 'guide'
  /** 0 natural glide .. 1 instant */
  speed: number
  /** pitch classes notes are allowed to land on */
  scale: number[]
  /** guide target per frame (MIDI pitch, NaN where there is none), lined up with the take */
  guide?: Float32Array
  transpose: number
  detune: number
  formant: number
}

/** Semitones to shift each frame by, and the resulting pitch (for drawing). */
export function pitchShifts(f0: Float32Array, s: TuneSettings): { shift: Float32Array; pitch: Float32Array } {
  const shift = new Float32Array(f0.length)
  const pitch = new Float32Array(f0.length).fill(NaN)
  const tau = 0.004 + (1 - s.speed) ** 2 * 0.25
  const alpha = 1 - Math.exp(-HOP_SEC / tau)
  const inScale = (m: number): boolean => s.scale.includes(((Math.round(m) % 12) + 12) % 12)
  let prevTarget = NaN
  let smooth = 0
  let wasVoiced = false
  const fixed = s.transpose + s.detune / 100
  for (let i = 0; i < f0.length; i++) {
    if (!f0[i]) {
      shift[i] = fixed
      wasVoiced = false
      continue
    }
    const m = hzToMidi(f0[i])
    let target = m
    const g = s.guide?.[i]
    if (s.mode === 'guide' && g !== undefined && !Number.isNaN(g)) {
      // the guide's note in whichever octave is nearest the voice
      target = g + 12 * Math.round((m - g) / 12)
    } else if (s.mode !== 'off') {
      // stay on the current note until the voice clearly moves away from it
      if (!Number.isNaN(prevTarget) && Math.abs(m - prevTarget) < 0.7 && inScale(prevTarget)) target = prevTarget
      else {
        let best = Math.round(m)
        for (let k = 0; k <= 6; k++) {
          if (inScale(Math.round(m) + k)) {
            best = Math.round(m) + k
            break
          }
          if (inScale(Math.round(m) - k)) {
            best = Math.round(m) - k
            break
          }
        }
        target = best
      }
    }
    prevTarget = target
    const raw = target - m
    smooth = wasVoiced ? smooth + (raw - smooth) * alpha : raw
    wasVoiced = true
    shift[i] = smooth + fixed
    pitch[i] = m + shift[i]
  }
  return { shift, pitch }
}

/**
 * Time-domain PSOLA: cuts the voice into two-period grains at each pitch period and lays them
 * down again at the new period. Grains keep their own shape, so the voice's tone (formants) stays
 * put while the pitch moves; resampling each grain shifts the formants on their own.
 */
export function psola(x: Float32Array, rate: number, f0: Float32Array, shift: Float32Array, formant: number): Float32Array {
  const n = x.length
  const hopS = rate * HOP_SEC
  const frameAt = (t: number): number => Math.max(0, Math.min(f0.length - 1, Math.round(t / hopS)))
  // analysis marks, one per period (every 10 ms where unpitched)
  const marks: number[] = []
  const periods: number[] = []
  for (let t = 0; t < n; ) {
    const f = f0[frameAt(t)]
    const p = f > 0 ? rate / f : hopS
    marks.push(t)
    periods.push(p)
    t += p
  }
  const k = Math.pow(2, Math.max(-4, Math.min(4, formant)) / 12)
  const out = new Float32Array(n)
  const wsum = new Float32Array(n)
  let mi = 0
  for (let ts = 0; ts < n; ) {
    while (mi + 1 < marks.length && Math.abs(marks[mi + 1] - ts) <= Math.abs(marks[mi] - ts)) mi++
    const ta = marks[mi]
    const p = periods[mi]
    const fi = frameAt(ta)
    const voiced = f0[fi] > 0
    const ratio = voiced ? Math.pow(2, Math.max(-12, Math.min(12, shift[fi])) / 12) : 1
    const half = p / k
    const from = Math.ceil(ts - half)
    const to = Math.floor(ts + half)
    for (let o = Math.max(0, from); o <= Math.min(n - 1, to); o++) {
      const rel = (o - ts) / half
      const w = 0.5 + 0.5 * Math.cos(Math.PI * rel)
      const src = ta + (o - ts) * k
      const s0 = Math.floor(src)
      if (s0 < 0 || s0 + 1 >= n) continue
      const v = x[s0] + (x[s0 + 1] - x[s0]) * (src - s0)
      out[o] += v * w
      wsum[o] += w
    }
    ts += p / ratio
  }
  for (let i = 0; i < n; i++) out[i] = wsum[i] > 0.3 ? out[i] / wsum[i] : out[i]
  return out
}

import { magnitudes } from '../audio/fft'
import type { RemakePart } from './song'

/**
 * Recreating a song's backing track as MIDI: drum hits from the separated drums, a bass line from
 * the bass, and the rest (keys, guitars, pads) from what's left. Pure functions, run in a worker.
 *
 * Sounds are compared on a log-frequency spectrogram (bands a third of an octave wide or so), which
 * is coarse enough that two pianos look alike and a piano and a flute don't.
 */

export const BAND_RATE = 22050
const N = 2048
const HOP = 256
/** spectrogram frames per second */
export const FPS = BAND_RATE / HOP
const BANDS = 48
const LO_HZ = 30
const HI_HZ = 10500

/** Band edges in FFT bins, spaced evenly in log frequency. */
function bandEdges(): number[] {
  const edges: number[] = []
  for (let b = 0; b <= BANDS; b++) edges.push(Math.round(((LO_HZ * (HI_HZ / LO_HZ) ** (b / BANDS)) * N) / BAND_RATE))
  // the lowest bands are narrower than a bin: give each at least one
  for (let b = 1; b <= BANDS; b++) edges[b] = Math.max(edges[b], edges[b - 1] + 1)
  return edges
}
const EDGES = bandEdges()

/** Power in each band, frames × BANDS, from mono audio at BAND_RATE. */
export function bandSpectrogram(x: Float32Array): Float32Array[] {
  return magnitudes(x, N, HOP).map((mag) => {
    const out = new Float32Array(BANDS)
    for (let b = 0; b < BANDS; b++) {
      let s = 0
      for (let k = EDGES[b]; k < EDGES[b + 1]; k++) s += mag[k] * mag[k]
      out[b] = s
    }
    return out
  })
}

// ---------- drums ----------

/** The drums a recreation can use, as General MIDI drum notes. */
export const DRUM_NOTES = [
  { note: 36, name: 'kick' },
  { note: 38, name: 'snare' },
  { note: 39, name: 'clap' },
  { note: 42, name: 'closed hat' },
  { note: 46, name: 'open hat' },
  { note: 45, name: 'low tom' },
  { note: 48, name: 'high tom' },
  { note: 49, name: 'crash' },
  { note: 51, name: 'ride' }
] as const

export interface Hit {
  /** seconds */
  time: number
  note: number
  /** 1..127 */
  vel: number
}

/** A hit's description: what it adds to each band as it's struck, then what still rings ~150-230 ms on. */
const DIM = BANDS * 2

function hitFeature(S: Float32Array[], t: number): Float32Array {
  const T = S.length
  const at = (k: number): Float32Array => S[Math.min(T - 1, Math.max(0, k))]
  const d = new Float32Array(DIM)
  for (let b = 0; b < BANDS; b++) {
    const before = Math.min(at(t - 2)[b], at(t - 1)[b])
    d[b] = Math.max(0, Math.max(at(t)[b], at(t + 1)[b], at(t + 2)[b]) - before)
    // the quietest moment in the window, so a later hit doesn't count as ringing
    let ring = Infinity
    for (let k = 13; k <= 20; k++) ring = Math.min(ring, at(t + k)[b])
    d[BANDS + b] = Math.max(0, ring - before)
  }
  return d
}

/** Rises in log magnitude summed over the bands: high where something is struck. */
function onsetCurve(S: Float32Array[]): Float32Array {
  let big = 0
  for (const f of S) for (const v of f) big = Math.max(big, v)
  const g = big > 0 ? 1000 / big : 1
  const flux = new Float32Array(S.length)
  for (let t = 1; t < S.length; t++) {
    let s = 0
    for (let b = 0; b < BANDS; b++) s += Math.max(0, Math.log1p(g * S[t][b]) - Math.log1p(g * S[t - 1][b]))
    flux[t] = s
  }
  return flux
}

const sum1 = (w: Float32Array): Float32Array => {
  const s = w.reduce((a, v) => a + v, 0)
  return s > 0 ? w.map((v) => v / s) : w
}

/** A drum's sound as a template, from a render of it struck once on its own. */
export function drumTemplate(render: Float32Array): Float32Array {
  const S = bandSpectrogram(render).map((f) => f.map(Math.sqrt))
  const flux = onsetCurve(S)
  let at = 1
  for (let t = 1; t < flux.length; t++) if (flux[t] > flux[at]) at = t
  return sum1(hitFeature(S, at))
}

/** Non-negative least squares by multiplicative updates: d ≈ Σ a_k·W_k. */
function nnls(d: Float32Array, W: Float32Array[], iters = 150): Float64Array {
  const K = W.length
  const a = new Float64Array(K).fill(d.reduce((s, v) => s + v, 0) / K)
  const WtW = W.map((wi) => W.map((wj) => wi.reduce((s, v, b) => s + v * wj[b], 0)))
  const Wtd = W.map((w) => w.reduce((s, v, b) => s + v * d[b], 0))
  for (let it = 0; it < iters; it++)
    for (let k = 0; k < K; k++) {
      let den = 1e-12
      for (let j = 0; j < K; j++) den += WtW[k][j] * a[j]
      a[k] *= Wtd[k] / den
    }
  return a
}

const CYMBAL_HZ = 2000
/** the onset curve peaks this long before the hit you hear (the analysis window reaches it early) */
const ONSET_LAG = 0.023
const CYMBALS: number[] = [42, 46, 49, 51]

/**
 * Drum hits from a separated drum track. Every onset is found first (a sharp rise across the
 * spectrum); then the rise is explained by the kit's drums, each a spectral template: the drum that
 * explains it best, and a second only if it clearly helps. The templates start as the kit's own
 * sounds and are then re-learnt from the hits they won, so a song's own kick and snare are found
 * even when they don't sound like the kit's.
 */
export function transcribeDrums(x: Float32Array, templates: { note: number; w: Float32Array }[]): Hit[] {
  const S = bandSpectrogram(x).map((f) => f.map(Math.sqrt))
  const T = S.length
  if (T < 8 || !templates.length) return []
  // onsets: peaks in the onset curve well above its local average
  const flux = onsetCurve(S)
  const r = Math.round(FPS * 0.1)
  const onsets: number[] = []
  const gap = Math.round(FPS * 0.03)
  const sorted = [...flux].sort((a, b) => a - b)
  const loud = sorted[Math.floor(T * 0.99)] || 1
  for (let t = 2; t < T - 2; t++) {
    const v = flux[t]
    if (v < flux[t - 1] || v < flux[t + 1] || v < flux[t - 2] || v < flux[t + 2]) continue
    let mean = 0
    for (let k = Math.max(0, t - r); k < Math.min(T, t + r); k++) mean += flux[k]
    mean /= Math.min(T, t + r) - Math.max(0, t - r)
    if (v < mean * 1.3 + loud * 0.06) continue
    if (onsets.length && t - onsets[onsets.length - 1] < gap) continue
    onsets.push(t)
  }
  const rises = onsets.map((t) => hitFeature(S, t))
  const sizes = rises.map((d) => d.reduce((s, v) => s + v, 0))
  const bigRise = [...sizes].sort((a, b) => a - b)[Math.floor(sizes.length * 0.95)] || 1
  // each band weighed by how much it usually rises, so a hat's highs count as much as a kick's lows
  const scale = new Float32Array(DIM)
  for (let b = 0; b < DIM; b++) {
    const col = rises.map((d) => d[b]).sort((x, y) => x - y)
    scale[b] = col[Math.floor(col.length * 0.9)] ?? 0
  }
  // bands the song hardly uses aren't blown up
  const most = Math.max(...scale)
  for (let b = 0; b < DIM; b++) scale[b] = Math.max(scale[b], most * 0.1, 1e-9)
  const whiten = (w: Float32Array): Float32Array => {
    const out = w.map((v, b) => v / scale[b])
    const sum = out.reduce((s, v) => s + v, 0)
    return out.map((v) => v / (sum || 1))
  }
  const R = rises.map((d) => d.map((v, b) => v / scale[b]))
  const rSize = R.map((d) => d.reduce((s, v) => s + v, 0))
  const W0 = templates.map((t) => whiten(t.w))
  // two stages: drums from the bands below the cymbals, then cymbals from the bands above, where
  // the drums already found compete with them (a hat fits a hat better than a kick's click does)
  const high = new Uint8Array(DIM).map((_, d) => Number(LO_HZ * (HI_HZ / LO_HZ) ** (((d % BANDS) + 0.5) / BANDS) >= CYMBAL_HZ))
  const pick = (v: Float32Array, hi: boolean): Float32Array => v.filter((_, d) => !!high[d] === hi)
  // a clap and a snare sound much alike and a song rarely has both on the same beats: they're one
  // drum here, named afterwards for whichever the song's hits resemble more
  const group = (note: number): number => (note === 39 ? 38 : note)
  const groups = [...new Set(templates.map((t) => group(t.note)))]
  const drumGroups = groups.filter((g) => !CYMBALS.includes(g))
  const cymGroups = groups.filter((g) => CYMBALS.includes(g))
  const members = (g: number): number[] => templates.flatMap((t, k) => (group(t.note) === g ? [k] : []))
  let W = W0

  /** Fits d with the templates ks; returns their amounts and what's left unexplained. */
  const fit = (d: Float32Array, ks: number[], hi: boolean): { a: Float64Array; err: number } => {
    const parts = ks.map((k) => pick(W[k], hi))
    const a = ks.length ? nnls(d, parts) : new Float64Array(0)
    let err = 0
    for (let j = 0; j < d.length; j++) {
      let r = d[j]
      parts.forEach((w, i) => (r -= a[i] * w[j]))
      err += r * r
    }
    return { a, err }
  }
  /**
   * Picks the drums struck at one onset, best first: the one that explains the most, then a second
   * only if it halves what's left. `fixed` templates take part without being picked themselves.
   */
  const choose = (d: Float32Array, options: number[], fixed: number[], hi: boolean, firstShare: number): { g: number; amount: number }[] => {
    const base = fit(d, fixed, hi).err
    const chosen: number[] = []
    let err = base
    for (let round = 0; round < 2; round++) {
      let best = -1
      let bestErr = Infinity
      for (const g of options) {
        if (chosen.includes(g)) continue
        const e = fit(d, [...fixed, ...chosen.flatMap(members), ...members(g)], hi).err
        if (e < bestErr) {
          bestErr = e
          best = g
        }
      }
      if (best < 0 || bestErr > err * (round === 0 ? 1 - firstShare : 0.5)) break
      chosen.push(best)
      err = bestErr
    }
    const ks = [...fixed, ...chosen.flatMap(members)]
    const { a } = fit(d, ks, hi)
    const amountOf = new Map<number, number>()
    ks.forEach((k, i) => amountOf.set(k, a[i]))
    lastAmounts = amountOf
    return chosen.map((g) => ({ g, amount: members(g).reduce((s, k) => s + (amountOf.get(k) ?? 0), 0) }))
  }
  let lastAmounts = new Map<number, number>()

  let found: { i: number; g: number; amount: number; ks: Map<number, number> }[] = []
  for (let pass = 0; pass < 3; pass++) {
    found = []
    R.forEach((d, i) => {
      if (sizes[i] < bigRise * 0.02) return
      // a drum needs real energy below the cymbals, not just a cymbal's faint low end
      const low = pick(rises[i], false).reduce((s, v) => s + v, 0)
      const drums = low >= sizes[i] * 0.25 || low >= bigRise * 0.1 ? choose(pick(d, false), drumGroups, [], false, 0.5) : []
      for (const x of drums) found.push({ i, ...x, ks: lastAmounts })
      const cyms = choose(pick(d, true), cymGroups, drums.flatMap((x) => members(x.g)), true, 0.4)
      for (const x of cyms) found.push({ i, ...x, ks: lastAmounts })
    })
    if (pass === 2) break
    // re-learn each template from the hits where its drum was struck alone and it fitted best,
    // blended with the kit's sound
    const alone = found.filter((f) => found.filter((o) => o.i === f.i && CYMBALS.includes(o.g) === CYMBALS.includes(f.g)).length === 1)
    W = W.map((w, k) => {
      const acc = new Float64Array(DIM)
      let n = 0
      for (const f of alone) {
        const mine = members(f.g)
        if (!mine.includes(k) || mine.some((o) => (f.ks.get(o) ?? 0) > (f.ks.get(k) ?? 0)) || sizes[f.i] < bigRise * 0.05) continue
        for (let b = 0; b < DIM; b++) acc[b] += R[f.i][b] / rSize[f.i]
        n++
      }
      if (n < 3) return w
      const out = new Float32Array(DIM)
      let sum = 0
      for (let b = 0; b < DIM; b++) sum += out[b] = 0.3 * W0[k][b] + (0.7 * acc[b]) / n
      return out.map((v) => v / sum)
    })
  }

  const hits: Hit[] = []
  for (const g of groups) {
    const mine = found.filter((f) => f.g === g)
    if (!mine.length) continue
    const amounts = mine.map((f) => f.amount).sort((x, y) => x - y)
    const usual = amounts[amounts.length >> 1]
    const top = amounts[Math.floor(amounts.length * 0.9)] || usual
    let clap = 0
    let snare = 0
    for (const f of mine)
      for (const [k, v] of f.ks) {
        if (templates[k].note === 39) clap += v
        else if (templates[k].note === 38) snare += v
      }
    const note = g === 38 && clap > snare * 1.5 ? 39 : g
    for (const f of mine) {
      // much quieter than this drum usually is: a trace of something else
      if (f.amount < usual * 0.2) continue
      hits.push({ time: (onsets[f.i] * HOP) / BAND_RATE + ONSET_LAG, note, vel: Math.round(Math.max(25, Math.min(127, 127 * Math.sqrt(Math.min(1, f.amount / top))))) })
    }
  }
  return hits.sort((a, b) => a.time - b.time || a.note - b.note)
}

// ---------- notes ----------

/** A note heard in a recording (seconds), as the note finder reports it. */
export interface HeardNote {
  start: number
  end: number
  pitch: number
  /** 0..1 */
  amp: number
}

export interface PartNote {
  start: number
  end: number
  pitch: number
  vel: number
}

const velOf = (amp: number): number => Math.round(Math.max(30, Math.min(120, 35 + 85 * Math.min(1, amp) ** 0.8)))

/**
 * A bass line from the notes found in the separated bass: one note at a time, in the bass range.
 * Where two overlap, an octave doubling is usually the note finder hearing the second harmonic, so
 * the lower one wins unless it's much fainter; otherwise the stronger one does.
 */
export function bassLine(heard: HeardNote[]): PartNote[] {
  const notes = heard.filter((n) => n.pitch >= 23 && n.pitch <= 60 && n.end - n.start >= 0.06).sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  const kept: HeardNote[] = []
  for (const n of notes) {
    const last = kept[kept.length - 1]
    if (!last || n.start >= last.end - 0.03) {
      kept.push({ ...n })
      continue
    }
    // overlapping: started together, they're one note heard twice; otherwise the new one cuts the old
    if (n.start - last.start < 0.08) {
      const octave = Math.abs(n.pitch - last.pitch) % 12 === 0
      const lower = n.pitch < last.pitch ? n : last
      const upper = lower === n ? last : n
      const win = octave ? (lower.amp >= upper.amp * 0.5 ? lower : upper) : n.amp > last.amp ? n : last
      kept[kept.length - 1] = { ...win, start: Math.min(n.start, last.start), end: Math.max(n.end, last.end) }
    } else if (n.amp >= last.amp * 0.6) {
      last.end = n.start
      kept.push({ ...n })
    }
  }
  return kept.filter((n) => n.end - n.start >= 0.05).map((n) => ({ start: n.start, end: n.end, pitch: n.pitch, vel: velOf(n.amp) }))
}

/**
 * Chords and lines from what's left once drums and bass are taken out. Low notes that the bass is
 * already playing are its leftovers; very short faint blips are noise; a note re-found straight
 * after itself is one note.
 */
export function keysPart(heard: HeardNote[], bass: PartNote[]): PartNote[] {
  const sorted = heard.filter((n) => n.end - n.start >= 0.05 && !(n.end - n.start < 0.1 && n.amp < 0.4)).sort((a, b) => a.pitch - b.pitch || a.start - b.start)
  const merged: HeardNote[] = []
  for (const n of sorted) {
    const last = merged[merged.length - 1]
    if (last && last.pitch === n.pitch && n.start - last.end < 0.03) {
      last.end = Math.max(last.end, n.end)
      last.amp = Math.max(last.amp, n.amp)
    } else merged.push({ ...n })
  }
  const leak = (n: HeardNote): boolean =>
    n.pitch < 48 && bass.some((b) => b.start < n.end && n.start < b.end && (n.pitch - b.pitch) % 12 === 0 && Math.min(b.end, n.end) - Math.max(b.start, n.start) > 0.5 * (n.end - n.start))
  return merged
    .filter((n) => !leak(n))
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch)
    .map((n) => ({ start: n.start, end: n.end, pitch: n.pitch, vel: velOf(n.amp) }))
}

// ---------- matching sounds ----------

export type Family = 'drums' | 'bass' | 'keys' | 'skip'

/**
 * Roughly what a preset is, from its name, or for General MIDI soundfonts its program number: drum
 * kits play drums, basses play bass, and nearly everything else may play the rest.
 */
export function family(name: string, program: number, drum: boolean, generalMidi: boolean): Family {
  const n = name.toLowerCase()
  if (drum || /\bkit\b|drum ?set|drumkit/.test(n)) return 'drums'
  if (/unused|sound ?effects|special fx|\bsfx\b|seashore|helicopter|applause|gunshot|telephone|bird|fret ?noise|breath noise/.test(n)) return 'skip'
  if (/bass(?!oon| clar)/.test(n) || (generalMidi && program >= 32 && program <= 39)) return 'bass'
  if (generalMidi && program >= 120) return 'skip'
  return 'keys'
}

/**
 * Whether a preset is worth auditioning on a part: drums from kits, the bass from basses (or from
 * anything, in a soundfont whose names and numbers don't say), the rest from everything else.
 * General MIDI soundfonts' variation banks hold near-copies of the main bank, so they're skipped.
 * `bank` is the bank select MSB, plus 128 for a General MIDI kit.
 */
export function suits(part: RemakePart, p: { name: string; bank: number; program: number }, generalMidi: boolean): boolean {
  const kit = p.bank >= 128
  if (generalMidi && p.bank !== 0 && !kit) return false
  const fam = family(p.name, p.program, kit, generalMidi)
  return part === 'drums' ? fam === 'drums' : part === 'bass' ? fam === 'bass' || (!generalMidi && fam === 'keys') : fam === 'keys'
}

/** Names a preset within its soundfont. */
export const suitKey = (p: { bankMSB: number; isGMGSDrum: boolean; program: number }): string => `${p.bankMSB + (p.isGMGSDrum ? 128 : 0)}:${p.program}`

/**
 * General MIDI soundfonts number their presets by instrument (0 a piano, 32-39 basses), so their
 * program numbers say what a preset is. Told apart by their names saying so.
 */
export function isGeneralMidi(presets: { name: string; bank: number; program: number }[]): boolean {
  const at = (p: number): string => presets.find((x) => x.bank === 0 && x.program === p)?.name.toLowerCase() ?? ''
  const basses = [32, 33, 34, 35, 36, 37, 38, 39].filter((p) => at(p).includes('bass')).length
  return /piano/.test(at(0)) && basses >= 5
}

/** The stretch of a part, `length` seconds long, with the most going on, between two times. */
function busiestWindow(notes: { start: number; end: number }[], length: number, lo: number, hi: number): number | null {
  let best: number | null = null
  let most = 0
  for (const n of notes) {
    if (n.start < lo || n.start >= hi) continue
    const from = Math.max(0, n.start - 0.05)
    let busy = 0
    for (const m of notes) busy += Math.max(0, Math.min(m.end, from + length) - Math.max(m.start, from))
    if (busy > most) {
      most = busy
      best = from
    }
  }
  return best
}

/**
 * Where to audition sounds for a part: the busiest stretch in each of a few equal spans of the
 * song, so a part that changes (a sparse verse, a full chorus) is heard in more than one place.
 */
export function auditionWindows(notes: { start: number; end: number }[], count = 3, length = 4): number[] {
  if (!notes.length) return []
  const first = notes[0].start
  const last = Math.max(...notes.map((n) => n.end))
  const span = (last - first) / count
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const w = busiestWindow(notes, length, first + i * span, first + (i + 1) * span)
    if (w !== null && !out.some((o) => Math.abs(o - w) < length)) out.push(w)
  }
  return out
}

/**
 * How unlike a recording a render of the same notes sounds: the average gap between their
 * log-spectrograms where the recording has something going on, after matching their levels
 * (`gainDb` is how much louder the recording is). Lower is closer.
 */
export function compareSound(target: Float32Array[], render: Float32Array[]): { distance: number; gainDb: number } {
  const frames = Math.min(target.length, render.length)
  let peak = 0
  for (let t = 0; t < frames; t++) for (const v of target[t]) peak = Math.max(peak, v)
  if (peak <= 0) return { distance: Infinity, gainDb: 0 }
  const floor = peak * 1e-5
  const lt: Float32Array[] = []
  const lr: Float32Array[] = []
  let loudFrame = 0
  const energy = target.slice(0, frames).map((f) => f.reduce((s, v) => s + v, 0))
  for (const e of energy) loudFrame = Math.max(loudFrame, e)
  let sounding = 0
  for (let t = 0; t < frames; t++) {
    if (energy[t] < loudFrame * 1e-3) continue
    lt.push(target[t].map((v) => Math.log10(v + floor)))
    lr.push(render[t].map((v) => Math.log10(v + floor)))
    if (render[t].some((v) => v > 1e-10)) sounding++
  }
  // a preset with nothing for these notes (no samples that low, say) can't play the part
  if (!lt.length || sounding < lt.length * 0.5) return { distance: Infinity, gainDb: 0 }
  // level match: the median difference, so a few wrong notes don't skew it
  const diffs: number[] = []
  for (let i = 0; i < lt.length; i++) for (let b = 0; b < BANDS; b++) if (lt[i][b] > Math.log10(floor) + 1) diffs.push(lt[i][b] - lr[i][b])
  diffs.sort((a, b) => a - b)
  const offset = diffs.length ? diffs[diffs.length >> 1] : 0
  let sum = 0
  for (let i = 0; i < lt.length; i++) for (let b = 0; b < BANDS; b++) sum += Math.min(3, Math.abs(lt[i][b] - lr[i][b] - offset))
  return { distance: sum / (lt.length * BANDS), gainDb: 10 * offset }
}

/**
 * The track volume (0..1) that brings a part rendered at the synth's default volume (controller 7
 * at 100) up or down by `gainDb`. Volume follows the General MIDI curve: 40·log10(value/127) dB.
 */
export function volumeFor(gainDb: number): number {
  const db = 40 * Math.log10(100 / 127) + gainDb
  return Math.max(0.05, Math.min(1, 10 ** (db / 40)))
}

/** Drum hits as notes: each lasts until the next hit, up to a quarter second. */
export function drumNotes(hits: Hit[]): PartNote[] {
  return hits.map((h, i) => {
    const next = hits.slice(i + 1).find((o) => o.time > h.time)
    return { start: h.time, end: h.time + Math.min(0.25, Math.max(0.05, (next?.time ?? h.time + 1) - h.time)), pitch: h.note, vel: h.vel }
  })
}

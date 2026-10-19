import { magnitudes } from '../audio/fft'
import type { ChordMark, Note, RemakePart } from './song'

/**
 * Recreating a song's backing track as MIDI: drum hits from the separated drums, a bass line from
 * the bass, and the rest (keys, guitars, pads) from what's left. Pure functions, run in a worker.
 *
 * Sounds are compared on a log-frequency spectrogram (bands a third of an octave wide or so), which
 * is coarse enough that two pianos look alike and a piano and a flute don't.
 */

export const BAND_RATE = 22050
const N = 2048
export const HOP = 256
/** spectrogram frames per second */
export const FPS = BAND_RATE / HOP
export const BANDS = 48
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

/** The middle of a band, in Hz. */
export const bandHz = (b: number): number => LO_HZ * (HI_HZ / LO_HZ) ** ((b + 0.5) / BANDS)

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

/**
 * Frames where something is struck: peaks in the onset curve well above its local average, and
 * above `floor` of the loudest strikes (a mix needs more; a lone voice can go lower).
 */
export function findOnsets(S: Float32Array[], floor = 0.06): number[] {
  const T = S.length
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
    if (v < mean * 1.3 + loud * floor) continue
    if (onsets.length && t - onsets[onsets.length - 1] < gap) continue
    onsets.push(t)
  }
  return onsets
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
export const ONSET_LAG = 0.023
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
  const onsets = findOnsets(S)
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

// ---------- keys detail ----------

/** How much of what was heard the Keys track plays, simplest first. */
export const KEYS_LEVELS = [
  { name: 'Beginner', hint: 'the tune in the right hand, one held root per chord in the left' },
  { name: 'Easy', hint: 'the tune, with the root and fifth of each chord' },
  { name: 'Medium', hint: 'up to three notes at once: the top line, the bass and one more' },
  { name: 'Advanced', hint: 'up to five notes at once, faint blips dropped' },
  { name: 'Full', hint: 'everything heard, up to seven or more keys at once' }
] as const
export const FULL_DETAIL = KEYS_LEVELS.length - 1

/** A note placed in the song (ticks), before it gets an id. */
export type Placed = Omit<Note, 'id'>

export interface DetailContext {
  ppq: number
  /** ticks per bar */
  bar: number
  /** the chord lane, for the left hand's roots */
  chords: ChordMark[]
  /** the sung tune, if the song's melody was found, for the right hand at the simplest levels */
  tune: Placed[] | null
}

const median = (x: number[]): number => [...x].sort((a, b) => a - b)[x.length >> 1] ?? 0

/** Notes that start together (within `tol` ticks), in time order. */
function clusters(notes: Placed[], tol: number): Placed[][] {
  const out: Placed[][] = []
  for (const n of [...notes].sort((a, b) => a.tick - b.tick || b.pitch - a.pitch)) {
    const g = out[out.length - 1]
    if (g && n.tick - g[0].tick <= tol) g.push(n)
    else out.push([n])
  }
  return out
}

/** Starts and ends on the grid, at least one step long. */
function snapNote(n: Placed, grid: number): Placed {
  const tick = Math.round(n.tick / grid) * grid
  return { ...n, tick, dur: Math.max(grid, Math.round((n.tick + n.dur) / grid) * grid - tick) }
}

/** One note at a time: the higher of two starting together, each cut where the next begins. */
function monophonic(line: Placed[]): Placed[] {
  const out: Placed[] = []
  for (const n of [...line].sort((a, b) => a.tick - b.tick || b.pitch - a.pitch)) {
    const prev = out[out.length - 1]
    if (prev && prev.tick === n.tick) continue
    if (prev && prev.tick + prev.dur > n.tick) prev.dur = n.tick - prev.tick
    out.push({ ...n })
  }
  return out
}

/** A note on the same key as a later one ends before it starts, so neither swallows the other. */
function untangle(notes: Placed[]): Placed[] {
  const sorted = [...notes].sort((a, b) => a.tick - b.tick || a.pitch - b.pitch)
  const out: Placed[] = []
  const last = new Map<number, Placed>()
  for (const n of sorted) {
    const prev = last.get(n.pitch)
    if (prev && prev.tick === n.tick) {
      prev.dur = Math.max(prev.dur, n.dur)
      prev.vel = Math.max(prev.vel, n.vel)
      continue
    }
    if (prev && prev.tick + prev.dur > n.tick) prev.dur = n.tick - prev.tick
    const copy = { ...n }
    last.set(n.pitch, copy)
    out.push(copy)
  }
  return out
}

/**
 * The right hand's tune: the sung melody if there is one, otherwise the top note of each of the
 * keys' chords (leaving out quiet ones, which are usually inner voices ringing through). One note
 * at a time on the grid, moved by octaves as a whole into the middle of the keyboard.
 */
function tuneLine(keys: Placed[], ctx: DetailContext, grid: number, hold: boolean): Placed[] {
  let line: Placed[]
  if (ctx.tune?.length) line = ctx.tune
  else {
    const loud = median(keys.map((n) => n.vel))
    line = clusters(keys, ctx.ppq / 8)
      .map((g) => g.reduce((a, b) => (b.pitch > a.pitch ? b : a)))
      .filter((n) => n.vel >= loud * 0.6)
  }
  line = monophonic(line.filter((n) => n.dur >= grid / 2).map((n) => snapNote(n, grid))).filter((n) => n.dur >= grid)
  // the keys' top note struck again and again is rhythm, not tune: held instead, up to the bar line
  if (hold && !ctx.tune?.length)
    line = line.reduce<Placed[]>((out, n) => {
      const prev = out[out.length - 1]
      if (prev && prev.pitch === n.pitch && prev.tick + prev.dur === n.tick && Math.floor(prev.tick / ctx.bar) === Math.floor(n.tick / ctx.bar)) prev.dur += n.dur
      else out.push({ ...n })
      return out
    }, [])
  if (!line.length) return []
  const shift = 12 * Math.round((70 - median(line.map((n) => n.pitch))) / 12)
  return line.map((n) => {
    let p = n.pitch + shift
    while (p < 60) p += 12
    while (p > 88) p -= 12
    return { ...n, pitch: p, vel: 84 }
  })
}

/** Where there's no chord lane: each bar's root, the pitch class its lower notes hold longest. */
function barRoots(keys: Placed[], bar: number): ChordMark[] {
  const marks: ChordMark[] = []
  if (!keys.length) return marks
  const end = Math.max(...keys.map((n) => n.tick + n.dur))
  for (let at = Math.floor(keys[0].tick / bar) * bar; at < end; at += bar) {
    const here = keys.filter((n) => n.tick < at + bar && n.tick + n.dur > at)
    const low = here.filter((n) => n.pitch < 60)
    const weight = new Array(12).fill(0)
    for (const n of low.length ? low : here) weight[n.pitch % 12] += Math.min(at + bar, n.tick + n.dur) - Math.max(at, n.tick)
    const root = weight.some((w) => w > 0) ? weight.indexOf(Math.max(...weight)) : -1
    if (marks[marks.length - 1]?.root !== root) marks.push({ tick: at, root, minor: false })
  }
  return marks
}

/**
 * The left hand: each chord's root (with its fifth, at Easy) held, struck again at every bar line
 * so it keeps time, between `from` and `to`.
 */
function rootLine(keys: Placed[], ctx: DetailContext, from: number, to: number, fifth: boolean): Placed[] {
  const marks = ctx.chords.some((c) => c.root >= 0) ? ctx.chords : barRoots(keys, ctx.bar)
  const beat = ctx.ppq
  const gap = ctx.ppq / 16
  const out: Placed[] = []
  marks.forEach((c, i) => {
    const start = Math.max(from, c.tick)
    const stop = Math.min(to, marks[i + 1]?.tick ?? to)
    if (c.root < 0 || stop - start < beat / 2) return
    // the root from C3 up, or from F2 up with its fifth, so both stay below middle C
    const root = fifth ? 41 + ((((c.root - 41) % 12) + 12) % 12) : 48 + c.root
    const cuts = [start]
    for (let b = Math.ceil((start + 1) / ctx.bar) * ctx.bar; b < stop; b += ctx.bar) if (b - cuts[cuts.length - 1] >= beat && stop - b >= beat) cuts.push(b)
    cuts.push(stop)
    for (let k = 0; k + 1 < cuts.length; k++) {
      const dur = Math.max(gap, cuts[k + 1] - cuts[k] - gap)
      out.push({ pitch: root, tick: cuts[k], dur, vel: 68 })
      if (fifth) out.push({ pitch: root + 7, tick: cuts[k], dur, vel: 60 })
    }
  })
  return out
}

/**
 * At most `most` keys down at once. Of notes starting together, the highest and lowest are kept
 * first (they carry the tune and the bass), then the loudest and longest. A new chord takes over
 * from held notes that would go past the limit, oldest first.
 */
function thin(keys: Placed[], most: number, tol: number): Placed[] {
  const out: Placed[] = []
  for (const g of clusters(keys, tol)) {
    const at = g[0].tick
    const pitches = [...new Set(g.map((n) => n.pitch))]
    const top = Math.max(...pitches)
    const bottom = Math.min(...pitches)
    const strength = (n: Placed): number => (n.pitch === top ? 2e9 : n.pitch === bottom ? 1e9 : n.vel * Math.sqrt(n.dur))
    const take = pitches
      .map((p) => g.filter((n) => n.pitch === p).reduce((a, b) => (strength(b) > strength(a) ? b : a)))
      .sort((a, b) => strength(b) - strength(a))
      .slice(0, most)
    const held = out.filter((n) => n.tick + n.dur > at).sort((a, b) => a.tick - b.tick)
    let over = held.length + take.length - most
    for (const n of held) {
      if (over <= 0 && !take.some((t) => t.pitch === n.pitch)) continue
      n.dur = Math.max(1, at - n.tick)
      over--
    }
    out.push(...take.map((n) => ({ ...n })))
  }
  return out
}

/**
 * The keys at a level of detail, from the Full transcription (`level` FULL_DETAIL) down to a
 * beginner's two-hand part. The simpler levels also play more evenly, so the part sits under the
 * song instead of over it.
 */
export function simplifyKeys(keys: Placed[], level: number, ctx: DetailContext): Placed[] {
  if (level >= FULL_DETAIL || !keys.length) return keys.map((n) => ({ ...n }))
  const tol = ctx.ppq / 8
  const even = (n: Placed, by: number): Placed => ({ ...n, vel: Math.round(64 + (n.vel - 64) * by) })
  if (level <= 1) {
    const grid = level === 0 ? ctx.ppq / 2 : ctx.ppq / 4
    const tune = tuneLine(keys, ctx, grid, level === 0)
    const from = Math.min(...keys.map((n) => n.tick), tune[0]?.tick ?? Infinity)
    const to = Math.max(...keys.map((n) => n.tick + n.dur), ...tune.map((n) => n.tick + n.dur))
    const left = rootLine(keys, ctx, Math.floor(from / ctx.ppq) * ctx.ppq, to, level === 1)
    return untangle([...tune, ...left])
  }
  if (level === 2) {
    // no blips or faint notes, on a sixteenth grid
    const kept = keys.filter((n) => n.dur >= ctx.ppq / 4 && n.vel >= 45)
    return untangle(thin(kept.map((n) => snapNote(n, ctx.ppq / 4)), 3, tol).map((n) => even(n, 0.6)))
  }
  const kept = keys.filter((n) => n.dur >= ctx.ppq / 8 || n.vel >= 60)
  return untangle(thin(kept, 5, tol).map((n) => even(n, 0.8)))
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

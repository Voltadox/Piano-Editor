import { chordTimeline, scaleOf, songKey } from './guide'
import { arrangeEnd } from './timeline'
import { newId, sortNotes, ticksPerBar, ticksPerBeat, type CC, type Note, type Song } from './song'

/**
 * Generated parts: strings, a violin line, plucks, arpeggios, bass, bells, textures and risers,
 * written to fit the song's chords (the chord lane, or the chords its own tracks play) in a
 * genre's feel. Pure functions on a song; the same settings and seed always write the same part.
 */

export type GenPart = 'strings' | 'violin' | 'pizz' | 'arp' | 'bass' | 'bells' | 'texture' | 'risers'
export type GenGenre = 'trap' | 'drill' | 'boombap' | 'lofi' | 'rnb' | 'pop' | 'cinematic'

/** How a generated track was made, kept on it so it can be written again in a new variation. */
export interface GenSettings {
  part: GenPart
  genre: GenGenre
  /** 1 simple .. 4 adventurous */
  complexity: number
  seed: number
  /** ticks; the part is written from `from` to `to` */
  from: number
  to: number
  /** the sustain pedal held under each chord, so short notes ring on instead of stopping dead */
  pedal?: boolean
}

export interface PartInfo {
  id: GenPart
  name: string
  hint: string
  /** whether the sustain pedal starts ticked: for parts of short notes that would otherwise sound choppy */
  pedal: boolean
  /** the General MIDI program it suggests (0-based), and what to look for in other soundfonts' preset names */
  program: number
  match: RegExp
  /** mixer level and reverb send for the new track */
  volume: number
  reverb: number
}

export const GEN_PARTS: PartInfo[] = [
  { id: 'strings', name: 'Strings pad', hint: 'sustained chords, smoothly voiced, swelling in', pedal: false, program: 48, match: /string|ensemble|orch/i, volume: 0.6, reverb: 0.5 },
  { id: 'violin', name: 'Violin line', hint: 'a counter-melody that answers the vocal', pedal: true, program: 40, match: /violin|fiddle/i, volume: 0.6, reverb: 0.45 },
  { id: 'pizz', name: 'Plucks', hint: 'short plucked chord notes in the genre’s rhythm', pedal: true, program: 45, match: /pizz|pluck/i, volume: 0.65, reverb: 0.3 },
  { id: 'arp', name: 'Arpeggio', hint: 'the chords broken into a running pattern', pedal: true, program: 46, match: /harp|arp|pluck/i, volume: 0.55, reverb: 0.35 },
  { id: 'bass', name: 'Bass / 808', hint: 'the roots, on the genre’s bass rhythm', pedal: false, program: 38, match: /808|sub|bass/i, volume: 0.75, reverb: 0 },
  { id: 'bells', name: 'Bells & sparkles', hint: 'sparse high notes on the off-beats', pedal: true, program: 9, match: /bell|glock|celest|music ?box/i, volume: 0.5, reverb: 0.55 },
  { id: 'texture', name: 'Texture', hint: 'long, airy atmosphere notes in the background', pedal: false, program: 99, match: /atmos|ambient|texture|pad/i, volume: 0.45, reverb: 0.6 },
  { id: 'risers', name: 'Risers & sweeps', hint: 'ear candy: sweeps rising into each new section', pedal: false, program: 119, match: /reverse|riser|sweep|cymbal|fx/i, volume: 0.45, reverb: 0.4 }
]

interface Genre {
  id: GenGenre
  name: string
  /** 0 straight .. 0.6, on the off-beat sixteenths, as the drum machine does it */
  swing: number
  /** timing drift, as a share of a sixteenth */
  loose: number
  /** sixteenth-step rhythms (one 4/4 bar) for plucks and bass: 'x' plays */
  pluck: string
  bass: string
  /** arpeggio notes per beat */
  arp: number
  /** bass notes ring on to the next one (808s) rather than being played short */
  hold: boolean
  vel: number
}

export const GEN_GENRES: Genre[] = [
  { id: 'trap', name: 'Trap', swing: 0, loose: 0.04, pluck: 'x00x00x000x0x000', bass: 'x000000x00x00000', arp: 4, hold: true, vel: 96 },
  { id: 'drill', name: 'Drill', swing: 0, loose: 0.04, pluck: 'x00x00x00x00x0x0', bass: 'x00000x000x00x00', arp: 3, hold: true, vel: 96 },
  { id: 'boombap', name: 'Boom bap', swing: 0.18, loose: 0.12, pluck: 'x000000x00x00000', bass: 'x00000x0x0000000', arp: 2, hold: false, vel: 90 },
  { id: 'lofi', name: 'Lo-fi', swing: 0.32, loose: 0.25, pluck: 'x0000x0000x00000', bass: 'x000000x00000000', arp: 2, hold: false, vel: 72 },
  { id: 'rnb', name: 'R&B', swing: 0.12, loose: 0.12, pluck: 'x00x000x00x0x000', bass: 'x0000x0x00x00000', arp: 4, hold: false, vel: 82 },
  { id: 'pop', name: 'Pop', swing: 0, loose: 0.05, pluck: 'x0x0x0x0x0x0x0x0', bass: 'x000x000x000x000', arp: 4, hold: false, vel: 90 },
  { id: 'cinematic', name: 'Cinematic', swing: 0, loose: 0.08, pluck: 'x000x000x000x000', bass: 'x000000000000000', arp: 4, hold: true, vel: 86 }
]

export const COMPLEXITY: { label: string; hint: string }[] = [
  { label: 'Simple', hint: 'roots and plain chords, few notes' },
  { label: 'Chord tones', hint: 'inversions and moving chord notes' },
  { label: 'Colourful', hint: 'sevenths, and steps through the scale' },
  { label: 'Adventurous', hint: 'ninths, leaps and notes leading in from outside the key' }
]

/** A guess at the song's genre: its drum machine's style, else its tempo. */
export function guessGenre(song: Song): GenGenre {
  const style = song.tracks.find((t) => t.beat?.style)?.beat?.style
  const byStyle: Record<string, GenGenre> = { lofi: 'lofi', boombap: 'boombap', trap: 'trap', ballad: 'cinematic', pop: 'pop', house: 'pop', rock: 'pop', jazz: 'rnb', reggaeton: 'pop' }
  if (style && byStyle[style]) return byStyle[style]
  const bpm = song.tempos[0]?.bpm ?? 120
  return bpm >= 130 ? 'trap' : bpm < 88 ? 'lofi' : 'rnb'
}

/** A small seeded random generator (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The pitch of a pitch class nearest a centre. */
const near = (pc: number, centre: number): number => centre + ((((pc - centre) % 12) + 18) % 12) - 6

/** A run of beats with one chord. `tones` are pitch classes, root first. */
interface Span {
  from: number
  to: number
  root: number
  tones: number[]
}

/** The chords from `from` to `to`, one span per chord, with the colour the complexity asks for. */
function spans(song: Song, from: number, to: number, complexity: number, scale: number[]): Span[] {
  // generated parts don't count towards the chords, or each new one would follow the last
  const chords = chordTimeline({ ...song, tracks: song.tracks.filter((t) => !t.gen) })
  const tpb = ticksPerBeat(song)
  const out: Span[] = []
  for (let b = Math.floor(from / tpb); b * tpb < to; b++) {
    const c = chords[Math.min(chords.length - 1, b)]
    if (!c) continue
    const lo = Math.max(from, b * tpb)
    const hi = Math.min(to, (b + 1) * tpb)
    const last = out[out.length - 1]
    if (last && last.to === lo && last.root === c[0] && last.tones[1] === c[1]) {
      last.to = hi
      continue
    }
    const tones = [...c]
    if (complexity >= 3) tones.push((c[0] + (scale.includes((c[0] + 11) % 12) && (c[1] - c[0] + 12) % 12 === 4 ? 11 : 10)) % 12)
    if (complexity >= 4) tones.push((c[0] + 2) % 12)
    out.push({ from: lo, to: hi, root: c[0], tones })
  }
  return out
}

interface Ctx {
  song: Song
  g: Genre
  complexity: number
  rnd: () => number
  scale: number[]
  step: number
  bar: number
  spans: Span[]
}

/** The span sounding at a tick. */
const spanAt = (c: Ctx, tick: number): Span | undefined => c.spans.find((s) => tick >= s.from && tick < s.to)

/** A sixteenth step's tick, swung and loosened by the genre. */
function stepTick(c: Ctx, barStart: number, s: number): number {
  const swing = s % 2 === 1 ? c.g.swing * c.step * 0.5 : 0
  const drift = (c.rnd() * 2 - 1) * c.g.loose * c.step
  return Math.max(0, Math.round(barStart + s * c.step + swing + (s ? drift : 0)))
}

const vel = (c: Ctx, base: number, spread = 10): number => Math.max(20, Math.min(127, Math.round(base + (c.rnd() * 2 - 1) * spread)))
const pattern = (p: string, s: number): boolean => p[s % p.length] === 'x'

/** Bars from `from` to `to`. */
function bars(c: Ctx, from: number, to: number): number[] {
  const out: number[] = []
  for (let b = Math.floor(from / c.bar) * c.bar; b < to; b += c.bar) out.push(b)
  return out
}

/** Chords as sustained voicings, each led smoothly from the last, swelling in on the expression pedal. */
function strings(c: Ctx, notes: Omit<Note, 'id'>[], ccs: CC[]): void {
  let prev: number[] | null = null
  for (const sp of c.spans) {
    const tones = sp.tones.slice(0, c.complexity >= 3 ? 4 : 3)
    // every inversion in close position around the middle; the one nearest the last chord wins
    let best: number[] = []
    let cost = Infinity
    for (let k = 0; k < tones.length; k++) {
      const v: number[] = []
      for (let i = 0; i < tones.length; i++) {
        const pc = tones[(k + i) % tones.length]
        let p = i ? near(pc, v[i - 1] + 6) : near(pc, 57)
        if (i && p <= v[i - 1]) p += 12
        v.push(p)
      }
      const d = prev ? v.reduce((a, p, i) => a + Math.abs(p - (prev![i] ?? prev![prev!.length - 1])), 0) : Math.abs(v[0] + v[v.length - 1] - 124)
      if (d < cost) [best, cost] = [v, d]
    }
    // the top voice an octave up from "Colourful" on, for a wider spread
    const voicing = c.complexity >= 3 ? [...best.slice(0, -1), best[best.length - 1] + 12] : best
    for (const pitch of voicing) notes.push({ pitch, tick: sp.from, dur: Math.max(c.step, sp.to - sp.from - Math.round(c.step / 4)), vel: vel(c, c.g.vel - 18, 5) })
    swell(c, ccs, sp.from, sp.to)
    prev = best
  }
}

/** The expression pedal rising over the first half of a note and settling back a little. */
function swell(c: Ctx, ccs: CC[], from: number, to: number): void {
  const len = to - from
  const n = Math.max(2, Math.min(16, Math.round(len / c.step)))
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const v = t < 0.5 ? 60 + 60 * (t / 0.5) : 120 - 20 * ((t - 0.5) / 0.5)
    ccs.push({ tick: Math.round(from + t * len * 0.98), num: 11, val: Math.round(v) })
  }
}

/** A counter-melody: phrases of two bars that answer each other, stepping through the scale and landing on chord notes. */
function violin(c: Ctx, notes: Omit<Note, 'id'>[], from: number, to: number): void {
  const rhythms = [
    [0, 8],
    [0, 6, 8, 12],
    [0, 3, 6, 8, 12, 14],
    [0, 2, 3, 6, 8, 10, 12, 14]
  ]
  let pitch = 74
  const scalePitches = Array.from({ length: 48 }, (_, i) => 60 + i).filter((p) => c.scale.includes(p % 12))
  bars(c, from, to).forEach((barStart, i) => {
    // two bars on, two off at first, leaving room for the vocal; busier lines rest only now and then
    const phrase = Math.floor(i / 2)
    if (c.complexity <= 2 ? phrase % 2 === 0 : c.rnd() < 0.2) return
    const steps = rhythms[c.complexity - 1].filter((s) => s < Math.round(c.bar / c.step))
    steps.forEach((s, k) => {
      const tick = stepTick(c, barStart, s)
      const sp = spanAt(c, tick)
      if (!sp || tick >= to) return
      const strong = s % 8 === 0
      // a step or two through the scale, held in the violin's range
      const idx = scalePitches.reduce((b, p, j) => (Math.abs(p - pitch) < Math.abs(scalePitches[b] - pitch) ? j : b), 0)
      const move = Math.round((c.rnd() * 2 - 1) * (c.complexity >= 3 ? 2 : 1)) || (pitch > 78 ? -1 : 1)
      pitch = scalePitches[Math.max(0, Math.min(scalePitches.length - 1, idx + move))]
      if (pitch < 67) pitch += 12
      if (pitch > 86) pitch -= 12
      if (strong || c.complexity <= 2) pitch = near(sp.tones.reduce((b, t) => (Math.abs(near(t, pitch) - pitch) < Math.abs(near(b, pitch) - pitch) ? t : b)), pitch)
      const next = k + 1 < steps.length ? barStart + steps[k + 1] * c.step : barStart + c.bar
      // from "Adventurous" on, some strong notes slide in from a semitone below
      if (c.complexity >= 4 && strong && c.rnd() < 0.35 && tick - c.step / 2 > from)
        notes.push({ pitch: pitch - 1, tick: Math.round(tick - c.step / 2), dur: Math.round(c.step / 2), vel: vel(c, c.g.vel - 25) })
      notes.push({ pitch, tick, dur: Math.max(c.step, Math.round((next - tick) * 0.95)), vel: vel(c, c.g.vel - (strong ? 8 : 16)) })
    })
  })
}

/** Short chord notes on the genre's rhythm, moving round the chord. */
function plucks(c: Ctx, notes: Omit<Note, 'id'>[], from: number, to: number): void {
  let k = 0
  const scale = (p: number): number => {
    for (let d = 1; d < 3; d++) if (c.scale.includes((p + d) % 12)) return p + d
    return p + 2
  }
  for (const barStart of bars(c, from, to))
    for (let s = 0; s < Math.round(c.bar / c.step); s++) {
      if (!pattern(c.g.pluck, s) && !(c.complexity >= 3 && s % 4 === 2 && c.rnd() < 0.25)) continue
      const tick = stepTick(c, barStart, s)
      const sp = spanAt(c, tick)
      if (!sp || tick < from || tick >= to) continue
      let pitch = near(sp.tones[k++ % sp.tones.length], 67)
      if (c.complexity >= 2 && c.rnd() < 0.25) pitch += 12
      if (c.complexity >= 4 && s % 2 === 1 && c.rnd() < 0.3) pitch = scale(pitch)
      notes.push({ pitch, tick, dur: Math.round(c.step * 0.8), vel: vel(c, c.g.vel - (s % 4 ? 18 : 6)) })
    }
}

/** The chord broken into a running pattern, up (and from "Chord tones" on, up and down over two octaves). */
function arp(c: Ctx, notes: Omit<Note, 'id'>[], from: number, to: number): void {
  const tpb = ticksPerBeat(c.song)
  const each = tpb / c.g.arp
  let i = 0
  for (let tick = Math.ceil(from / each) * each; tick < to; tick += each) {
    const sp = spanAt(c, tick)
    if (!sp) continue
    const up = sp.tones.map((pc) => near(pc, 64)).sort((a, b) => a - b)
    const run = c.complexity >= 2 ? [...up, ...up.map((p) => p + 12)] : up
    const cycle = c.complexity >= 2 ? [...run, ...run.slice(1, -1).reverse()] : run
    if (c.complexity >= 4 && c.rnd() < 0.12) {
      i++
      continue
    }
    const s = Math.round((tick % c.bar) / c.step)
    const swing = c.g.arp % 3 !== 0 && s % 2 === 1 ? c.g.swing * c.step * 0.5 : 0
    notes.push({ pitch: cycle[i++ % cycle.length], tick: Math.round(tick + swing), dur: Math.round(each * 0.9), vel: vel(c, c.g.vel - (tick % tpb === 0 ? 10 : 22)) })
  }
}

/** Roots on the genre's bass rhythm; fifths, octaves and notes leading into the next chord as it gets more complex. */
function bass(c: Ctx, notes: Omit<Note, 'id'>[], from: number, to: number): void {
  const hits: number[] = []
  for (const barStart of bars(c, from, to))
    for (let s = 0; s < Math.round(c.bar / c.step); s++) {
      const tick = stepTick(c, barStart, s)
      if (tick < from || tick >= to) continue
      const change = c.spans.some((sp) => sp.from === barStart + s * c.step)
      if (pattern(c.g.bass, s) || change) hits.push(tick)
    }
  hits.forEach((tick, k) => {
    const sp = spanAt(c, tick)
    if (!sp) return
    const next = hits[k + 1] ?? Math.min(to, sp.to)
    let pitch = near(sp.root, 36)
    const first = tick <= sp.from + c.step / 2
    if (!first && c.complexity >= 2 && c.rnd() < 0.3) pitch = near(sp.tones[2] ?? sp.root, pitch + 4)
    if (!first && c.complexity >= 3 && c.rnd() < 0.25) pitch += 12
    // the last hit before a chord change can lead into it, a step (or from outside the key, a semitone) away
    const after = spanAt(c, next)
    if (c.complexity >= 3 && after && after !== sp && next - tick <= c.step * 4 && c.rnd() < 0.5) {
      const target = near(after.root, 36)
      pitch = c.complexity >= 4 ? target + (pitch > target ? 1 : -1) : near(c.scale.reduce((b, pc) => (Math.abs(near(pc, target + 2) - target - 2) < Math.abs(near(b, target + 2) - target - 2) ? pc : b)), target + 2)
    }
    if (pitch > 52) pitch -= 12
    const dur = c.g.hold ?Math.max(c.step, next - tick - Math.round(c.step / 8)) : Math.min(next - tick, c.step * 3)
    notes.push({ pitch, tick, dur: Math.max(1, dur), vel: vel(c, c.g.vel + 4, 6) })
  })
}

/** A few high chord notes on the off-beats, ringing out. */
function bells(c: Ctx, notes: Omit<Note, 'id'>[], from: number, to: number): void {
  const per = [1, 2, 3, 4][c.complexity - 1]
  for (const barStart of bars(c, from, to)) {
    if (c.complexity <= 2 && Math.floor(barStart / c.bar) % 2 === 1) continue
    const used = new Set<number>()
    for (let k = 0; k < per; k++) {
      const s = [2, 3, 6, 7, 10, 11, 14, 15][Math.floor(c.rnd() * 8)]
      if (used.has(s) || s >= Math.round(c.bar / c.step)) continue
      used.add(s)
      const tick = stepTick(c, barStart, s)
      const sp = spanAt(c, tick)
      if (!sp || tick < from || tick >= to) continue
      notes.push({ pitch: near(sp.tones[Math.floor(c.rnd() * sp.tones.length)], 86), tick, dur: c.step * 4, vel: vel(c, c.g.vel - 30, 8) })
    }
  }
}

/** Long airy chord notes high up, one every two bars (every bar when busier), swelling in. */
function texture(c: Ctx, notes: Omit<Note, 'id'>[], ccs: CC[], from: number, to: number): void {
  const every = c.complexity >= 3 ? c.bar : c.bar * 2
  for (let tick = Math.floor(from / every) * every; tick < to; tick += every) {
    const at = Math.max(from, tick)
    const sp = spanAt(c, at)
    if (!sp) continue
    const end = Math.min(to, tick + every)
    const tones = c.complexity >= 3 ? sp.tones.slice(1) : sp.tones
    notes.push({ pitch: near(tones[Math.floor(c.rnd() * tones.length)], 78), tick: at, dur: Math.max(c.step, end - at - c.step), vel: vel(c, c.g.vel - 30, 6) })
    if (c.complexity >= 2) notes.push({ pitch: near(sp.root, 66), tick: at, dur: Math.max(c.step, end - at - c.step), vel: vel(c, c.g.vel - 38, 6) })
    swell(c, ccs, at, end)
  }
}

/**
 * Sweeps rising into each new part of the song: into every section when it has them, otherwise
 * every eight bars (four, from "Chord tones" on), with shorter pickups halfway through phrases
 * when busier. The expression pedal rises through each so it peaks right on the downbeat.
 */
function risers(c: Ctx, notes: Omit<Note, 'id'>[], ccs: CC[], from: number, to: number): void {
  // phrases are shorter when the stretch is too short to hold two of them, so there's always a sweep
  const phrase = c.bar * (c.complexity >= 2 || to - from <= c.bar * 8 ? 4 : 8)
  const every: number[] = []
  for (let t = (Math.floor(from / phrase) + 1) * phrase; t <= to; t += phrase) every.push(t)
  const marks = c.song.sections.length ? c.song.sections.map((s) => s.bar * c.bar) : every
  const ends: { at: number; len: number }[] = marks.filter((t) => t > from && t <= to).map((at) => ({ at, len: c.bar }))
  if (c.complexity >= 3)
    for (const b of bars(c, from, to)) if (Math.round(b / c.bar) % 4 === 2 && b > from) ends.push({ at: b, len: c.bar / 2 })
  if (c.complexity >= 4)
    for (const b of bars(c, from, to)) if (Math.round(b / c.bar) % 2 === 1 && c.rnd() < 0.3) ends.push({ at: b, len: c.bar / 4 })
  for (const { at, len } of ends) {
    const start = Math.max(from, at - len)
    if (at - start < c.step) continue
    notes.push({ pitch: 60, tick: start, dur: at - start, vel: vel(c, c.g.vel - 10, 4) })
    const n = Math.max(2, Math.round((at - start) / c.step))
    for (let i = 0; i <= n; i++) ccs.push({ tick: Math.round(start + ((at - start) * i) / n) - (i === n ? 1 : 0), num: 11, val: Math.round(20 + 107 * Math.pow(i / n, 1.6)) })
    ccs.push({ tick: at, num: 11, val: 100 })
  }
}

/**
 * The sustain pedal under each chord: pressed where it starts, lifted and pressed again a moment
 * after each change of chord (the way a pianist changes pedal with the harmony, so chords don't
 * blur), and let up where the chords stop.
 */
function pedal(c: Ctx, ccs: CC[]): void {
  const gap = Math.max(1, Math.round(c.song.ppq / 8))
  c.spans.forEach((sp, i) => {
    const joined = i > 0 && c.spans[i - 1].to === sp.from
    if (joined) ccs.push({ tick: sp.from, num: 64, val: 0 })
    ccs.push({ tick: joined ? sp.from + gap : sp.from, num: 64, val: 127 })
    if (c.spans[i + 1]?.from !== sp.to) ccs.push({ tick: sp.to, num: 64, val: 0 })
  })
}

/** Where a new part goes when there's nothing to say otherwise: the whole song, to the end of its last bar. */
export function songSpan(song: Song): { from: number; to: number } {
  const B = ticksPerBar(song)
  return { from: 0, to: Math.max(B * 4, Math.ceil(arrangeEnd({ ...song, tracks: song.tracks.filter((t) => !t.gen) }) / B) * B) }
}

/** Writes a part: its notes and controller moves (the expression pedal, for swells), in ticks. */
export function generatePart(song: Song, s: GenSettings): { notes: Note[]; ccs: CC[] } {
  const scale = scaleOf(songKey(song))
  const g = GEN_GENRES.find((x) => x.id === s.genre) ?? GEN_GENRES[0]
  const complexity = Math.max(1, Math.min(4, Math.round(s.complexity)))
  const c: Ctx = {
    song,
    g,
    complexity,
    rnd: random(s.seed),
    scale,
    step: song.ppq / 4,
    bar: ticksPerBar(song),
    spans: spans(song, s.from, s.to, complexity, scale)
  }
  const notes: Omit<Note, 'id'>[] = []
  const ccs: CC[] = []
  if (s.part === 'strings') strings(c, notes, ccs)
  else if (s.part === 'violin') violin(c, notes, s.from, s.to)
  else if (s.part === 'pizz') plucks(c, notes, s.from, s.to)
  else if (s.part === 'arp') arp(c, notes, s.from, s.to)
  else if (s.part === 'bass') bass(c, notes, s.from, s.to)
  else if (s.part === 'bells') bells(c, notes, s.from, s.to)
  else if (s.part === 'texture') texture(c, notes, ccs, s.from, s.to)
  else risers(c, notes, ccs, s.from, s.to)
  if (s.pedal && s.part !== 'risers') pedal(c, ccs)
  return {
    notes: sortNotes(notes.filter((n) => n.dur > 0 && n.pitch >= 0 && n.pitch <= 127).map((n) => ({ ...n, id: newId() }))),
    ccs: ccs.sort((a, b) => a.tick - b.tick)
  }
}

import { stepsPerBar, type Beat, type Pattern } from './beat'
import { DRUM_CHANNEL, newId, songEndTick, ticksPerBar, type Song } from './song'

const KICK = 36
const RIM = 37
const SNARE = 38
const CLAP = 39
const HAT = 42
const LOW_TOM = 45
const OPEN_HAT = 46
const CRASH = 49
const HIGH_TOM = 50
const RIDE = 51

/**
 * A style is a starting groove over one 4/4 bar of sixteenths. Each lane is a string of 16 steps:
 * 'x' always plays, a digit 1-9 plays with that chance in tenths, 0 is silent.
 */
interface Style {
  id: string
  name: string
  bpm: number
  swing: number
  lanes: Partial<Record<number, string>>
  /** loudest velocity per lane */
  vel: Partial<Record<number, number>>
  fill: 'snare' | 'toms' | 'rolls' | 'none'
  /** how strongly kicks move to where the piano's bass notes fall */
  follow: number
  crashOnOne: boolean
}

export const STYLES: Style[] = [
  { id: 'lofi', name: 'Lo-fi', bpm: 82, swing: 0.32, follow: 0.8, fill: 'snare', crashOnOne: false,
    lanes: { [KICK]: 'x000003x00x00000', [SNARE]: '0000x0000000x000', [HAT]: 'x2x2x2x2x2x2x2x3', [RIM]: '0000000200000020' },
    vel: { [KICK]: 100, [SNARE]: 88, [HAT]: 58, [RIM]: 45 } },
  { id: 'boombap', name: 'Boom bap', bpm: 90, swing: 0.18, follow: 0.7, fill: 'snare', crashOnOne: false,
    lanes: { [KICK]: 'x00000x0x0300000', [SNARE]: '0000x0000000x002', [HAT]: 'x0x0x0x0x0x0x0x0', [OPEN_HAT]: '00000000000000x0' },
    vel: { [KICK]: 112, [SNARE]: 105, [HAT]: 70, [OPEN_HAT]: 60 } },
  { id: 'trap', name: 'Trap', bpm: 140, swing: 0, follow: 0.6, fill: 'rolls', crashOnOne: false,
    lanes: { [KICK]: 'x000000x00x00030', [SNARE]: '00000000x0000000', [CLAP]: '00000000x0000000', [HAT]: 'x0x0x0x0x0x0x0x0', [OPEN_HAT]: '0000000000000020' },
    vel: { [KICK]: 120, [SNARE]: 108, [CLAP]: 95, [HAT]: 72, [OPEN_HAT]: 64 } },
  { id: 'ballad', name: 'Ballad', bpm: 70, swing: 0.08, follow: 0.9, fill: 'toms', crashOnOne: false,
    lanes: { [KICK]: 'x0000000x0300000', [RIM]: '0000x0000000x000', [HAT]: 'x0x0x0x0x0x0x0x0' },
    vel: { [KICK]: 85, [RIM]: 70, [HAT]: 48 } },
  { id: 'pop', name: 'Pop', bpm: 110, swing: 0, follow: 0.5, fill: 'snare', crashOnOne: true,
    lanes: { [KICK]: 'x0000000x0x00000', [SNARE]: '0000x0000000x000', [CLAP]: '0000x0000000x000', [HAT]: 'x0x0x0x0x0x0x0x0' },
    vel: { [KICK]: 110, [SNARE]: 100, [CLAP]: 70, [HAT]: 66 } },
  { id: 'house', name: 'House', bpm: 124, swing: 0.05, follow: 0.1, fill: 'snare', crashOnOne: true,
    lanes: { [KICK]: 'x000x000x000x000', [CLAP]: '0000x0000000x000', [OPEN_HAT]: '00x000x000x000x0', [HAT]: '0303030303030303' },
    vel: { [KICK]: 118, [CLAP]: 96, [OPEN_HAT]: 72, [HAT]: 50 } },
  { id: 'rock', name: 'Rock', bpm: 116, swing: 0, follow: 0.4, fill: 'toms', crashOnOne: true,
    lanes: { [KICK]: 'x0000000x0x00000', [SNARE]: '0000x0000000x000', [HAT]: 'x0x0x0x0x0x0x0x0' },
    vel: { [KICK]: 118, [SNARE]: 115, [HAT]: 80 } },
  { id: 'jazz', name: 'Jazz', bpm: 120, swing: 0.6, follow: 0.3, fill: 'snare', crashOnOne: false,
    lanes: { [RIDE]: 'x000x0x0x000x0x0', [HAT]: '0000x0000000x000', [KICK]: '3000200030002000', [SNARE]: '0001000100100001' },
    vel: { [RIDE]: 72, [HAT]: 55, [KICK]: 42, [SNARE]: 38 } },
  { id: 'reggaeton', name: 'Reggaeton', bpm: 94, swing: 0, follow: 0.2, fill: 'snare', crashOnOne: true,
    lanes: { [KICK]: 'x000x000x000x000', [SNARE]: '000x00x0000x00x0', [HAT]: 'x0x0x0x0x0x0x0x0' },
    vel: { [KICK]: 115, [SNARE]: 98, [HAT]: 60 } },
  { id: 'cinematic', name: 'Cinematic (orchestral)', bpm: 84, swing: 0, follow: 0.8, fill: 'toms', crashOnOne: true,
    lanes: { [KICK]: 'x0000000x0000000', [LOW_TOM]: 'x00000x000x00000', [HIGH_TOM]: '0000000000000303' },
    vel: { [KICK]: 105, [LOW_TOM]: 95, [HIGH_TOM]: 70 } }
]

/** Small seeded random generator, so one seed always gives the same beat. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface BarFeel {
  /** sixteenth steps where a bass note starts */
  bass: boolean[]
  /** notes started in the bar, all pitched tracks */
  density: number
}

/** What the existing music does in each bar: where the bass lands and how busy it is. */
function analyse(song: Song, bars: number): BarFeel[] {
  const bar = ticksPerBar(song)
  const steps = stepsPerBar(song)
  const feel: BarFeel[] = Array.from({ length: bars }, () => ({ bass: new Array(steps).fill(false), density: 0 }))
  const pitched = song.tracks.filter((t) => t.channel !== DRUM_CHANNEL && !t.beat && t.notes.length)
  for (const t of pitched)
    for (const n of t.notes) {
      const b = Math.floor(n.tick / bar)
      if (b >= bars) continue
      feel[b].density++
      // a bass note: low, or the lowest note sounding at its start
      if (n.pitch < 55) feel[b].bass[Math.round(((n.tick % bar) / bar) * steps) % steps] = true
    }
  return feel
}

const lane = (row: string, steps: number): number[] => {
  const out: number[] = []
  for (let s = 0; s < steps; s++) {
    const c = row[s % 16]
    out.push(c === 'x' ? 1 : c === '0' || c === undefined ? 0 : Number(c) / 10)
  }
  return out
}

function groove(style: Style, steps: number, bass: boolean[] | null, density: number, rand: () => number): Record<number, number[]> {
  const hits: Record<number, number[]> = {}
  const busy = Math.max(0.35, Math.min(1.5, density / 8))
  for (const [p, row] of Object.entries(style.lanes)) {
    const pitch = Number(p)
    const chance = lane(row!, steps)
    const top = style.vel[pitch] ?? 90
    hits[pitch] = chance.map((c, s) => {
      let pr = c
      if (pitch === KICK && bass) {
        // kicks lean toward the bass notes; the downbeat stays
        if (bass[s]) pr = Math.max(pr, 0.85 * style.follow)
        else if (s !== 0 && c < 1) pr *= 1 - 0.6 * style.follow
      }
      // ghost notes thin out in sparse bars and fill in busy ones
      if (c > 0 && c < 1) pr *= busy
      if (rand() >= pr) return 0
      const accent = s % 4 === 0 ? 1 : s % 2 === 0 ? 0.9 : 0.75
      const vel = top * accent * (c < 1 ? 0.7 : 1) + (rand() - 0.5) * 12
      return Math.round(Math.max(20, Math.min(127, vel)))
    })
  }
  return hits
}

function addFill(hits: Record<number, number[]>, style: Style, steps: number, rand: () => number): void {
  const from = steps - 4
  const set = (pitch: number, s: number, vel: number): void => {
    hits[pitch] ??= new Array(steps).fill(0)
    hits[pitch][s] = Math.round(vel)
  }
  // clear the last beat's snares and toms, then play the fill over it
  for (const p of [SNARE, LOW_TOM, HIGH_TOM]) if (hits[p]) for (let s = from; s < steps; s++) hits[p][s] = 0
  for (let s = from; s < steps; s++) {
    const rise = 70 + ((s - from) / 3) * 45
    if (style.fill === 'snare') set(SNARE, s, rise)
    else if (style.fill === 'toms') set(s < from + 2 ? HIGH_TOM : LOW_TOM, s, rise)
    else if (style.fill === 'rolls' && hits[HAT]) set(HAT, s, 55 + rand() * 40)
  }
}

/**
 * Writes an original beat in a style that fits the song: one groove per distinct bass rhythm,
 * fills at the end of each four-bar phrase, crashes into new phrases and sections, and only hats
 * where the music drops out. The same seed always gives the same beat.
 */
export function generateBeat(song: Song, styleId: string, seed: number): Beat {
  const style = STYLES.find((s) => s.id === styleId) ?? STYLES[0]
  const rand = rng(seed)
  const steps = stepsPerBar(song)
  const used = Math.ceil(songEndTick(song) / ticksPerBar(song))
  const bars = Math.max(8, Math.ceil(used / 4) * 4)
  const feel = analyse(song, bars)

  // group bars by their bass rhythm; the most common few get their own groove
  const sig = (f: BarFeel): string => f.bass.map((b) => (b ? 1 : 0)).join('')
  const counts = new Map<string, number>()
  for (const f of feel) if (f.density) counts.set(sig(f), (counts.get(sig(f)) ?? 0) + 1)
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s]) => s)
  const hamming = (a: string, b: string): number => [...a].reduce((n, c, i) => n + (c === b[i] ? 0 : 1), 0)
  const groupOf = (f: BarFeel): number => {
    if (!common.length) return 0
    const s = sig(f)
    let best = 0
    common.forEach((c, i) => (hamming(c, s) < hamming(common[best], s) ? (best = i) : 0))
    return best
  }
  const meanDensity = (g: number): number => {
    const fs = feel.filter((f) => f.density && groupOf(f) === g)
    return fs.length ? fs.reduce((a, f) => a + f.density, 0) / fs.length : 8
  }

  const patterns: Pattern[] = []
  const cache = new Map<string, number>()
  const letters = 'ABC'
  const patternFor = (g: number, kind: 'groove' | 'fill' | 'crash' | 'break'): number => {
    const id = `${g}|${kind}`
    const hit = cache.get(id)
    if (hit !== undefined) return hit
    const bass = common[g] ? [...common[g]].map((c) => c === '1') : null
    const hits = groove(style, steps, kind === 'break' ? null : bass, kind === 'break' ? 4 : meanDensity(g), rand)
    if (kind === 'fill') addFill(hits, style, steps, rand)
    if (kind === 'crash') {
      hits[CRASH] = new Array(steps).fill(0)
      hits[CRASH][0] = 100
    }
    if (kind === 'break') for (const p of [KICK, SNARE, CLAP, LOW_TOM, HIGH_TOM]) if (hits[p]) hits[p].fill(0)
    const name = kind === 'break' ? 'Breakdown' : `Groove ${letters[g]}${kind === 'groove' ? '' : kind === 'fill' ? ' · fill' : ' · crash'}`
    const p: Pattern = { id: newId(), name, hits }
    patterns.push(p)
    cache.set(id, p.id)
    return p.id
  }

  const sectionBars = new Set(song.sections.map((s) => s.bar))
  const anyMusic = feel.some((f) => f.density)
  const out: (number | null)[] = []
  for (let b = 0; b < bars; b++) {
    const f = feel[b]
    const g = groupOf(f)
    const silent = anyMusic && !f.density && b < used
    if (silent) out.push(patternFor(g, 'break'))
    else if (style.fill !== 'none' && b % 4 === 3) out.push(patternFor(g, 'fill'))
    else if (sectionBars.has(b) || (b > 0 && b % 8 === 0) || (b === 0 && style.crashOnOne)) out.push(patternFor(g, 'crash'))
    else out.push(patternFor(g, 'groove'))
  }
  return { patterns, bars: out, swing: style.swing, style: style.id }
}

/** A single starter pattern for a style, without following the song. */
export function starterPattern(song: Song, styleId: string, seed: number): Pattern {
  const style = STYLES.find((s) => s.id === styleId) ?? STYLES[0]
  return { id: newId(), name: style.name, hits: groove(style, stepsPerBar(song), null, 8, rng(seed)) }
}

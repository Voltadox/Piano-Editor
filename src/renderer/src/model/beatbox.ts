import { BAND_RATE, bandHz, bandSpectrogram, BANDS, findOnsets, FPS, HOP, ONSET_LAG, type Hit } from './remake'

/**
 * A beatboxed take turned into drum hits. Every sound made into the mic is found (a sharp rise
 * across the spectrum), described by where its energy sits (how high it is overall, how much is
 * low down) and grouped with the sounds most like it: a beatboxer's kick, snare and hat each come
 * out much alike every time, but nothing like another person's. The groups are then named from
 * low to high: a "b" kick is the lowest, a "pf"/"k" snare is in the middle, a "ts" hat the highest.
 * Pure functions, on mono audio at BAND_RATE.
 */

export const BEATBOX_DRUMS = { kick: 36, snare: 38, hat: 42, openHat: 46 } as const

interface Sound {
  /** seconds into the take */
  time: number
  /** where its energy sits: mean log2 frequency */
  pitch: number
  /** share of its energy below 300 Hz */
  low: number
  /** how loud it is (energy as it's struck) */
  energy: number
  /** how long the highs ring on, seconds */
  ring: number
}

const LOW_HZ = 300
const HIGH_HZ = 3000
/** frames after the onset that count as the strike (about 70 ms) */
const STRIKE = 6

/** Every sound in the take, with what it's like. */
function sounds(x: Float32Array): Sound[] {
  const S = bandSpectrogram(x).map((f) => f.map(Math.sqrt))
  const T = S.length
  if (T < 8) return []
  const hz = Array.from({ length: BANDS }, (_, b) => bandHz(b))
  const out: Sound[] = []
  for (const t of findOnsets(S, 0.02)) {
    // what the strike adds over what was sounding just before it, band by band
    const before = S[Math.max(0, t - 2)]
    let total = 0
    let low = 0
    let pitch = 0
    for (let b = 0; b < BANDS; b++) {
      let e = 0
      for (let k = t; k < Math.min(T, t + STRIKE); k++) e += Math.max(0, S[k][b] ** 2 - before[b] ** 2)
      total += e
      pitch += e * Math.log2(hz[b])
      if (hz[b] < LOW_HZ) low += e
    }
    if (total <= 0) continue
    // the highs: how long they stay above a third of their peak
    const highs = (k: number): number => {
      let s = 0
      for (let b = 0; b < BANDS; b++) if (hz[b] >= HIGH_HZ) s += S[Math.min(T - 1, k)][b]
      return s
    }
    let peak = 0
    for (let k = t; k < Math.min(T, t + 3); k++) peak = Math.max(peak, highs(k))
    let end = t + 1
    while (end < T && end - t < FPS && highs(end) > peak / 3) end++
    out.push({ time: strikeTime(x, t), pitch: pitch / total, low: low / total, energy: total, ring: (end - t) / FPS })
  }
  // breaths, lip smacks and the song leaking into the mic are much quieter than the beat
  const loud = [...out.map((s) => s.energy)].sort((a, b) => a - b)[Math.floor(out.length * 0.9)] ?? 0
  return out.filter((s) => s.energy >= loud * 0.005)
}

/**
 * When a sound really starts: the onset curve only finds the frame, so the waveform is searched
 * near it for where the sound first rises toward its peak.
 */
function strikeTime(x: Float32Array, frame: number): number {
  const centre = frame * HOP + Math.round(ONSET_LAG * BAND_RATE)
  const from = Math.max(0, centre - 1200)
  const to = Math.min(x.length, centre + 1200)
  // envelope smoothed over about 1.5 ms
  const W = 32
  const env = new Float32Array(Math.max(0, to - from))
  let run = 0
  for (let i = from; i < to; i++) {
    run += Math.abs(x[i]) - (i - W >= from ? Math.abs(x[i - W]) : 0)
    env[i - from] = run / W
  }
  let top = 0
  for (let i = 0; i < env.length; i++) if (env[i] > env[top]) top = i
  if (!env.length || env[top] <= 0) return centre / BAND_RATE
  let i = top
  while (i > 0 && env[i - 1] > env[top] * 0.2) i--
  // the envelope trails the waveform by half its width
  return Math.max(0, from + i - W / 2) / BAND_RATE
}

type Point = [number, number]
/** pitch in octaves, and the low share scaled so a big low end counts about an octave */
const point = (s: Sound): Point => [s.pitch, s.low * 3]
const dist = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1])

/** k-means from given starting centres; returns each sound's group and the groups' centres. */
function kmeans(points: Point[], centres: Point[]): { groups: number[]; centres: Point[] } {
  let c = centres.map((p) => [...p] as Point)
  let groups = points.map(() => 0)
  for (let it = 0; it < 30; it++) {
    groups = points.map((p) => c.reduce((best, q, k) => (dist(p, q) < dist(p, c[best]) ? k : best), 0))
    const next = c.map((q, k) => {
      const mine = points.filter((_, i) => groups[i] === k)
      return mine.length ? ([mine.reduce((s, p) => s + p[0], 0) / mine.length, mine.reduce((s, p) => s + p[1], 0) / mine.length] as Point) : q
    })
    if (next.every((q, k) => dist(q, c[k]) < 1e-6)) break
    c = next
  }
  return { groups, centres: c }
}

/** How many kinds of sound there are (1 to 3), and which each sound is, lowest kind first. */
function group(points: Point[]): { groups: number[]; centres: Point[] } {
  const by = [...points].sort((a, b) => a[0] - b[0])
  const at = (q: number): Point => by[Math.min(by.length - 1, Math.floor(q * by.length))]
  const enough = (r: { groups: number[] }, k: number): boolean => r.groups.filter((g) => g === k).length >= Math.max(2, points.length * 0.04)
  // groups count as different sounds when they're at least this far apart (about half an octave)
  const apart = (r: { centres: Point[] }): boolean => r.centres.every((p, i) => r.centres.every((q, j) => i === j || dist(p, q) >= 0.55))
  for (const qs of [[0.1, 0.5, 0.9], [0.25, 0.75]]) {
    if (points.length < qs.length * 2) continue
    const r = kmeans(points, qs.map(at))
    if (qs.every((_, k) => enough(r, k)) && apart(r)) {
      // lowest first
      const order = r.centres.map((_, k) => k).sort((a, b) => r.centres[a][0] - r.centres[b][0])
      return { groups: r.groups.map((g) => order.indexOf(g)), centres: order.map((k) => r.centres[k]) }
    }
  }
  const mean: Point = [points.reduce((s, p) => s + p[0], 0) / points.length, points.reduce((s, p) => s + p[1], 0) / points.length]
  return { groups: points.map(() => 0), centres: [mean] }
}

/** What a sound is on its own, by where its energy sits: for naming groups. */
function nameOf(c: Point): 'kick' | 'snare' | 'hat' {
  if (c[0] < Math.log2(700) || c[1] > 0.3 * 3) return 'kick'
  return c[0] > Math.log2(3800) ? 'hat' : 'snare'
}

/** Names groups from low to high; with fewer than three, each is named by its own sound. */
function names(centres: Point[]): ('kick' | 'snare' | 'hat')[] {
  if (centres.length === 3) return ['kick', 'snare', 'hat']
  if (centres.length === 1) return [nameOf(centres[0])]
  // two groups are two different drums
  const lo = nameOf(centres[0])
  const hi = nameOf(centres[1])
  if (lo === 'kick') return ['kick', hi === 'kick' ? 'snare' : hi]
  // a hat is unmistakably high; two sounds below that are a kick (on a mic thin in the lows) and a snare
  if (hi !== 'hat') return ['kick', 'snare']
  return ['snare', 'hat']
}

/** Drum hits from a beatboxed take (mono, BAND_RATE), times in seconds into the take. */
export function transcribeBeatbox(x: Float32Array): Hit[] {
  // a take often starts right on a kick: lead in with silence so a hit at the very start is found
  const pad = Math.round(BAND_RATE * 0.1)
  const padded = new Float32Array(x.length + pad)
  padded.set(x, pad)
  const found = sounds(padded).map((s) => ({ ...s, time: Math.max(0, s.time - pad / BAND_RATE) }))
  if (!found.length) return []
  const { groups, centres } = group(found.map(point))
  const named = names(centres)
  const drum = groups.map((g) => named[g])
  // each drum's loudness against its own loud hits: a hat is never as loud as a kick
  const tops = new Map<string, number>()
  for (const d of new Set(drum)) {
    const e = found.filter((_, i) => drum[i] === d).map((s) => s.energy).sort((a, b) => a - b)
    tops.set(d, e[Math.floor(e.length * 0.9)] || 1)
  }
  return found
    .map((s, i) => {
      const d = drum[i]
      const note = d === 'kick' ? BEATBOX_DRUMS.kick : d === 'snare' ? BEATBOX_DRUMS.snare : s.ring > 0.16 ? BEATBOX_DRUMS.openHat : BEATBOX_DRUMS.hat
      const vel = Math.round(Math.max(40, Math.min(127, 40 + 87 * Math.sqrt(Math.min(1, s.energy / tops.get(d)!)))))
      return { time: s.time, note, vel }
    })
    .sort((a, b) => a.time - b.time)
}

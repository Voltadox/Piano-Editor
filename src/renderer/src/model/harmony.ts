/** Key detection, chord naming and chord suggestions for Studio mode. Pure functions, no state. */

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

export interface Key {
  tonic: number
  minor: boolean
  /** 0..1, how clearly the notes point at this key */
  confidence: number
}

export const keyName = (k: Key): string => `${NAMES[k.tonic]} ${k.minor ? 'minor' : 'major'}`

// Krumhansl–Kessler key profiles
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

function correlate(x: number[], y: number[]): number {
  const mx = x.reduce((a, b) => a + b, 0) / 12
  const my = y.reduce((a, b) => a + b, 0) / 12
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < 12; i++) {
    num += (x[i] - mx) * (y[i] - my)
    dx += (x[i] - mx) ** 2
    dy += (y[i] - my) ** 2
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0
}

/** Best-fitting key for a pitch-class weight histogram, or null with too little to go on. */
export function detectKey(weights: number[]): Key | null {
  if (weights.filter((w) => w > 0).length < 3) return null
  let best: Key | null = null
  let bestR = -Infinity
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const minor of [false, true]) {
      const prof = minor ? MINOR : MAJOR
      const rotated = prof.map((_, i) => prof[(i - tonic + 12) % 12])
      const r = correlate(weights, rotated)
      if (r > bestR) {
        bestR = r
        best = { tonic, minor, confidence: 0 }
      }
    }
  }
  if (!best) return null
  best.confidence = Math.max(0, Math.min(1, bestR))
  return best
}

// ---------- chords ----------

interface Quality {
  suffix: string
  intervals: number[]
}

const QUALITIES: Quality[] = [
  { suffix: '', intervals: [0, 4, 7] },
  { suffix: 'm', intervals: [0, 3, 7] },
  { suffix: 'dim', intervals: [0, 3, 6] },
  { suffix: 'aug', intervals: [0, 4, 8] },
  { suffix: 'sus2', intervals: [0, 2, 7] },
  { suffix: 'sus4', intervals: [0, 5, 7] },
  { suffix: '7', intervals: [0, 4, 7, 10] },
  { suffix: 'maj7', intervals: [0, 4, 7, 11] },
  { suffix: 'm7', intervals: [0, 3, 7, 10] },
  { suffix: 'm7b5', intervals: [0, 3, 6, 10] },
  { suffix: 'dim7', intervals: [0, 3, 6, 9] },
  { suffix: '6', intervals: [0, 4, 7, 9] },
  { suffix: 'm6', intervals: [0, 3, 7, 9] },
  { suffix: 'add9', intervals: [0, 2, 4, 7] }
]

export interface Chord {
  root: number
  quality: string
  name: string
  /** pitch classes */
  pcs: number[]
}

const makeChord = (root: number, q: Quality): Chord => ({
  root,
  quality: q.suffix,
  name: NAMES[root] + q.suffix,
  pcs: q.intervals.map((i) => (root + i) % 12)
})

/** Names the chord formed by held pitches (MIDI numbers); needs at least three distinct pitch classes. */
export function recognizeChord(pitches: number[]): Chord | null {
  const pcs = [...new Set(pitches.map((p) => p % 12))]
  if (pcs.length < 3) return null
  const bass = Math.min(...pitches) % 12
  let best: { chord: Chord; score: number } | null = null
  for (let root = 0; root < 12; root++) {
    for (const q of QUALITIES) {
      const tones = q.intervals.map((i) => (root + i) % 12)
      const hit = pcs.filter((pc) => tones.includes(pc)).length
      const extra = pcs.length - hit
      const missing = tones.length - hit
      // every chord tone matters; a root in the bass and simpler chords break ties
      const score = hit * 2 - extra * 3 - missing * 2.5 + (root === bass ? 0.75 : 0) - q.intervals.length * 0.1
      if (!best || score > best.score) best = { chord: makeChord(root, q), score }
    }
  }
  return best && best.score > 2 ? best.chord : null
}

// ---------- suggestions ----------

export interface Suggestion {
  chord: Chord
  /** roman numeral in the detected key */
  numeral: string
  /** a playable root-position voicing */
  pitches: number[]
  why: string
}

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]
const MAJOR_NUMERALS = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°']
const MINOR_NUMERALS = ['i', 'ii°', 'III', 'iv', 'V', 'VI', 'VII']

/** Triads built on each scale degree; minor keys use the harmonic-minor V for a stronger pull home. */
function diatonic(key: Key): { chord: Chord; numeral: string; degree: number }[] {
  const scale = key.minor ? MINOR_SCALE : MAJOR_SCALE
  return scale.map((step, degree) => {
    const root = (key.tonic + step) % 12
    const third = (key.tonic + scale[(degree + 2) % 7]) % 12
    const fifth = (key.tonic + scale[(degree + 4) % 7]) % 12
    const thirdInt = key.minor && degree === 4 ? 4 : (third - root + 12) % 12
    const fifthInt = (fifth - root + 12) % 12
    const q = QUALITIES.find((x) => x.intervals[1] === thirdInt && x.intervals[2] === fifthInt && x.intervals.length === 3)!
    return { chord: makeChord(root, q), numeral: (key.minor ? MINOR_NUMERALS : MAJOR_NUMERALS)[degree], degree }
  })
}

/** Where each degree likes to go next, strongest first (common-practice and pop progressions). */
const NEXT: Record<number, number[]> = {
  0: [3, 4, 5, 1],
  1: [4, 6, 3, 0],
  2: [5, 3, 1],
  3: [4, 0, 1, 5],
  4: [0, 5, 3],
  5: [3, 1, 4, 2],
  6: [0, 2]
}

const ROLE = ['home', 'leads to V', 'leads to vi', 'moves away from home', 'pulls back home', 'relative chord', 'pulls to I']

function voice(chord: Chord, near: number): number[] {
  // root position with the root as close as possible to `near`
  let root = chord.root + 12 * Math.round((near - chord.root) / 12)
  if (root < 36) root += 12
  return chord.pcs.map((pc) => {
    let p = root + ((pc - chord.root + 12) % 12)
    if (p < root) p += 12
    return p
  })
}

/**
 * Chords that fit what is being played. A held chord gets the progressions that usually follow it;
 * held single notes get the chords in the key that contain them.
 */
export function suggestChords(key: Key | null, held: number[], current: Chord | null, register: number): Suggestion[] {
  if (!key) return []
  const chords = diatonic(key)
  const near = Math.min(55, Math.max(43, register - 12))
  const pick = (degrees: number[], why: (d: number) => string): Suggestion[] =>
    degrees.slice(0, 4).map((d) => ({ chord: chords[d].chord, numeral: chords[d].numeral, pitches: voice(chords[d].chord, near), why: why(d) }))

  if (current) {
    const here = chords.find((c) => c.chord.root === current.root)
    if (here) return pick(NEXT[here.degree], (d) => ROLE[d])
    // a chord from outside the key: offer the chords that share the most notes with it
    const ranked = chords
      .map((c) => ({ c, shared: c.chord.pcs.filter((pc) => current.pcs.includes(pc)).length }))
      .sort((a, b) => b.shared - a.shared || a.c.degree - b.c.degree)
    return pick(ranked.map((r) => r.c.degree), () => 'shares notes')
  }

  const melody = [...new Set(held.map((p) => p % 12))]
  if (!melody.length) return pick([0, 3, 4, 5], (d) => ROLE[d])
  // chords containing the held notes, favouring the home, four and five chords
  const weight = [3, 1, 0.5, 2, 2.5, 1.5, 0.2]
  const ranked = chords
    .map((c) => ({ c, fit: melody.filter((pc) => c.chord.pcs.includes(pc)).length }))
    .filter((r) => r.fit > 0)
    .sort((a, b) => b.fit - a.fit || weight[b.c.degree] - weight[a.c.degree])
  return pick(ranked.map((r) => r.c.degree), () => 'fits your note')
}

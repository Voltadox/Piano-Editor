/**
 * Voice pitch detection (YIN), finding the notes in it, autotune targets, and pitch/formant
 * shifting (TD-PSOLA) for recorded takes. Pure functions on PCM, run inside the tune worker.
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
    let deepest = tauMin
    for (let t = tauMin; t <= tauMax; t++) {
      if (d[t] < 0.15) {
        while (t + 1 <= tauMax && d[t + 1] < d[t]) t++
        tau = t
        break
      }
      if (d[t] < d[deepest]) deepest = t
    }
    if (tau < 0 && d[deepest] < 0.25) {
      // breathy or soft singing never dips that far: take the deepest dip while it's still clearly
      // periodic, preferring a shorter period that dips nearly as deep (the deepest is often two periods)
      tau = deepest
      for (const div of [3, 2]) {
        let c = Math.round(deepest / div)
        if (c - 1 < tauMin) continue
        while (c > tauMin && d[c - 1] < d[c]) c--
        while (c < tauMax && d[c + 1] < d[c]) c++
        if (d[c] < d[deepest] + 0.06) {
          tau = c
          break
        }
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

/**
 * Removes one-frame blips and octave jumps that detection makes on breathy or mumbled sounds,
 * and bridges dropouts of up to 40 ms inside a held note, so the note isn't left untuned there.
 */
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
  for (let i = 1; i < out.length; i++) {
    if (out[i] || !out[i - 1]) continue
    let j = i
    while (j < out.length && !out[j]) j++
    const a = out[i - 1]
    if (j < out.length && j - i <= 4 && Math.abs(12 * Math.log2(out[j] / a)) < 1.5)
      for (let k = i; k < j; k++) out[k] = a * Math.pow(out[j] / a, (k - i + 1) / (j - i + 1))
    i = j
  }
  return out
}

/**
 * Splits a pitch track (MIDI per frame, NaN where unvoiced) into the notes sung. A note runs
 * while the voice stays near one pitch: a move of more than ¾ of a semitone that lasts 40 ms starts
 * the next one. Slow drift is followed, so vibrato and scoops stay one note, until the voice has
 * wandered 1½ semitones from where the note settled (a slow slide to another note).
 */
export function segmentNotes(midi: ArrayLike<number>): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  const n = midi.length
  let i = 0
  while (i < n) {
    if (Number.isNaN(midi[i])) {
      i++
      continue
    }
    const start = i
    let centre = midi[i]
    let settled = NaN
    let away = 0
    let j = i + 1
    for (; j < n && !Number.isNaN(midi[j]); j++) {
      if (Math.abs(midi[j] - centre) > 0.75 || Math.abs(midi[j] - settled) > 1.5) {
        if (++away >= 4) {
          j -= away - 1
          break
        }
      } else {
        away = 0
        centre += (midi[j] - centre) * 0.1
        if (j - start === 12) settled = centre
      }
    }
    out.push({ start, end: j })
    i = Math.max(j, start + 1)
  }
  return out
}

/** A hand edit to one sung note. */
export interface TuneEdit {
  /** seconds into the take: the edit belongs to the note sung at this moment */
  at: number
  /** where the note lands (MIDI; a fraction bends it between keys), or null to leave it as sung */
  pitch: number | null
}

/** A note found in a take, and where autotune puts it. */
export interface TunedNote {
  /** frames into the take */
  start: number
  end: number
  /** the pitch sung, from the middle of the note (MIDI) */
  sung: number
  /** where it lands; NaN when it's left as sung */
  target: number
  /** moved or released by hand */
  edited: boolean
}

export interface TuneSettings {
  mode: 'off' | 'key' | 'guide'
  /** 0 natural (keeps vibrato and slides, centres each note) .. 1 hard (flat, stepped) */
  speed: number
  /** pitch classes notes are allowed to land on */
  scale: number[]
  /** guide target per frame (MIDI pitch, NaN where there is none), lined up with the take */
  guide?: Float32Array
  /** hand edits, which win over the mode */
  edits?: TuneEdit[]
  transpose: number
  detune: number
  formant: number
}

/** Runs shorter than this (frames) are glides between notes and go with the touching note nearest in pitch. */
const MIN_NOTE = 6

/**
 * Where the guide moves to another note inside one sung note (the singer moved too little for
 * the pitch alone to show it, say half a semitone between neighbouring notes), cuts it in two:
 * at the frame within 80 ms of the guide's change where the voice rises or falls the most.
 */
function splitAtGuide(g: { start: number; end: number }, midi: number[], guide: ArrayLike<number>, minMove = 0): { start: number; end: number }[] {
  const same = (a: number, b: number): boolean => a === b || (Number.isNaN(a) && Number.isNaN(b))
  for (let i = g.start + 10; i <= g.end - 10; i++) {
    const before = guide[i - 1]
    const after = guide[i]
    if (Number.isNaN(before) || Number.isNaN(after) || same(before, after)) continue
    // both sides must hold their note for 100 ms
    let steady = true
    for (let k = i - 10; k < i + 10 && steady; k++) steady = same(guide[k], k < i ? before : after)
    if (!steady) continue
    if (minMove > 0) {
      // the voice itself has to have moved: the average pitch either side differs enough
      let a = 0
      let b = 0
      for (let k = 0; k < 10; k++) [a, b] = [a + midi[i - 1 - k], b + midi[i + k]]
      if (Math.abs(b - a) / 10 < minMove) continue
    }
    const dir = Math.sign(after - before)
    let cut = i
    let most = -Infinity
    for (let k = Math.max(g.start + 3, i - 8); k <= Math.min(g.end - 3, i + 8); k++) {
      const rise = (midi[k + 2] - midi[k - 2]) * dir
      if (rise > most) [most, cut] = [rise, k]
    }
    return [{ start: g.start, end: cut }, ...splitAtGuide({ start: cut, end: g.end }, midi, guide, minMove)]
  }
  return [g]
}

/**
 * The notes in a take and the one pitch each should land on. Choosing per note rather than per
 * moment means a note isn't pulled somewhere else halfway through because the guide changed a
 * little before or after the singer did.
 */
export function tuneNotes(f0: Float32Array, s: TuneSettings): TunedNote[] {
  const midi = Array.from(f0, (f) => (f > 0 ? hzToMidi(f) : NaN))
  // the middle 60% of a note, so a scoop into it or a fall off the end doesn't count
  const middle = (a: number, b: number): number => {
    const trim = Math.floor((b - a) * 0.2)
    const v = midi.slice(a + trim, b - trim).sort((x, y) => x - y)
    return v[v.length >> 1]
  }
  let segs = segmentNotes(midi)
  const inScale = (m: number): boolean => s.scale.includes(((m % 12) + 12) % 12)
  const nearestInScale = (m: number): number => {
    let best = Math.round(m)
    for (let c = best - 6; c <= best + 6; c++) if (inScale(c) && (!inScale(best) || Math.abs(c - m) < Math.abs(best - m))) best = c
    return best
  }
  if (s.mode === 'guide' && s.guide) segs = segs.flatMap((g) => splitAtGuide(g, midi, s.guide!))
  else if (s.mode === 'key') {
    // the same for two neighbouring notes of the key sung less than ¾ of a semitone apart, with
    // the nearest note of the key (of a 50 ms median) standing in for the guide
    const near = midi.map((_, i) => {
      const v = midi.slice(Math.max(0, i - 2), i + 3).filter((m) => !Number.isNaN(m)).sort((a, b) => a - b)
      return v.length ? nearestInScale(v[v.length >> 1]) : NaN
    })
    segs = segs.flatMap((g) => splitAtGuide(g, midi, near, 0.45))
  }
  const found: TunedNote[] = segs.map((g) => ({ ...g, sung: middle(g.start, g.end), target: NaN, edited: false }))
  const long = (k: number): boolean => k >= 0 && k < found.length && found[k].end - found[k].start >= MIN_NOTE
  const notes: TunedNote[] = []
  found.forEach((g, k) => {
    if (long(k)) return void notes.push(g)
    const prev = long(k - 1) && found[k - 1].end === g.start ? found[k - 1] : null
    const next = long(k + 1) && found[k + 1].start === g.end ? found[k + 1] : null
    const into = prev && next ? (Math.abs(prev.sung - g.sung) <= Math.abs(next.sung - g.sung) ? prev : next) : (prev ?? next)
    if (!into) return void notes.push(g)
    into.start = Math.min(into.start, g.start)
    into.end = Math.max(into.end, g.end)
  })
  notes.sort((a, b) => a.start - b.start)

  if (s.mode === 'guide' && s.guide) {
    const guide = s.guide
    // the guide note under most of each sung note (none if the guide is mostly silent there)
    const picks = notes.map((n) => {
      const count = new Map<number, number>()
      for (let i = n.start; i < n.end; i++) {
        const g = guide[i]
        if (g !== undefined && !Number.isNaN(g)) count.set(g, (count.get(g) ?? 0) + 1)
      }
      let best = NaN
      let most = 0
      for (const [g, c] of count) if (c > most) [best, most] = [g, c]
      return most >= (n.end - n.start) * 0.3 ? best : NaN
    })
    // the octave the take is mostly sung in, so a note halfway between two octaves isn't flipped
    const votes = new Map<number, number>()
    notes.forEach((n, k) => {
      if (Number.isNaN(picks[k])) return
      const o = Math.round((n.sung - picks[k]) / 12)
      votes.set(o, (votes.get(o) ?? 0) + n.end - n.start)
    })
    let usual = 0
    let most = 0
    for (const [o, v] of votes) if (v > most) [usual, most] = [o, v]
    notes.forEach((n, k) => {
      const g = picks[k]
      if (Number.isNaN(g)) return
      n.target = g + 12 * usual
      // a note plainly sung in another octave (a leap) keeps that octave
      if (Math.abs(n.sung - n.target) > 7) n.target = g + 12 * Math.round((n.sung - g) / 12)
    })
  }
  if (s.mode !== 'off') for (const n of notes) if (Number.isNaN(n.target)) n.target = nearestInScale(n.sung)
  for (const e of s.edits ?? []) {
    const f = e.at / HOP_SEC
    const n = notes.find((x) => f >= x.start && f < x.end)
    if (!n) continue
    n.target = e.pitch ?? NaN
    n.edited = true
  }
  return notes
}

/** Semitones to shift each frame by, the resulting pitch (for drawing), and the notes found. */
export function pitchShifts(f0: Float32Array, s: TuneSettings): { shift: Float32Array; pitch: Float32Array; notes: TunedNote[] } {
  const notes = tuneNotes(f0, s)
  const fixed = s.transpose + s.detune / 100
  const shift = new Float32Array(f0.length).fill(fixed)
  const pitch = new Float32Array(f0.length).fill(NaN)
  // how much of the singer's own movement around each note (vibrato, scoops, drift) survives,
  // and how long the move from one note's correction to the next takes
  const keep = Math.pow(1 - Math.max(0, Math.min(1, s.speed)), 0.9)
  const glide = 0.005 + 0.12 * Math.pow(1 - s.speed, 1.5)
  const alpha = 1 - Math.exp(-HOP_SEC / glide)
  // each note's rule is shift = j − c·pitch: tuned, its middle lands on the target with `keep` of
  // the movement left; untuned, nothing moves. Easing both numbers together blends one rule into the next.
  let j = 0
  let c = 0
  let prevEnd = -1
  for (const n of notes) {
    const tuned = !Number.isNaN(n.target)
    const nj = tuned ? n.target - keep * n.sung : 0
    const nc = tuned ? 1 - keep : 0
    // straight after another note it glides over; after a gap it starts on its own rule
    if (n.start !== prevEnd) [j, c] = [nj, nc]
    for (let i = n.start; i < n.end; i++) {
      j += (nj - j) * alpha
      c += (nc - c) * alpha
      const m = hzToMidi(f0[i])
      shift[i] = j - c * m + fixed
      pitch[i] = m + shift[i]
    }
    prevEnd = n.end
  }
  return { shift, pitch, notes }
}

/** A zero-phase low-passed copy of the voice, for finding the main pulse of each period. */
function pulses(x: Float32Array, rate: number): Float32Array {
  const a = 1 - Math.exp((-2 * Math.PI * 900) / rate)
  const y = new Float32Array(x.length)
  let v = 0
  for (let i = 0; i < x.length; i++) y[i] = v += (x[i] - v) * a
  v = 0
  for (let i = x.length - 1; i >= 0; i--) y[i] = v += (y[i] - v) * a
  return y
}

/**
 * Time-domain PSOLA: cuts the voice into two-period grains centred on each pitch pulse and lays
 * them down again at the new period. Grains keep their own shape, so the voice's tone (formants)
 * stays put while the pitch moves; resampling each grain shifts the formants on their own.
 */
export function psola(x: Float32Array, rate: number, f0: Float32Array, shift: Float32Array, formant: number): Float32Array {
  const n = x.length
  const hopS = rate * HOP_SEC
  const frameAt = (t: number): number => Math.max(0, Math.min(f0.length - 1, Math.round(t / hopS)))
  // analysis marks: one per period on the period's main pulse (so every grain is cut at the same
  // point of the wave), and every 10 ms where unpitched
  const lp = pulses(x, rate)
  const marks: number[] = []
  const periods: number[] = []
  let polarity = 0
  for (let t = 0; t < n; ) {
    const f = f0[frameAt(t)]
    if (!(f > 0)) {
      polarity = 0
      marks.push(t)
      periods.push(hopS)
      t += hopS
      continue
    }
    const p = rate / f
    // entering a voiced stretch, find its strongest pulse in the first period; after that, look
    // for the next pulse of the same sign near where one period on says it should be
    const lo = Math.max(0, Math.ceil(polarity ? t - p * 0.2 : t))
    const hi = Math.min(n, polarity ? t + p * 0.2 : t + p)
    let best = Math.min(n - 1, Math.round(t))
    let bv = -Infinity
    for (let k = lo; k < hi; k++) {
      const v = polarity ? lp[k] * polarity : Math.abs(lp[k])
      if (v > bv) [bv, best] = [v, k]
    }
    if (!polarity) polarity = lp[best] < 0 ? -1 : 1
    if (marks.length && best <= marks[marks.length - 1]) best = marks[marks.length - 1] + 1
    marks.push(best)
    periods.push(p)
    t = best + p
  }
  const k = Math.pow(2, Math.max(-4, Math.min(4, formant)) / 12)
  const out = new Float32Array(n)
  const wsum = new Float32Array(n)
  let mi = 0
  let wasVoiced = false
  for (let ts = 0; ts < n; ) {
    while (mi + 1 < marks.length && Math.abs(marks[mi + 1] - ts) <= Math.abs(marks[mi] - ts)) mi++
    const ta = marks[mi]
    const p = periods[mi]
    const fi = frameAt(ta)
    const voiced = f0[fi] > 0
    // a voiced stretch starts on its first pulse, so unshifted audio comes out where it went in
    if (voiced && !wasVoiced) ts = Math.max(ts, ta)
    wasVoiced = voiced
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

import { magnitudes } from '../audio/fft'
import { detectKey, type Key } from './harmony'

/**
 * Listens to a finished song (mono, 22,050 Hz): tempo and beats, downbeats, key, a chord per
 * beat, sections, and kick/snare/hat hits. Standard music-information-retrieval methods, kept
 * simple: spectral-flux onsets, autocorrelation tempo, dynamic-programming beat tracking,
 * beat-synchronous chroma with template matching smoothed by Viterbi, and self-similarity for
 * sections. Pure functions, run in a worker.
 */

export interface Analysis {
  duration: number
  bpm: number
  /** seconds */
  beats: number[]
  /** beat indexes that start a bar */
  downbeats: number[]
  key: Key | null
  /** chord changes; root -1 means no chord */
  chords: { beat: number; root: number; minor: boolean }[]
  /** section starts, by downbeat index */
  sections: { bar: number; name: string }[]
  /** drum hits in seconds */
  drums: { kick: number[]; snare: number[]; hat: number[] }
  /** loudness of each bar (by downbeat), 0..1 */
  barEnergy: number[]
}

const N = 2048
const HOP = 512

/** Box-filter along a row with a window of 2r+1, via a running sum. */
function boxSmooth(a: Float32Array, r: number): Float32Array {
  const out = new Float32Array(a.length)
  let sum = 0
  let count = 0
  for (let i = -r; i < a.length; i++) {
    const add = i + r
    if (add < a.length) {
      sum += a[add]
      count++
    }
    const drop = i - r - 1
    if (drop >= 0) {
      sum -= a[drop]
      count--
    }
    if (i >= 0) out[i] = sum / count
  }
  return out
}

/** Splits a spectrogram into its steady (harmonic) and spiky (percussive) parts with soft masks. */
function hpss(mags: Float32Array[]): { harm: Float32Array[]; perc: Float32Array[] } {
  const frames = mags.length
  const bins = mags[0].length
  const alongTime: Float32Array[] = mags.map(() => new Float32Array(bins))
  const col = new Float32Array(frames)
  for (let k = 0; k < bins; k++) {
    for (let t = 0; t < frames; t++) col[t] = mags[t][k]
    const s = boxSmooth(col, 8)
    for (let t = 0; t < frames; t++) alongTime[t][k] = s[t]
  }
  const harm: Float32Array[] = []
  const perc: Float32Array[] = []
  for (let t = 0; t < frames; t++) {
    const alongFreq = boxSmooth(mags[t], 8)
    const h = new Float32Array(bins)
    const p = new Float32Array(bins)
    for (let k = 0; k < bins; k++) {
      const a = alongTime[t][k] ** 2
      const b = alongFreq[k] ** 2
      const m = a + b > 1e-12 ? a / (a + b) : 0.5
      h[k] = mags[t][k] * m
      p[k] = mags[t][k] * (1 - m)
    }
    harm.push(h)
    perc.push(p)
  }
  return { harm, perc }
}

/** Positive change in log-magnitude across a frequency band, per frame, with the local average removed. */
function flux(mags: Float32Array[], sr: number, loHz: number, hiHz: number): Float32Array {
  const lo = Math.max(1, Math.floor((loHz * N) / sr))
  const hi = Math.min(mags[0].length - 1, Math.ceil((hiHz * N) / sr))
  const out = new Float32Array(mags.length)
  for (let t = 1; t < mags.length; t++) {
    let s = 0
    for (let k = lo; k <= hi; k++) {
      const d = Math.log1p(100 * mags[t][k]) - Math.log1p(100 * mags[t - 1][k])
      if (d > 0) s += d
    }
    out[t] = s
  }
  const local = boxSmooth(out, 10)
  let max = 0
  for (let t = 0; t < out.length; t++) {
    out[t] = Math.max(0, out[t] - local[t])
    max = Math.max(max, out[t])
  }
  if (max > 0) for (let t = 0; t < out.length; t++) out[t] /= max
  return out
}

/** Tempo period in frames: the strongest repetition in the onset curve, leaning toward ~110 BPM. */
function tempoPeriod(env: Float32Array, fps: number): number {
  let best = 0
  let bestLag = fps / 2
  const ac = (lag: number): number => {
    let s = 0
    for (let t = 0; t + lag < env.length; t++) s += env[t] * env[t + lag]
    return s / (env.length - lag)
  }
  const scores = new Map<number, number>()
  for (let bpm = 60; bpm <= 190; bpm += 0.5) {
    const lag = Math.round((60 * fps) / bpm)
    if (!scores.has(lag)) scores.set(lag, ac(lag))
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 110) / 0.9) ** 2)
    const s = scores.get(lag)! * prior
    if (s > best) {
      best = s
      bestLag = lag
    }
  }
  // parabolic refinement around the winning lag
  const a = ac(bestLag - 1)
  const b = ac(bestLag)
  const c = ac(bestLag + 1)
  const d = a - 2 * b + c
  return bestLag + (d !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0)
}

/** Ellis-style dynamic-programming beat tracker: beats on strong onsets, spaced close to the period. */
function trackBeats(env: Float32Array, period: number): number[] {
  const n = env.length
  const score = new Float64Array(n)
  const back = new Int32Array(n).fill(-1)
  const tight = 100
  for (let t = 0; t < n; t++) {
    let best = 0
    let from = -1
    const lo = Math.max(0, Math.round(t - 2 * period))
    const hi = Math.round(t - period / 2)
    for (let p = lo; p <= hi; p++) {
      const s = score[p] - tight * Math.log((t - p) / period) ** 2
      if (s > best || from < 0) {
        best = s
        from = p
      }
    }
    score[t] = env[t] + (from >= 0 ? Math.max(0, best) : 0)
    back[t] = from >= 0 && best > 0 ? from : -1
  }
  // end on the strongest beat near the end, then follow the links back
  let t = n - 1
  let top = -Infinity
  for (let i = Math.max(0, Math.round(n - 2 * period)); i < n; i++)
    if (score[i] > top) {
      top = score[i]
      t = i
    }
  const beats: number[] = []
  while (t >= 0) {
    beats.push(t)
    t = back[t]
  }
  return beats.reverse()
}

/** Pitch-class profile (12) of a spectrum between two frequencies. */
function chroma(mag: Float32Array, n: number, sr: number, loHz: number, hiHz: number): Float32Array {
  const c = new Float32Array(12)
  const lo = Math.max(1, Math.floor((loHz * n) / sr))
  const hi = Math.min(mag.length - 1, Math.ceil((hiHz * n) / sr))
  for (let k = lo; k <= hi; k++) {
    const f = (k * sr) / n
    const pc = ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12
    c[pc] += mag[k] * mag[k]
  }
  return c
}

const norm = (v: Float32Array): Float32Array => {
  let s = 0
  for (const x of v) s += x * x
  s = Math.sqrt(s)
  return s > 0 ? v.map((x) => x / s) : v
}
const dot = (a: Float32Array, b: Float32Array): number => a.reduce((s, x, i) => s + x * b[i], 0)

function peaks(env: Float32Array, fps: number, threshold: number): number[] {
  const out: number[] = []
  const gap = Math.round(fps * 0.06)
  let last = -Infinity
  for (let t = 2; t < env.length - 2; t++) {
    if (env[t] < threshold || env[t] < env[t - 1] || env[t] < env[t + 1] || env[t] < env[t - 2] || env[t] < env[t + 2]) continue
    if (t - last < gap) continue
    out.push(t / fps)
    last = t
  }
  return out
}

/**
 * Hits in the snare band are snares or hi-hats. Given a score where snares come out higher, the
 * hits are split into two groups on it (1-D k-means) and the higher group is kept. With no clear
 * split, they're all snares or all hats.
 */
function splitSnares(hits: number[], midToHigh: (sec: number) => number): number[] {
  if (hits.length < 4) return hits
  const r = hits.map(midToHigh)
  let lo = Math.min(...r)
  let hi = Math.max(...r)
  for (let it = 0; it < 20; it++) {
    const a: number[] = []
    const b: number[] = []
    for (const v of r) (Math.abs(v - lo) <= Math.abs(v - hi) ? a : b).push(v)
    if (!a.length || !b.length) break
    lo = a.reduce((s, v) => s + v, 0) / a.length
    hi = b.reduce((s, v) => s + v, 0) / b.length
  }
  if (hi - lo < 0.7) return lo > 0 ? hits : []
  const cut = (lo + hi) / 2
  return hits.filter((_, i) => r[i] > cut)
}

export function analyse(x: Float32Array, sr: number, progress: (p: number) => void = () => undefined): Analysis {
  const fps = sr / HOP
  const duration = x.length / sr
  const mags = magnitudes(x, N, HOP)
  progress(0.2)
  const { perc } = hpss(mags)
  progress(0.35)

  // tempo and beats from the full-band onset curve
  const env = flux(mags, sr, 30, 8000)
  const period = tempoPeriod(env, fps)
  const beatFrames = trackBeats(env, period)
  // a frame's flux peaks about one hop before the hit it measures
  const beats = beatFrames.map((f) => (f + 1) / fps)
  const bpm = Math.round(((60 * fps) / period) * 10) / 10
  progress(0.45)

  // drum hits, from the percussive part in three bands
  const kickEnv = flux(perc, sr, 35, 130)
  const snareEnv = flux(perc, sr, 1000, 4500)
  const hatEnv = flux(perc, sr, 7000, 10500)
  // hats also show up in the snare band; a snare has real mid-range energy, a hat is mostly highs
  const bandEnergy = (t: number, loHz: number, hiHz: number): number => {
    let e = 0
    for (let k = Math.floor((loHz * N) / sr); k <= Math.ceil((hiHz * N) / sr); k++) e += (perc[t]?.[k] ?? 0) ** 2
    return e
  }
  const shift = (times: number[]): number[] => times.map((v) => v + 1 / fps)
  // a snare's mids are strong next to its lows (unlike a kick's click) and its highs (unlike a hat)
  const snareHits = splitSnares(peaks(snareEnv, fps, 0.3), (sec) => {
    const t = Math.round(sec * fps)
    const mid = bandEnergy(t, 1000, 4500) + 1e-9
    return Math.min(Math.log(mid / (bandEnergy(t, 7000, 10500) + 1e-9)), Math.log(mid / (bandEnergy(t, 35, 130) + 1e-9)) + 1)
  })
  const drums = { kick: shift(peaks(kickEnv, fps, 0.3)), snare: shift(snareHits), hat: shift(peaks(hatEnv, fps, 0.25)) }

  // finer spectrum for pitch: chroma per beat, from the steady (harmonic) part
  const N2 = 8192
  const HOP2 = 2048
  const fine = magnitudes(x, N2, HOP2)
  const { harm: fineHarm } = hpss(fine)
  progress(0.65)
  const fps2 = sr / HOP2
  const beatChroma: Float32Array[] = []
  const bassChroma: Float32Array[] = []
  const beatKick: number[] = []
  const beatEnergy: number[] = []
  const total = new Float32Array(12)
  for (let i = 0; i < beats.length; i++) {
    const a = Math.floor(beats[i] * fps2)
    const b = Math.max(a + 1, Math.floor((beats[i + 1] ?? beats[i] + period / fps) * fps2))
    const c = new Float32Array(12)
    const bc = new Float32Array(12)
    for (let f = a; f < Math.min(b, fineHarm.length); f++) {
      chroma(fineHarm[f], N2, sr, 80, 2000).forEach((v, k) => (c[k] += v))
      chroma(fineHarm[f], N2, sr, 35, 180).forEach((v, k) => (bc[k] += v))
    }
    c.forEach((v, k) => (total[k] += v))
    beatChroma.push(norm(c))
    bassChroma.push(norm(bc))
    let e = 0
    const s0 = Math.floor(beats[i] * sr)
    const s1 = Math.min(x.length, Math.floor((beats[i + 1] ?? beats[i] + period / fps) * sr))
    for (let j = s0; j < s1; j++) e += x[j] * x[j]
    beatEnergy.push(Math.sqrt(e / Math.max(1, s1 - s0)))
    const kf = beatFrames[i]
    beatKick.push(Math.max(kickEnv[kf] ?? 0, kickEnv[kf + 1] ?? 0, kickEnv[kf - 1] ?? 0))
  }
  const key = detectKey([...total])
  progress(0.75)

  // downbeats: which of the four beat positions has the most kicks and chord changes
  let phase = 0
  let phaseScore = -Infinity
  for (let k = 0; k < 4; k++) {
    let s = 0
    for (let i = k; i < beats.length; i += 4) s += beatKick[i] + 2 * (i > 0 ? 1 - dot(beatChroma[i], beatChroma[i - 1]) : 0) + (i > 0 ? 1 - dot(bassChroma[i], bassChroma[i - 1]) : 0)
    if (s > phaseScore) {
      phaseScore = s
      phase = k
    }
  }
  const downbeats: number[] = []
  for (let i = phase; i < beats.length; i += 4) downbeats.push(i)

  const rawBar = downbeats.map((b, i) => {
    const end = downbeats[i + 1] ?? Math.min(beats.length, b + 4)
    let e = 0
    for (let k = b; k < end; k++) e += beatEnergy[k] ?? 0
    return e / Math.max(1, end - b)
  })
  const loudest = Math.max(1e-9, ...rawBar)
  const barEnergy = rawBar.map((e) => e / loudest)
  const chords = chordsFor(beatChroma, bassChroma, key, phase)
  const songKey = keyFromChords(chords, beats.length) ?? key
  progress(0.9)
  const sections = findSections(beatChroma, bassChroma, beatEnergy, downbeats)
  progress(1)
  return { duration, bpm, beats, downbeats, key: songKey, chords, sections, drums, barEnergy }
}

/**
 * The key whose chords cover the most of the song's detected chords (by beats), which holds up
 * better than overall pitch balance when instruments have strong overtones. Relative keys tie
 * (C major and A minor share chords), so the key whose home chord is heard most, and first, wins.
 */
function keyFromChords(chords: Analysis['chords'], beats: number): Key | null {
  const spans = chords
    .map((c, i) => ({ ...c, len: (chords[i + 1]?.beat ?? beats) - c.beat }))
    .filter((c) => c.root >= 0)
  if (!spans.length) return null
  const total = spans.reduce((a, c) => a + c.len, 0)
  let best: Key | null = null
  let bestScore = -Infinity
  for (let tonic = 0; tonic < 12; tonic++)
    for (const minor of [false, true]) {
      const scale = (minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]).map((s) => (s + tonic) % 12)
      const quality = minor ? [true, false, false, true, true, false, false] : [false, true, true, false, false, true, true]
      let s = 0
      for (const c of spans) {
        const i = scale.indexOf(c.root)
        // minor keys often use a major V; count it as belonging
        const fits = i >= 0 && (quality[i] === c.minor || (minor && i === 4 && !c.minor))
        if (fits) s += c.len
        if (c.root === tonic && c.minor === minor) s += 0.5 * c.len
      }
      if (spans[0].root === tonic && spans[0].minor === minor) s += 0.25 * total * 0.1
      if (s > bestScore) {
        bestScore = s
        best = { tonic, minor, confidence: Math.min(1, s / (total * 1.5)) }
      }
    }
  return best
}

/** Major and minor triads matched against each beat, smoothed with Viterbi so chords hold. */
function chordsFor(c: Float32Array[], bass: Float32Array[], key: Key | null, phase: number): Analysis['chords'] {
  const states: { root: number; minor: boolean; tmpl: Float32Array }[] = []
  for (let root = 0; root < 12; root++)
    for (const minor of [false, true]) {
      const t = new Float32Array(12)
      t[root] = 1
      t[(root + (minor ? 3 : 4)) % 12] = 0.85
      t[(root + 7) % 12] = 0.9
      states.push({ root, minor, tmpl: norm(t) })
    }
  const scale = key ? (key.minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]).map((s) => (s + key.tonic) % 12) : null
  const S = states.length + 1 // last state: no chord
  const T = c.length
  if (!T) return []
  const emit = (t: number, s: number): number => {
    const energy = c[t].reduce((a, v) => a + v, 0)
    if (s === states.length) return energy < 0.01 ? 4 : 0.35 * 8
    const st = states[s]
    let v = dot(c[t], st.tmpl) + 0.25 * bass[t][st.root]
    if (scale && scale.includes(st.root)) v += 0.06
    return v * 8
  }
  const change = (t: number): number => ((t - phase) % 4 === 0 ? 1.4 : (t - phase) % 2 === 0 ? 2.2 : 3.2)
  let prev = new Float64Array(S)
  const back: Int16Array[] = []
  for (let s = 0; s < S; s++) prev[s] = emit(0, s)
  for (let t = 1; t < T; t++) {
    const cur = new Float64Array(S)
    const bk = new Int16Array(S)
    let bestPrev = 0
    for (let s = 1; s < S; s++) if (prev[s] > prev[bestPrev]) bestPrev = s
    const pen = change(t)
    for (let s = 0; s < S; s++) {
      const stay = prev[s]
      const move = prev[bestPrev] - pen
      if (stay >= move) {
        cur[s] = stay
        bk[s] = s
      } else {
        cur[s] = move
        bk[s] = bestPrev
      }
      cur[s] += emit(t, s)
    }
    back.push(bk)
    prev = cur
  }
  let s = 0
  for (let k = 1; k < S; k++) if (prev[k] > prev[s]) s = k
  const path = new Array<number>(T)
  path[T - 1] = s
  for (let t = T - 1; t > 0; t--) path[t - 1] = s = back[t - 1][s]
  const out: Analysis['chords'] = []
  path.forEach((st, beat) => {
    const root = st === states.length ? -1 : states[st].root
    const minor = st === states.length ? false : states[st].minor
    const last = out[out.length - 1]
    if (!last || last.root !== root || last.minor !== minor) out.push({ beat, root, minor })
  })
  return out
}

/**
 * Sections from repetition. The song is cut into four-bar blocks; blocks are compared as
 * sequences (bar by bar, harmony and bass), alike neighbours merge into one section, and parts that
 * come back get the same name. The loudest repeated part is taken to be the chorus.
 */
function findSections(c: Float32Array[], bass: Float32Array[], energy: number[], downbeats: number[]): Analysis['sections'] {
  const bars = downbeats.length
  if (bars < 8) return [{ bar: 0, name: 'Verse' }]
  const barVec = downbeats.map((b, i) => {
    const end = downbeats[i + 1] ?? b + 4
    const v = new Float32Array(24)
    for (let k = b; k < end; k++)
      for (let p = 0; p < 12; p++) {
        v[p] += c[k]?.[p] ?? 0
        v[12 + p] += 0.6 * (bass[k]?.[p] ?? 0)
      }
    return norm(v)
  })
  const barEnergy = downbeats.map((b, i) => {
    const end = downbeats[i + 1] ?? b + 4
    let e = 0
    for (let k = b; k < end; k++) e += energy[k] ?? 0
    return e / Math.max(1, end - b)
  })
  const BLOCK = 4
  const blocks: { from: number; to: number }[] = []
  for (let b = 0; b < bars; b += BLOCK) blocks.push({ from: b, to: Math.min(bars, b + BLOCK) })
  // sequence similarity: bar-by-bar match of two blocks
  const blockSim = (a: { from: number }, b: { from: number }): number => {
    let s = 0
    for (let k = 0; k < BLOCK; k++) s += barVec[a.from + k] && barVec[b.from + k] ? dot(barVec[a.from + k], barVec[b.from + k]) : 0
    return s / BLOCK
  }
  const label: number[] = []
  let next = 0
  blocks.forEach((blk, i) => {
    let found = -1
    // repeats in real songs vary in arrangement, so the harmony only has to match closely
    let best = 0.82
    for (let j = 0; j < i; j++) {
      const sim = blockSim(blk, blocks[j])
      if (sim > best) {
        best = sim
        found = label[j]
      }
    }
    label.push(found >= 0 ? found : next++)
  })
  // two blocks in a row that belong together (an 8-bar verse) stay one section
  const segs: { from: number; to: number; labels: number[]; split?: boolean }[] = []
  blocks.forEach((blk, i) => {
    const last = segs[segs.length - 1]
    const pairContinues = last && last.labels.length === 1 && i > 0 && blocks.some((_, j) => j > 0 && j !== i && label[j - 1] === label[i - 1] && label[j] === label[i])
    if (last && (label[i] === label[i - 1] || pairContinues)) {
      last.to = blk.to
      last.labels.push(label[i])
    } else segs.push({ from: blk.from, to: blk.to, labels: [label[i]] })
  })
  // consecutive parts that never come back are one stretch (until it's cut up again below)
  const seen = new Map<string, number>()
  segs.forEach((sg) => seen.set(sg.labels.join('.'), (seen.get(sg.labels.join('.')) ?? 0) + 1))
  for (let k = segs.length - 1; k > 0; k--) {
    const once = (sg: { labels: number[] }): boolean => seen.get(sg.labels.join('.')) === 1
    if (once(segs[k]) && once(segs[k - 1])) {
      segs[k - 1].to = segs[k].to
      segs.splice(k, 1)
    }
  }
  // long stretches that never repeat get cut where the harmony changes most (checkerboard novelty)
  const K = 4
  const novelty = (i: number): number => {
    let v = 0
    for (let a = -K; a < K; a++)
      for (let b = -K; b < K; b++) {
        const x = barVec[i + a]
        const y = barVec[i + b]
        if (x && y) v += ((a < 0) === (b < 0) ? 1 : -1) * dot(x, y)
      }
    return v
  }
  for (let k = 0; k < segs.length; k++) {
    const sg = segs[k]
    if (sg.to - sg.from <= 16) continue
    let cut = -1
    let best = -Infinity
    for (let i = sg.from + 8; i <= sg.to - 8; i += 2) {
      const v = novelty(i)
      if (v > best) {
        best = v
        cut = i
      }
    }
    if (cut < 0) continue
    // the two halves become new kinds unless they sound like a part heard elsewhere
    segs.splice(k, 1, { from: sg.from, to: cut, labels: [next++], split: true }, { from: cut, to: sg.to, labels: [next++], split: true })
    k--
  }
  const segVec = (sg: { from: number; to: number }): Float32Array => {
    const v = new Float32Array(24)
    for (let i = sg.from; i < sg.to; i++) barVec[i]?.forEach((x, j) => (v[j] += x))
    return norm(v)
  }
  segs.forEach((sg, i) => {
    if (!sg.split) return
    for (let j = 0; j < i; j++)
      if (segs[j].split && dot(segVec(sg), segVec(segs[j])) > 0.95) {
        sg.labels = segs[j].labels
        break
      }
  })
  const kind = (s: { labels: number[] }): string => s.labels.join('.')
  const counts = new Map<string, number>()
  segs.forEach((s) => counts.set(kind(s), (counts.get(kind(s)) ?? 0) + 1))
  const loud = (s: { from: number; to: number }): number => {
    let e = 0
    for (let b = s.from; b < s.to; b++) e += barEnergy[b]
    return e / (s.to - s.from)
  }
  const repeatedKinds = [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k)
  const avgLoud = (k: string): number => {
    const ss = segs.filter((s) => kind(s) === k)
    return ss.reduce((a, s) => a + loud(s), 0) / ss.length
  }
  repeatedKinds.sort((a, b) => avgLoud(b) - avgLoud(a))
  const names = new Map<string, string>()
  if (repeatedKinds[0]) names.set(repeatedKinds[0], repeatedKinds.length > 1 ? 'Chorus' : 'Verse')
  if (repeatedKinds[1]) names.set(repeatedKinds[1], 'Verse')
  // near-silent tail blocks are just the song ringing out
  const typical = [...barEnergy].sort((x, y) => x - y)[barEnergy.length >> 1] || 1
  while (segs.length > 1 && loud(segs[segs.length - 1]) < typical * 0.15) segs.pop()
  // parts that never come back get plain names; they're easy to rename
  let part = 0
  return segs.map((s, i) => {
    const repeated = names.get(kind(s))
    if (repeated) return { bar: s.from, name: repeated }
    if (i === 0) return { bar: s.from, name: 'Intro' }
    if (i === segs.length - 1 && segs.length > 2) return { bar: s.from, name: 'Outro' }
    return { bar: s.from, name: segs.length <= 4 ? 'Bridge' : `Part ${String.fromCharCode(65 + part++)}` }
  })
}

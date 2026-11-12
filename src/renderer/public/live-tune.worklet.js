/* global AudioWorkletProcessor, registerProcessor, sampleRate */
// Live autotune for the microphone, for singing over the piano (and on a stream). It finds the
// pitch every 5 ms (YIN on a 16 kHz copy) and moves it with pitch-synchronous overlap-add
// (PSOLA), the same way recorded takes are tuned, three of the lowest note's periods behind the
// voice: about 32 ms for a low voice (down to 95 Hz), less when told the voice won't go that low. The work is in
// LiveTuner so it can be tested outside an AudioWorklet.

const RING = 1 << 15
const MASK = RING - 1
const TONE_MIN = Math.pow(2, -4 / 12)

class LiveTuner {
  constructor(sr, lowest) {
    this.sr = sr
    this.inp = new Float32Array(RING)
    // low-passed input, for finding the main pulse of each period
    this.lp = new Float32Array(RING)
    this.acc = new Float32Array(RING)
    this.wsum = new Float32Array(RING)
    this.w = 0
    this.lpv = 0
    this.lpA = 1 - Math.exp((-2 * Math.PI * 900) / sr)

    // pitch detection on a 16 kHz copy
    this.D = Math.max(1, Math.round(sr / 16000))
    this.dsr = sr / this.D
    this.ds = new Float32Array(4096)
    this.dsN = 0
    this.dsAcc = 0
    this.dsCount = 0
    this.W = Math.round(this.dsr * 0.015)
    this.tauMin = Math.floor(this.dsr / 1000)
    this.tauMax = Math.ceil(this.dsr / 80)
    this.d = new Float32Array(this.tauMax + 2)
    this.hop = Math.round(sr * 0.005)
    this.sinceDetect = 0
    this.f0 = 0
    this.misses = 0
    this.hits = 0

    // the longest period shifted; anything lower is treated as this. The delay covers a two-period
    // grain either side of a mark plus the look-ahead for finding the next pulse.
    this.maxP = Math.round(sr / Math.max(80, Math.min(300, lowest || 95)))
    this.latency = Math.ceil(this.maxP * 3)
    this.marks = []
    this.mi = 0
    this.nextMark = 0
    this.polarity = 0
    this.ts = 0
    this.out = -this.latency
    this.wasVoiced = false

    // tuning
    // classes: the notes to land on; soft: others that are fine when sung close (the key, around a chord)
    this.params = { classes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], soft: [], target: null, speed: 0.6, transpose: 0, formant: 0 }
    this.current = NaN
    this.pending = NaN
    this.pendingCount = 0
    this.slow = NaN
    this.ctr = NaN
    this.m1 = NaN
    this.m2 = NaN
    this.age = 0
    this.corr = 0
    this.shift = 0
    this.sung = NaN

    // level: brought up to a usual vocal level (a mic gives far less than the piano), and gated
    // between phrases so the hiss that comes up with it doesn't
    this.env = 0
    this.envA = 1 - Math.exp(-1 / (sr * 0.01))
    this.noise = 0.001
    this.loud = 0.02
    this.gain = 4
    this.gate = 0
  }

  set(p) {
    Object.assign(this.params, p)
  }

  push(x) {
    const k = this.w & MASK
    this.inp[k] = x
    this.lpv += (x - this.lpv) * this.lpA
    this.lp[k] = this.lpv
    this.w++
    this.dsAcc += x
    if (++this.dsCount === this.D) {
      this.ds[this.dsN & 4095] = this.dsAcc / this.D
      this.dsN++
      this.dsAcc = 0
      this.dsCount = 0
    }
    this.env += (x * x - this.env) * this.envA
    if (++this.sinceDetect >= this.hop) {
      this.sinceDetect = 0
      this.detect()
      this.retarget()
      this.level()
    }
    this.makeMarks()
  }

  /** YIN on the latest 15 ms (plus the longest lag) of the 16 kHz copy. */
  detect() {
    const W = this.W
    const tauMax = this.tauMax
    if (this.dsN < W + tauMax + 2) return
    const start = this.dsN - (W + tauMax + 1)
    const x = (i) => this.ds[(start + i) & 4095]
    let energy = 0
    for (let j = 0; j < W; j++) energy += x(j) * x(j)
    let f = 0
    if (Math.sqrt(energy / W) > 0.003) {
      const d = this.d
      let running = 0
      d[0] = 1
      for (let tau = 1; tau <= tauMax + 1; tau++) {
        let sum = 0
        for (let j = 0; j < W; j++) {
          const diff = x(j) - x(j + tau)
          sum += diff * diff
        }
        running += sum
        d[tau] = running > 0 ? (sum * tau) / running : 1
      }
      let tau = -1
      let deepest = this.tauMin
      for (let t = this.tauMin; t <= tauMax; t++) {
        if (d[t] < 0.15) {
          while (t + 1 <= tauMax && d[t + 1] < d[t]) t++
          tau = t
          break
        }
        if (d[t] < d[deepest]) deepest = t
      }
      if (tau < 0 && d[deepest] < 0.25) tau = deepest
      if (tau > 0) {
        const a = d[tau - 1]
        const b = d[tau]
        const c = d[tau + 1]
        const den = a - 2 * b + c
        const s = den !== 0 ? (0.5 * (a - c)) / den : 0
        f = this.dsr / (tau + Math.max(-0.5, Math.min(0.5, s)))
        // an octave jump from the last estimate is usually detection, not the voice
        if (this.f0 > 0) {
          const r = f / this.f0
          if (r > 1.8 && r < 2.2) f /= 2
          else if (r > 0.45 && r < 0.56) f *= 2
        }
      }
    }
    // voicing needs two hits in a row to start and two misses to stop, so it doesn't flicker
    if (f > 0) {
      this.misses = 0
      if (++this.hits >= 2 || this.f0 > 0) this.f0 = f
    } else {
      this.hits = 0
      if (++this.misses >= 2) this.f0 = 0
    }
  }

  /**
   * How far a note is from being the one meant, in semitones: its distance from the pitch, more
   * for notes outside the ones asked for, less for the note already being held (so vibrato and
   * drift across the halfway point between two notes don't flip it back and forth).
   */
  cost(c, x, sticky) {
    const p = this.params
    const pc = ((c % 12) + 12) % 12
    const classes = p.classes && p.classes.length ? p.classes : null
    const soft = p.soft && p.soft.length ? p.soft : null
    let pen = 0
    if (classes && !classes.includes(pc)) {
      if (soft && soft.includes(pc)) pen = 0.3
      else {
        // a note outside the key is only meant when it's sung nearly dead on; never when tuning hard
        const speed = Math.max(0, Math.min(1, p.speed))
        pen = (soft ? 0.3 : 0) + 1 - 0.5 * (1 - speed * speed * speed)
      }
    }
    return Math.abs(c - x) + pen - (sticky && c === this.current ? 0.3 : 0)
  }

  /** The note a pitch is most likely meant to be. */
  pick(x, sticky) {
    const p = this.params
    if (p.target !== null && p.target !== undefined) {
      // the song's note, in the singer's octave, unless they're clearly on some other note
      const t = p.target + 12 * Math.round((x - p.target) / 12)
      if (Math.abs(x - t) <= 1.5) return t
    }
    const r = Math.round(x)
    let cand = r
    let best = Infinity
    for (let c = r - 3; c <= r + 3; c++) {
      const v = this.cost(c, x, sticky)
      if (v < best) [best, cand] = [v, c]
    }
    return cand
  }

  /** Which note to aim at and how far to move the voice, per detection. */
  retarget() {
    const p = this.params
    if (!(this.f0 > 0)) {
      this.current = NaN
      this.slow = NaN
      this.ctr = NaN
      this.sung = NaN
      this.age = 0
      this.m1 = this.m2 = NaN
      // let go of the last note's correction, so the next one doesn't start bent
      this.corr *= 0.8
      this.shift = p.transpose
      return
    }
    const raw = 69 + 12 * Math.log2(this.f0 / 440)
    // the middle of the last three readings: one stray reading doesn't move anything
    const a = Number.isNaN(this.m1) ? raw : this.m1
    const b = Number.isNaN(this.m2) ? a : this.m2
    const m = Math.max(Math.min(raw, a), Math.min(Math.max(raw, a), b))
    this.m2 = this.m1
    this.m1 = raw
    this.sung = m
    const hopSec = this.hop / this.sr
    this.age++
    // the centre of the voice over the last ~50 ms: where a note with vibrato really sits
    this.ctr = Number.isNaN(this.ctr) ? m : this.ctr + (m - this.ctr) * (1 - Math.exp(-hopSec / 0.05))
    const settling = this.age <= 8
    let unsure = false
    if (Number.isNaN(this.current)) this.current = this.pick(m, false)
    else if (settling) {
      // the first 40 ms of a note are often a scoop up to it: follow it freely
      this.current = this.pick(m, true)
    } else {
      // near the held note, go by the centre of the voice; a real jump is taken as sung
      const far = Math.abs(m - this.current) >= 1
      const cand = this.pick(far ? m : this.ctr, true)
      unsure = this.pick(m, true) !== this.current
      if (cand !== this.current) {
        if (cand === this.pending) this.pendingCount++
        else [this.pending, this.pendingCount] = [cand, 1]
        if (this.pendingCount >= 3) {
          this.current = cand
          this.pendingCount = 0
          this.ctr = m
          unsure = false
          if (!Number.isNaN(this.slow)) this.slow = m - (m - this.slow) * 0.3
        }
      } else this.pendingCount = 0
    }
    this.slow = Number.isNaN(this.slow) ? m : this.slow + (m - this.slow) * (1 - Math.exp(-hopSec / 0.12))
    // Natural keeps the singer's own vibrato and slides around the note; Hard holds it flat
    const speed = Math.max(0, Math.min(1, p.speed))
    const keep = Math.pow(1 - speed, 0.9)
    let want = this.current - ((1 - keep) * m + keep * this.slow)
    // already on the note: leave the voice alone (more leeway the more natural the setting)
    const leeway = 0.25 * (1 - speed)
    if (leeway > 0) want *= Math.max(0, Math.min(1, (Math.abs(this.current - this.slow) - leeway) / leeway))
    // a note eases in rather than snapping from its first instant
    const ease = 0.005 + 0.06 * (1 - speed)
    want *= Math.min(1, (this.age * hopSec) / ease)
    const glide = 0.005 + 0.12 * Math.pow(1 - speed, 1.5)
    // on the way to another note (or at the far edge of a vibrato): hold, rather than drag it back
    if (!unsure) this.corr += (want - this.corr) * (1 - Math.exp(-hopSec / glide))
    this.shift = Math.max(-12, Math.min(12, this.corr + p.transpose))
  }

  /** Follows the hiss and the singing level, for the gain and the gate. */
  level() {
    const r = Math.sqrt(this.env)
    const hopSec = this.hop / this.sr
    // hiss: falls quickly to quiet moments, creeps up slowly
    this.noise = r < this.noise ? this.noise + (r - this.noise) * 0.3 : this.noise * Math.exp(hopSec / 4)
    this.noise = Math.max(1e-5, Math.min(this.noise, 0.05))
    // singing: jumps up to loud moments, settles slowly
    if (r > this.noise * 8) this.loud = r > this.loud ? this.loud + (r - this.loud) * 0.2 : this.loud + (r - this.loud) * (1 - Math.exp(-hopSec / 8))
    const want = Math.max(0.5, Math.min(8, 0.125 / Math.max(this.loud, 1e-4)))
    this.gain += (want - this.gain) * (1 - Math.exp(-hopSec / 2))
    const open = Math.max(this.noise * 4, 0.0005)
    const target = r > open || this.f0 > 0 ? 1 : 0.05
    this.gate += (target - this.gate) * (target > this.gate ? 0.7 : 1 - Math.exp(-hopSec / 0.08))
  }

  /** Analysis marks: one per period on the period's main pulse, every 5 ms where unpitched. */
  makeMarks() {
    const look = Math.ceil(this.maxP * 0.25)
    while (this.nextMark + look < this.w) {
      const t = this.nextMark
      if (!(this.f0 > 0)) {
        this.polarity = 0
        this.addMark(Math.round(t), this.hop, false)
        this.nextMark = t + this.hop
        continue
      }
      const P = Math.min(this.maxP, this.sr / this.f0)
      const lo = Math.max(this.w - RING + 1, Math.ceil(this.polarity ? t - P * 0.2 : t))
      const hi = this.polarity ? t + P * 0.2 : t + P
      if (hi >= this.w) break
      let best = Math.round(t)
      let bv = -Infinity
      for (let k = lo; k < hi; k++) {
        const v = this.polarity ? this.lp[k & MASK] * this.polarity : Math.abs(this.lp[k & MASK])
        if (v > bv) [bv, best] = [v, k]
      }
      if (!this.polarity) this.polarity = this.lp[best & MASK] < 0 ? -1 : 1
      const last = this.marks.length ? this.marks[this.marks.length - 1].pos : -Infinity
      if (best <= last) best = last + 1
      this.addMark(best, P, true)
      this.nextMark = best + P
    }
  }

  addMark(pos, period, voiced) {
    this.marks.push({ pos, period, voiced, shift: voiced ? this.shift : 0 })
    // forget marks long since played
    if (this.marks.length > 512) {
      const keepFrom = this.marks.findIndex((m) => m.pos > this.out - 4 * this.maxP)
      if (keepFrom > 0) {
        this.marks.splice(0, keepFrom)
        this.mi = Math.max(0, this.mi - keepFrom)
      }
    }
  }

  /** Lays down grains for every synthesis mark before `limit`. */
  synthUpTo(limit) {
    const marks = this.marks
    while (this.ts < limit) {
      if (!marks.length || marks[marks.length - 1].pos < this.ts) return
      while (this.mi + 1 < marks.length && Math.abs(marks[this.mi + 1].pos - this.ts) <= Math.abs(marks[this.mi].pos - this.ts)) this.mi++
      const m = marks[this.mi]
      if (m.voiced && !this.wasVoiced) this.ts = Math.max(this.ts, m.pos)
      this.wasVoiced = m.voiced
      const ratio = m.voiced ? Math.pow(2, m.shift / 12) : 1
      const k = Math.pow(2, Math.max(-4, Math.min(4, this.params.formant)) / 12)
      const half = m.period / k
      const at = Math.round(this.ts)
      const oldest = this.w - RING + 2
      for (let o = Math.ceil(at - half); o <= Math.floor(at + half); o++) {
        const w = 0.5 + 0.5 * Math.cos((Math.PI * (o - at)) / half)
        let v
        if (k === 1) {
          const s = m.pos + o - at
          if (s < oldest || s >= this.w) continue
          v = this.inp[s & MASK]
        } else {
          const src = m.pos + (o - at) * k
          const s0 = Math.floor(src)
          if (s0 < oldest || s0 + 1 >= this.w) continue
          const a = this.inp[s0 & MASK]
          v = a + (this.inp[(s0 + 1) & MASK] - a) * (src - s0)
        }
        this.acc[o & MASK] += v * w
        this.wsum[o & MASK] += w
      }
      this.ts += m.period / ratio
    }
  }

  process(input, output) {
    const n = output.length
    for (let i = 0; i < n; i++) this.push(input ? input[i] : 0)
    const reach = Math.ceil(this.maxP / TONE_MIN) + 2
    for (let i = 0; i < n; i++) {
      const t = this.out++
      if (t < 0) {
        output[i] = 0
        continue
      }
      this.synthUpTo(t + reach)
      const k = t & MASK
      const ws = this.wsum[k]
      output[i] = (ws > 0.3 ? this.acc[k] / ws : this.acc[k]) * this.gain * this.gate
      this.acc[k] = 0
      this.wsum[k] = 0
    }
  }
}

if (typeof AudioWorkletProcessor !== 'undefined') {
  class KeyfallLiveTune extends AudioWorkletProcessor {
    constructor(options) {
      super()
      const o = (options && options.processorOptions) || {}
      this.tuner = new LiveTuner(sampleRate, o.lowest)
      this.since = 0
      this.port.onmessage = (e) => this.tuner.set(e.data)
    }

    process(inputs, outputs) {
      const out = outputs[0] && outputs[0][0]
      if (!out) return true
      this.tuner.process(inputs[0] && inputs[0][0], out)
      // tell the page what's being sung and aimed at, for the pitch marker on the keys
      this.since += out.length
      if (this.since >= sampleRate / 20) {
        this.since = 0
        const t = this.tuner
        this.port.postMessage({ sung: t.sung, target: t.current, shift: t.shift })
      }
      return true
    }
  }
  registerProcessor('keyfall-live-tune', KeyfallLiveTune)
}

if (typeof module !== 'undefined') module.exports = { LiveTuner }

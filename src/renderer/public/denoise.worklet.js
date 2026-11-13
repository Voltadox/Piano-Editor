/* global AudioWorkletProcessor, registerProcessor, sampleRate */
// Background noise taken out of the microphone, for the Keyfall mic. It only ever sees the voice:
// the piano joins the mix after it, so nothing Keyfall plays is touched.
//
// The voice is split into narrow bands (an FFT every 2.7 ms). In each band it learns how loud the
// room is (fans, hiss, hum: whatever stays put while the voice comes and goes) and turns the band
// down when it holds nothing more than that. It runs one FFT frame behind the voice (about 11 ms).
// The work is in Denoiser so it can be tested outside an AudioWorklet.

class Denoiser {
  constructor(sr) {
    this.sr = sr
    const N = sr > 60000 ? 1024 : 512
    this.N = N
    this.H = N >> 2
    this.mask = N - 1
    this.bins = (N >> 1) + 1
    // root-Hann going in and coming out: the overlapping frames add back up to the voice
    this.win = new Float32Array(N)
    for (let i = 0; i < N; i++) this.win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N))
    this.cos = new Float32Array(N >> 1)
    this.sin = new Float32Array(N >> 1)
    for (let i = 0; i < N >> 1; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / N)
      this.sin[i] = Math.sin((2 * Math.PI * i) / N)
    }
    this.rev = new Uint16Array(N)
    const bits = Math.log2(N)
    for (let i = 0; i < N; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.rev[i] = r
    }
    this.inBuf = new Float32Array(N)
    this.outBuf = new Float32Array(N)
    this.re = new Float32Array(N)
    this.im = new Float32Array(N)
    // each band's level: `fast` for deciding how much to let through, `slow` for learning the room
    this.fast = new Float32Array(this.bins)
    this.slow = new Float32Array(this.bins)
    this.noise = new Float32Array(this.bins)
    this.raw = new Float32Array(this.bins)
    this.gain = new Float32Array(this.bins)
    const hopSec = this.H / sr
    this.slowA = 1 - Math.exp(-hopSec / 0.05)
    // the room's level creeps up slowly (a held note mustn't be learnt as noise) and drops at once
    this.rise = Math.exp(hopSec / 3)
    this.learn = Math.round(0.4 / hopSec)
    this.up = 1 - Math.exp(-hopSec / 0.004)
    this.down = 1 - Math.exp(-hopSec / 0.05)
    this.amount = 0
    this.reset()
  }

  reset() {
    this.pos = 0
    this.frames = 0
    this.inBuf.fill(0)
    this.outBuf.fill(0)
    this.gain.fill(1)
  }

  /** 0 = off (the voice passes straight through, with no delay); up to 1 = strongest. */
  set(amount) {
    const a = Math.max(0, Math.min(1, Number(amount) || 0))
    if (a > 0 && this.amount === 0) this.reset()
    this.amount = a
  }

  fft(re, im, inverse) {
    const N = this.N
    const rev = this.rev
    for (let i = 0; i < N; i++) {
      const j = rev[i]
      if (j > i) {
        let t = re[i]
        re[i] = re[j]
        re[j] = t
        t = im[i]
        im[i] = im[j]
        im[j] = t
      }
    }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1
      const step = N / size
      for (let s = 0; s < N; s += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step]
          const wi = inverse ? this.sin[k * step] : -this.sin[k * step]
          const a = s + k
          const b = a + half
          const tr = re[b] * wr - im[b] * wi
          const ti = re[b] * wi + im[b] * wr
          re[b] = re[a] - tr
          im[b] = im[a] - ti
          re[a] += tr
          im[a] += ti
        }
      }
    }
  }

  frame() {
    const { N, mask, bins, re, im, win, fast, slow, noise, raw, gain } = this
    const at = this.pos
    for (let i = 0; i < N; i++) {
      re[i] = this.inBuf[(at + i) & mask] * win[i]
      im[i] = 0
    }
    this.fft(re, im, false)
    const first = this.frames === 0
    const learning = this.frames < this.learn
    this.frames++
    const a = this.amount
    // how far above the room a band has to be before it counts as voice, and how far down the rest goes
    const over = 2 + 4 * a
    const floor = Math.pow(10, -(8 + 28 * a) / 20)
    for (let k = 0; k < bins; k++) {
      const p = re[k] * re[k] + im[k] * im[k]
      if (first) {
        fast[k] = slow[k] = noise[k] = p
      } else {
        fast[k] += (p - fast[k]) * 0.5
        slow[k] += (p - slow[k]) * this.slowA
        if (learning) noise[k] += (slow[k] - noise[k]) * 0.1
        else if (slow[k] < noise[k]) noise[k] += (slow[k] - noise[k]) * 0.2
        else noise[k] *= this.rise
      }
      if (noise[k] < 1e-14) noise[k] = 1e-14
      const g = 1 - (over * noise[k]) / Math.max(fast[k], 1e-20)
      raw[k] = g > 0 ? Math.sqrt(g) : 0
    }
    for (let k = 0; k < bins; k++) {
      // a band opens with its neighbours (no lone chirps), fast; it closes slowly, so word endings aren't clipped
      const lo = raw[k > 0 ? k - 1 : k]
      const hi = raw[k < bins - 1 ? k + 1 : k]
      const want = Math.max(floor, 0.25 * lo + 0.5 * raw[k] + 0.25 * hi)
      gain[k] += (want - gain[k]) * (want > gain[k] ? this.up : this.down)
      const g = gain[k]
      re[k] *= g
      im[k] *= g
      if (k > 0 && k < bins - 1) {
        re[N - k] *= g
        im[N - k] *= g
      }
    }
    this.fft(re, im, true)
    // 1/N for the inverse transform, 1/2 for the four overlapping windows
    const scale = 0.5 / N
    for (let i = 0; i < N; i++) this.outBuf[(at + i) & mask] += re[i] * win[i] * scale
  }

  process(input, output) {
    const n = output.length
    if (!(this.amount > 0)) {
      for (let i = 0; i < n; i++) output[i] = input ? input[i] : 0
      return
    }
    const mask = this.mask
    for (let i = 0; i < n; i++) {
      const j = this.pos & mask
      output[i] = this.outBuf[j]
      this.outBuf[j] = 0
      this.inBuf[j] = input ? input[i] : 0
      this.pos++
      if (this.pos % this.H === 0) this.frame()
    }
  }
}

if (typeof AudioWorkletProcessor !== 'undefined') {
  class KeyfallDenoise extends AudioWorkletProcessor {
    constructor(options) {
      super()
      const o = (options && options.processorOptions) || {}
      this.denoiser = new Denoiser(sampleRate)
      this.denoiser.set(o.amount)
      this.port.onmessage = (e) => this.denoiser.set(e.data && e.data.amount)
    }

    process(inputs, outputs) {
      const out = outputs[0] && outputs[0][0]
      if (!out) return true
      this.denoiser.process(inputs[0] && inputs[0][0], out)
      return true
    }
  }
  registerProcessor('keyfall-denoise', KeyfallDenoise)
}

if (typeof module !== 'undefined') module.exports = { Denoiser }

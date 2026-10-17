/**
 * Mixed-radix FFT for sizes made of 2s, 3s and 5s (2048 for analysis, 7680 for the vocal
 * separator). Plans are cached per size. Works in place on separate real/imaginary arrays.
 */

interface Plan {
  n: number
  factors: number[]
  /** cos/sin of -2πk/n */
  cos: Float64Array
  sin: Float64Array
  /** input index for each output slot after the digit-reversal permutation */
  perm: Int32Array
}

const plans = new Map<number, Plan>()

function factor(n: number): number[] {
  const out: number[] = []
  for (const f of [4, 2, 3, 5]) {
    while (n % f === 0 && !(f === 4 && n % 4 !== 0)) {
      out.push(f)
      n /= f
    }
  }
  if (n !== 1) throw new Error(`FFT size must be made of 2, 3 and 5 (left ${n})`)
  return out
}

function plan(n: number): Plan {
  let p = plans.get(n)
  if (p) return p
  const factors = factor(n)
  const cos = new Float64Array(n)
  const sin = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    cos[k] = Math.cos((-2 * Math.PI * k) / n)
    sin[k] = Math.sin((-2 * Math.PI * k) / n)
  }
  // mixed-radix digit reversal
  const perm = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    let rest = i
    let rev = 0
    let scale = n
    for (const f of factors) {
      scale /= f
      rev += (rest % f) * scale
      rest = Math.floor(rest / f)
    }
    perm[i] = rev
  }
  p = { n, factors, cos, sin, perm }
  plans.set(n, p)
  return p
}

/** Forward FFT in place (inverse = true gives the unscaled inverse). */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length
  const p = plan(n)
  const tr = new Float64Array(n)
  const ti = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    tr[p.perm[i]] = re[i]
    ti[p.perm[i]] = inverse ? -im[i] : im[i]
  }
  // butterflies, smallest stage first (the reverse order of the digit reversal)
  let len = 1
  for (let s = p.factors.length - 1; s >= 0; s--) {
    const f = p.factors[s]
    const span = len * f
    const step = n / span
    for (let start = 0; start < n; start += span) {
      for (let k = 0; k < len; k++) {
        // gather the f inputs, twiddled
        const xr = [0, 0, 0, 0, 0]
        const xi = [0, 0, 0, 0, 0]
        for (let j = 0; j < f; j++) {
          const idx = start + k + j * len
          const w = (j * k * step) % n
          const a = tr[idx]
          const b = ti[idx]
          xr[j] = a * p.cos[w] - b * p.sin[w]
          xi[j] = a * p.sin[w] + b * p.cos[w]
        }
        // small DFT of size f
        for (let m = 0; m < f; m++) {
          let sr = 0
          let si = 0
          for (let j = 0; j < f; j++) {
            const w = ((j * m * n) / f) % n
            sr += xr[j] * p.cos[w] - xi[j] * p.sin[w]
            si += xr[j] * p.sin[w] + xi[j] * p.cos[w]
          }
          const out = start + k + m * len
          tr[out] = sr
          ti[out] = si
        }
      }
    }
    len = span
  }
  for (let i = 0; i < n; i++) {
    re[i] = tr[i]
    im[i] = inverse ? -ti[i] : ti[i]
  }
}

export function hann(n: number, periodic = true): Float64Array {
  const w = new Float64Array(n)
  const d = periodic ? n : n - 1
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / d)
  return w
}

/** Magnitude spectrogram: frames × (n/2+1) bins, hop samples apart, frames centred on hop multiples. */
export function magnitudes(x: Float32Array, n: number, hop: number): Float32Array[] {
  const win = hann(n)
  const frames = Math.floor(x.length / hop) + 1
  const out: Float32Array[] = []
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const half = n / 2
  for (let f = 0; f < frames; f++) {
    const start = f * hop - half
    for (let i = 0; i < n; i++) {
      const j = start + i
      re[i] = j >= 0 && j < x.length ? x[j] * win[i] : 0
      im[i] = 0
    }
    fft(re, im)
    const mag = new Float32Array(half + 1)
    for (let k = 0; k <= half; k++) mag[k] = Math.hypot(re[k], im[k])
    out.push(mag)
  }
  return out
}

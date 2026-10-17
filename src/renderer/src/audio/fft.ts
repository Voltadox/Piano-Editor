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

const scratch = new Map<number, { tr: Float64Array; ti: Float64Array }>()
const xr = new Float64Array(5)
const xi = new Float64Array(5)

/** Forward FFT in place (inverse = true gives the unscaled inverse). */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length
  const p = plan(n)
  let buf = scratch.get(n)
  if (!buf) scratch.set(n, (buf = { tr: new Float64Array(n), ti: new Float64Array(n) }))
  const { tr, ti } = buf
  const cos = p.cos
  const sin = p.sin
  const perm = p.perm
  for (let i = 0; i < n; i++) {
    tr[perm[i]] = re[i]
    ti[perm[i]] = inverse ? -im[i] : im[i]
  }
  // butterflies, smallest stage first (the reverse order of the digit reversal)
  let len = 1
  for (let s = p.factors.length - 1; s >= 0; s--) {
    const f = p.factors[s]
    const span = len * f
    const step = n / span
    const rootStep = n / f
    for (let start = 0; start < n; start += span) {
      for (let k = 0; k < len; k++) {
        // gather the f inputs, twiddled
        const base = start + k
        const wk = k * step
        for (let j = 0; j < f; j++) {
          const idx = base + j * len
          const w = (j * wk) % n
          const a = tr[idx]
          const b = ti[idx]
          const c = cos[w]
          const d = sin[w]
          xr[j] = a * c - b * d
          xi[j] = a * d + b * c
        }
        if (f === 2) {
          tr[base] = xr[0] + xr[1]
          ti[base] = xi[0] + xi[1]
          tr[base + len] = xr[0] - xr[1]
          ti[base + len] = xi[0] - xi[1]
          continue
        }
        if (f === 4) {
          const ar = xr[0] + xr[2]
          const ai = xi[0] + xi[2]
          const br = xr[0] - xr[2]
          const bi = xi[0] - xi[2]
          const cr = xr[1] + xr[3]
          const ci = xi[1] + xi[3]
          const dr = xr[1] - xr[3]
          const di = xi[1] - xi[3]
          tr[base] = ar + cr
          ti[base] = ai + ci
          tr[base + len] = br + di
          ti[base + len] = bi - dr
          tr[base + 2 * len] = ar - cr
          ti[base + 2 * len] = ai - ci
          tr[base + 3 * len] = br - di
          ti[base + 3 * len] = bi + dr
          continue
        }
        // small DFT of size f (3 or 5)
        for (let m = 0; m < f; m++) {
          let sr = 0
          let si = 0
          for (let j = 0; j < f; j++) {
            const w = (j * m * rootStep) % n
            sr += xr[j] * cos[w] - xi[j] * sin[w]
            si += xr[j] * sin[w] + xi[j] * cos[w]
          }
          tr[base + m * len] = sr
          ti[base + m * len] = si
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

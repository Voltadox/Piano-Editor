import { InferenceSession, Tensor } from 'onnxruntime-node'
import { fft, hann } from '../renderer/src/audio/fft'

/**
 * Source separation with MDX-Net models (UVR's Kim_Vocal_2 and the KUIELab MDX models for drums
 * and bass, MIT licence). The song is cut into chunks, each turned into the spectrogram layout the
 * model was trained on (left and right real/imaginary as four channels, the lowest `dimF` bins),
 * and the spectrogram it predicts for its stem is turned back into audio. Input and output are
 * stereo at 44.1 kHz.
 */

export interface MdxLayout {
  nFft: number
  dimF: number
  dimT: number
  /** level correction the model needs (from UVR's model table) */
  compensate: number
}

/** The layouts, as listed in UVR's model table for each file. */
export const LAYOUTS = {
  vocals: { nFft: 7680, dimF: 3072, dimT: 256, compensate: 1.009 },
  drums: { nFft: 4096, dimF: 2048, dimT: 512, compensate: 1.035 },
  bass: { nFft: 16384, dimF: 2048, dimT: 512, compensate: 1.035 }
} satisfies Record<string, MdxLayout>

const HOP = 1024
export const SEPARATION_RATE = 44100

/** Reflect-pads a signal by `pad` on each side (as torch.stft's center=True does). */
function reflect(x: Float32Array, pad: number): Float32Array {
  const out = new Float32Array(x.length + 2 * pad)
  out.set(x, pad)
  for (let i = 0; i < pad; i++) {
    out[pad - 1 - i] = x[Math.min(x.length - 1, i + 1)]
    out[pad + x.length + i] = x[Math.max(0, x.length - 2 - i)]
  }
  return out
}

/** Both channels' spectrograms in the model's input layout. Left and right share one complex FFT. */
function toSpec(l: Float32Array, r: Float32Array, m: MdxLayout, win: Float64Array): Float32Array {
  const { nFft, dimF, dimT } = m
  const lp = reflect(l, nFft / 2)
  const rp = reflect(r, nFft / 2)
  const spec = new Float32Array(4 * dimF * dimT)
  const re = new Float64Array(nFft)
  const im = new Float64Array(nFft)
  const at = (c: number, f: number, t: number): number => (c * dimF + f) * dimT + t
  for (let t = 0; t < dimT; t++) {
    const s = t * HOP
    for (let i = 0; i < nFft; i++) {
      re[i] = lp[s + i] * win[i]
      im[i] = rp[s + i] * win[i]
    }
    fft(re, im)
    for (let k = 0; k < dimF; k++) {
      const j = k === 0 ? 0 : nFft - k
      // unpack two real signals from one complex transform
      spec[at(0, k, t)] = (re[k] + re[j]) / 2
      spec[at(1, k, t)] = (im[k] - im[j]) / 2
      spec[at(2, k, t)] = (im[k] + im[j]) / 2
      spec[at(3, k, t)] = (re[j] - re[k]) / 2
    }
  }
  return spec
}

/** Inverse of toSpec: overlap-add with the squared-window normalisation torch.istft uses. */
function fromSpec(spec: Float32Array, m: MdxLayout, win: Float64Array): [Float32Array, Float32Array] {
  const { nFft, dimF, dimT } = m
  const chunk = HOP * (dimT - 1)
  const len = chunk + nFft
  const ol = new Float64Array(len)
  const or = new Float64Array(len)
  const norm = new Float64Array(len)
  const re = new Float64Array(nFft)
  const im = new Float64Array(nFft)
  const at = (c: number, f: number, t: number): number => (c * dimF + f) * dimT + t
  for (let t = 0; t < dimT; t++) {
    re.fill(0)
    im.fill(0)
    // Z = L + iR, with each real signal's spectrum made Hermitian (bins above dimF stay zero)
    for (let k = 0; k < dimF; k++) {
      const lr = spec[at(0, k, t)]
      const li = spec[at(1, k, t)]
      const rr = spec[at(2, k, t)]
      const ri = spec[at(3, k, t)]
      re[k] = lr - ri
      im[k] = li + rr
      if (k > 0) {
        const j = nFft - k
        re[j] = lr + ri
        im[j] = rr - li
      }
    }
    fft(re, im, true)
    const s = t * HOP
    for (let i = 0; i < nFft; i++) {
      const w = win[i]
      ol[s + i] += (re[i] / nFft) * w
      or[s + i] += (im[i] / nFft) * w
      norm[s + i] += w * w
    }
  }
  const l = new Float32Array(chunk)
  const r = new Float32Array(chunk)
  for (let i = 0; i < chunk; i++) {
    const n = norm[i + nFft / 2]
    l[i] = n > 1e-8 ? ol[i + nFft / 2] / n : 0
    r[i] = n > 1e-8 ? or[i + nFft / 2] / n : 0
  }
  return [l, r]
}

const sessions = new Map<string, InferenceSession>()

async function getSession(modelPath: string): Promise<InferenceSession> {
  let session = sessions.get(modelPath)
  if (session) return session
  try {
    // the graphics card (DirectML) is about twice as fast; fall back to the CPU
    session = await InferenceSession.create(modelPath, { executionProviders: ['dml', 'cpu'], graphOptimizationLevel: 'all' })
  } catch {
    session = await InferenceSession.create(modelPath, { executionProviders: ['cpu'], graphOptimizationLevel: 'all' })
  }
  sessions.set(modelPath, session)
  return session
}

/** Separates one stem (vocals, drums or bass, by the model) from a stereo song at 44.1 kHz. */
export async function separateStem(
  left: Float32Array,
  right: Float32Array,
  modelPath: string,
  m: MdxLayout,
  progress: (p: number) => void
): Promise<{ left: Float32Array; right: Float32Array }> {
  const s = await getSession(modelPath)
  const win = hann(m.nFft)
  const chunk = HOP * (m.dimT - 1)
  const trim = m.nFft / 2
  const gen = chunk - 2 * trim
  const n = left.length
  // like UVR, keep the mix's peak at or below 0.9 (the level the model was trained on), then undo it
  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]))
  const gain = peak > 0.9 ? 0.9 / peak : 1
  const pad = gen - (n % gen)
  const total = trim + n + pad + trim
  const lp = new Float32Array(total)
  const rp = new Float32Array(total)
  for (let i = 0; i < n; i++) {
    lp[trim + i] = left[i] * gain
    rp[trim + i] = right[i] * gain
  }
  const outL = new Float32Array(n + pad)
  const outR = new Float32Array(n + pad)
  const chunks = (n + pad) / gen
  for (let c = 0; c < chunks; c++) {
    const from = c * gen
    const spec = toSpec(lp.subarray(from, from + chunk), rp.subarray(from, from + chunk), m, win)
    const result = await s.run({ [s.inputNames[0]]: new Tensor('float32', spec, [1, 4, m.dimF, m.dimT]) })
    const [vl, vr] = fromSpec(result[s.outputNames[0]].data as Float32Array, m, win)
    outL.set(vl.subarray(trim, trim + gen), from)
    outR.set(vr.subarray(trim, trim + gen), from)
    progress((c + 1) / chunks)
  }
  const l = outL.subarray(0, n)
  const r = outR.subarray(0, n)
  for (let i = 0; i < n; i++) {
    l[i] *= m.compensate / gain
    r[i] *= m.compensate / gain
  }
  return { left: l.slice(), right: r.slice() }
}

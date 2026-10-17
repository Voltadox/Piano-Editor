import { InferenceSession, Tensor } from 'onnxruntime-node'
import { fft, hann } from '../renderer/src/audio/fft'

/**
 * Vocal separation with an MDX-Net model (UVR's Kim_Vocal_2, MIT licence). The song is cut into
 * chunks, each turned into the spectrogram layout the model was trained on (STFT 7680/1024,
 * 3072 bins × 256 frames, left and right real/imaginary as four channels), and the vocal
 * spectrogram it predicts is turned back into audio. Input and output are stereo at 44.1 kHz.
 */

const N_FFT = 7680
const HOP = 1024
const DIM_F = 3072
const DIM_T = 256
const COMPENSATE = 1.009
const CHUNK = HOP * (DIM_T - 1)
const TRIM = N_FFT / 2
const GEN = CHUNK - 2 * TRIM
export const SEPARATION_RATE = 44100

const win = hann(N_FFT)

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
function toSpec(l: Float32Array, r: Float32Array): Float32Array {
  const lp = reflect(l, N_FFT / 2)
  const rp = reflect(r, N_FFT / 2)
  const spec = new Float32Array(4 * DIM_F * DIM_T)
  const re = new Float64Array(N_FFT)
  const im = new Float64Array(N_FFT)
  const at = (c: number, f: number, t: number): number => (c * DIM_F + f) * DIM_T + t
  for (let t = 0; t < DIM_T; t++) {
    const s = t * HOP
    for (let i = 0; i < N_FFT; i++) {
      re[i] = lp[s + i] * win[i]
      im[i] = rp[s + i] * win[i]
    }
    fft(re, im)
    for (let k = 0; k < DIM_F; k++) {
      const j = k === 0 ? 0 : N_FFT - k
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
function fromSpec(spec: Float32Array): [Float32Array, Float32Array] {
  const len = CHUNK + N_FFT
  const ol = new Float64Array(len)
  const or = new Float64Array(len)
  const norm = new Float64Array(len)
  const re = new Float64Array(N_FFT)
  const im = new Float64Array(N_FFT)
  const at = (c: number, f: number, t: number): number => (c * DIM_F + f) * DIM_T + t
  for (let t = 0; t < DIM_T; t++) {
    re.fill(0)
    im.fill(0)
    // Z = L + iR, with each real signal's spectrum made Hermitian (bins above DIM_F stay zero)
    for (let k = 0; k < DIM_F; k++) {
      const lr = spec[at(0, k, t)]
      const li = spec[at(1, k, t)]
      const rr = spec[at(2, k, t)]
      const ri = spec[at(3, k, t)]
      re[k] = lr - ri
      im[k] = li + rr
      if (k > 0) {
        const j = N_FFT - k
        re[j] = lr + ri
        im[j] = rr - li
      }
    }
    fft(re, im, true)
    const s = t * HOP
    for (let i = 0; i < N_FFT; i++) {
      const w = win[i]
      ol[s + i] += (re[i] / N_FFT) * w
      or[s + i] += (im[i] / N_FFT) * w
      norm[s + i] += w * w
    }
  }
  const l = new Float32Array(CHUNK)
  const r = new Float32Array(CHUNK)
  for (let i = 0; i < CHUNK; i++) {
    const n = norm[i + N_FFT / 2]
    l[i] = n > 1e-8 ? ol[i + N_FFT / 2] / n : 0
    r[i] = n > 1e-8 ? or[i + N_FFT / 2] / n : 0
  }
  return [l, r]
}

let session: InferenceSession | null = null
let sessionPath = ''

async function getSession(modelPath: string): Promise<InferenceSession> {
  if (session && sessionPath === modelPath) return session
  try {
    // the graphics card (DirectML) is about twice as fast; fall back to the CPU
    session = await InferenceSession.create(modelPath, { executionProviders: ['dml', 'cpu'], graphOptimizationLevel: 'all' })
  } catch {
    session = await InferenceSession.create(modelPath, { executionProviders: ['cpu'], graphOptimizationLevel: 'all' })
  }
  sessionPath = modelPath
  return session
}

/** Separates the vocals from a stereo song at 44.1 kHz. */
export async function separateVocals(
  left: Float32Array,
  right: Float32Array,
  modelPath: string,
  progress: (p: number) => void
): Promise<{ left: Float32Array; right: Float32Array }> {
  const s = await getSession(modelPath)
  const n = left.length
  // like UVR, keep the mix's peak at or below 0.9 (the level the model was trained on), then undo it
  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]))
  const gain = peak > 0.9 ? 0.9 / peak : 1
  const pad = GEN - (n % GEN)
  const total = TRIM + n + pad + TRIM
  const lp = new Float32Array(total)
  const rp = new Float32Array(total)
  for (let i = 0; i < n; i++) {
    lp[TRIM + i] = left[i] * gain
    rp[TRIM + i] = right[i] * gain
  }
  const outL = new Float32Array(n + pad)
  const outR = new Float32Array(n + pad)
  const chunks = (n + pad) / GEN
  for (let c = 0; c < chunks; c++) {
    const from = c * GEN
    const spec = toSpec(lp.subarray(from, from + CHUNK), rp.subarray(from, from + CHUNK))
    const result = await s.run({ [s.inputNames[0]]: new Tensor('float32', spec, [1, 4, DIM_F, DIM_T]) })
    const [vl, vr] = fromSpec(result[s.outputNames[0]].data as Float32Array)
    outL.set(vl.subarray(TRIM, TRIM + GEN), from)
    outR.set(vr.subarray(TRIM, TRIM + GEN), from)
    progress((c + 1) / chunks)
  }
  const l = outL.subarray(0, n)
  const r = outR.subarray(0, n)
  for (let i = 0; i < n; i++) {
    l[i] *= COMPENSATE / gain
    r[i] *= COMPENSATE / gain
  }
  return { left: l.slice(), right: r.slice() }
}

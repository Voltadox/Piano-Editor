import { InferenceSession, Tensor } from 'onnxruntime-node'

/**
 * Polyphonic note transcription with Spotify's Basic Pitch (Apache 2.0): finds every note in a
 * recording, including several at once. Used on the separated vocal to find harmony lines.
 * Window layout and note extraction follow the reference implementation's defaults.
 */

export const TRANSCRIBE_RATE = 22050
const FFT_HOP = 256
const AUDIO_N_SAMPLES = 2 * TRANSCRIBE_RATE - FFT_HOP
const FRAMES_PER_WINDOW = 172
const N_OVERLAP = 30
const OVERLAP_LEN = N_OVERLAP * FFT_HOP
const HOP = AUDIO_N_SAMPLES - OVERLAP_LEN
const KEEP = FRAMES_PER_WINDOW - N_OVERLAP
const PITCHES = 88

const ONSET_THRESH = 0.5
const FRAME_THRESH = 0.3
const MIN_NOTE = 11
const ENERGY_TOL = 11

export interface Transcribed {
  start: number
  end: number
  pitch: number
  amp: number
}

let session: InferenceSession | null = null

async function getSession(path: string): Promise<InferenceSession> {
  session ??= await InferenceSession.create(path, { executionProviders: ['cpu'] })
  return session
}

export async function transcribe(pcm: Float32Array, modelPath: string): Promise<Transcribed[]> {
  const s = await getSession(modelPath)
  const padded = new Float32Array(OVERLAP_LEN / 2 + pcm.length)
  padded.set(pcm, OVERLAP_LEN / 2)
  const windows = Math.ceil(padded.length / HOP)
  const totalFrames = windows * KEEP
  const notes = new Float32Array(totalFrames * PITCHES)
  const onsets = new Float32Array(totalFrames * PITCHES)
  const frameTime = new Float64Array(totalFrames)
  const input = new Float32Array(AUDIO_N_SAMPLES)
  for (let w = 0; w < windows; w++) {
    input.fill(0)
    input.set(padded.subarray(w * HOP, w * HOP + AUDIO_N_SAMPLES))
    const out = await s.run({ [s.inputNames[0]]: new Tensor('float32', input, [1, AUDIO_N_SAMPLES, 1]) })
    const note = out['StatefulPartitionedCall:1'].data as Float32Array
    const onset = out['StatefulPartitionedCall:2'].data as Float32Array
    // keep the middle of each window; time every frame exactly from where its window started
    for (let k = 0; k < KEEP; k++) {
      const local = k + N_OVERLAP / 2
      const f = w * KEEP + k
      notes.set(note.subarray(local * PITCHES, (local + 1) * PITCHES), f * PITCHES)
      onsets.set(onset.subarray(local * PITCHES, (local + 1) * PITCHES), f * PITCHES)
      frameTime[f] = (w * HOP + local * FFT_HOP - OVERLAP_LEN / 2) / TRANSCRIBE_RATE
    }
  }
  const n = Math.min(totalFrames, Math.floor((pcm.length / TRANSCRIBE_RATE) * (TRANSCRIBE_RATE / FFT_HOP)))
  return extractNotes(notes, onsets, n).map((e) => ({ start: Math.max(0, frameTime[e.from]), end: frameTime[Math.min(n - 1, e.to)], pitch: e.key + 21, amp: e.amp }))
}

/** Basic Pitch's note extraction: onset peaks extended while the note stays on, then leftover energy. */
function extractNotes(frames: Float32Array, onsetsIn: Float32Array, n: number): { from: number; to: number; key: number; amp: number }[] {
  const at = (t: number, p: number): number => t * PITCHES + p
  // onsets inferred from sudden rises in the note map, scaled to the onset map, take the larger
  const onsets = new Float32Array(n * PITCHES)
  let maxOnset = 0
  let maxDiff = 0
  const diff = new Float32Array(n * PITCHES)
  for (let t = 0; t < n; t++)
    for (let p = 0; p < PITCHES; p++) {
      maxOnset = Math.max(maxOnset, onsetsIn[at(t, p)])
      if (t < 2) continue
      const d = Math.max(0, Math.min(frames[at(t, p)] - frames[at(t - 1, p)], frames[at(t, p)] - frames[at(t - 2, p)]))
      diff[at(t, p)] = d
      maxDiff = Math.max(maxDiff, d)
    }
  for (let i = 0; i < n * PITCHES; i++) onsets[i] = Math.max(onsetsIn[i], maxDiff > 0 ? (maxOnset * diff[i]) / maxDiff : 0)

  const starts: { t: number; p: number }[] = []
  for (let t = 1; t < n - 1; t++)
    for (let p = 0; p < PITCHES; p++) {
      const v = onsets[at(t, p)]
      if (v >= ONSET_THRESH && v > onsets[at(t - 1, p)] && v > onsets[at(t + 1, p)]) starts.push({ t, p })
    }
  starts.sort((a, b) => b.t - a.t)

  const energy = frames.slice(0, n * PITCHES)
  const out: { from: number; to: number; key: number; amp: number }[] = []
  const clear = (from: number, to: number, p: number): void => {
    for (let t = from; t < to; t++)
      for (const q of [p - 1, p, p + 1]) if (q >= 0 && q < PITCHES) energy[at(t, q)] = 0
  }
  const mean = (from: number, to: number, p: number): number => {
    let s = 0
    for (let t = from; t < to; t++) s += frames[at(t, p)]
    return s / Math.max(1, to - from)
  }
  for (const { t: start, p } of starts) {
    if (start >= n - 1) continue
    let i = start + 1
    let k = 0
    while (i < n - 1 && k < ENERGY_TOL) {
      k = energy[at(i, p)] < FRAME_THRESH ? k + 1 : 0
      i++
    }
    i -= k
    if (i - start <= MIN_NOTE) continue
    clear(start, i, p)
    out.push({ from: start, to: i, key: p, amp: mean(start, i, p) })
  }
  // the "melodia trick": notes with no clear onset, grown out from the strongest leftover energy
  for (;;) {
    let best = -1
    let bestV = FRAME_THRESH
    for (let i = 0; i < n * PITCHES; i++)
      if (energy[i] > bestV) {
        bestV = energy[i]
        best = i
      }
    if (best < 0) break
    const mid = Math.floor(best / PITCHES)
    const p = best % PITCHES
    energy[best] = 0
    let i = mid + 1
    let k = 0
    while (i < n - 1 && k < ENERGY_TOL) {
      k = energy[at(i, p)] < FRAME_THRESH ? k + 1 : 0
      clear(i, i + 1, p)
      i++
    }
    const end = i - 1 - k
    i = mid - 1
    k = 0
    while (i > 0 && k < ENERGY_TOL) {
      k = energy[at(i, p)] < FRAME_THRESH ? k + 1 : 0
      clear(i, i + 1, p)
      i--
    }
    const begin = i + 1 + k
    if (end - begin <= MIN_NOTE) continue
    out.push({ from: begin, to: end, key: p, amp: mean(begin, end, p) })
  }
  return out.sort((a, b) => a.from - b.from || a.key - b.key)
}

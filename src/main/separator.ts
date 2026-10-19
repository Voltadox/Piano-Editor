import { LAYOUTS, separateStem } from './separate'
import { transcribe } from './transcribe'

/**
 * Runs separation (vocals, drums or bass) in its own utility process, so the model's heavy work
 * never stalls the app's main process. Receives a stereo song, reports progress, and sends back
 * the stem.
 */

interface Job {
  id: number
  kind?: 'separate' | 'transcribe' | 'lyrics'
  left: Float32Array
  right: Float32Array
  modelPath: string
  /** which model's spectrogram layout to use for a separation */
  layout?: keyof typeof LAYOUTS
}

type Asr = (audio: Float32Array, opts: object) => Promise<{ chunks?: { timestamp: [number, number | null]; text: string }[] }>
let asr: Asr | null = null

/**
 * Lyrics from a separated vocal with Whisper (base, English) through Transformers.js on the same
 * ONNX Runtime. The model is downloaded into `cacheDir` the first time. Returns timed phrases.
 */
async function lyrics(id: number, pcm16k: Float32Array, cacheDir: string): Promise<{ start: number; end: number; text: string }[]> {
  if (!asr) {
    const T = await import('@huggingface/transformers')
    T.env.cacheDir = cacheDir
    T.env.allowLocalModels = false
    const loading = new Map<string, { loaded: number; total: number }>()
    asr = (await T.pipeline('automatic-speech-recognition', 'onnx-community/whisper-base.en', {
      dtype: 'q8',
      device: 'cpu',
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status !== 'progress' || !p.file) return
        loading.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 })
        let loaded = 0
        let total = 0
        for (const v of loading.values()) {
          loaded += v.loaded
          total += v.total
        }
        if (total > 0) process.parentPort.postMessage({ id, type: 'progress', value: (0.8 * loaded) / total })
      }
    })) as unknown as Asr
  }
  process.parentPort.postMessage({ id, type: 'progress', value: 0.85 })
  const res = await asr(pcm16k, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true })
  return (res.chunks ?? [])
    .map((c) => ({ start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? (c.timestamp[0] ?? 0) + 3, text: c.text.trim() }))
    .filter((c) => c.text.length > 0)
}

process.parentPort.on('message', (e: Electron.MessageEvent) => {
  const job = e.data as Job
  if (job.kind === 'lyrics') {
    lyrics(job.id, job.left, job.modelPath)
      .then((lines) => process.parentPort.postMessage({ id: job.id, type: 'done', notes: lines }))
      .catch((err: unknown) => process.parentPort.postMessage({ id: job.id, type: 'error', message: err instanceof Error ? err.message : String(err) }))
    return
  }
  if (job.kind === 'transcribe') {
    transcribe(job.left, job.modelPath)
      .then((notes) => process.parentPort.postMessage({ id: job.id, type: 'done', notes }))
      .catch((err: unknown) => process.parentPort.postMessage({ id: job.id, type: 'error', message: err instanceof Error ? err.message : String(err) }))
    return
  }
  separateStem(job.left, job.right, job.modelPath, LAYOUTS[job.layout ?? 'vocals'], (value) => process.parentPort.postMessage({ id: job.id, type: 'progress', value }))
    .then((out) => process.parentPort.postMessage({ id: job.id, type: 'done', left: out.left, right: out.right }))
    .catch((err: unknown) => process.parentPort.postMessage({ id: job.id, type: 'error', message: err instanceof Error ? err.message : String(err) }))
})

import { separateVocals } from './separate'

/**
 * Runs vocal separation in its own utility process, so the model's heavy work never stalls the
 * app's main process. Receives a stereo song, reports progress, and sends back the vocals.
 */

interface Job {
  id: number
  left: Float32Array
  right: Float32Array
  modelPath: string
}

process.parentPort.on('message', (e: Electron.MessageEvent) => {
  const job = e.data as Job
  separateVocals(job.left, job.right, job.modelPath, (value) => process.parentPort.postMessage({ id: job.id, type: 'progress', value }))
    .then((out) => process.parentPort.postMessage({ id: job.id, type: 'done', left: out.left, right: out.right }))
    .catch((err: unknown) => process.parentPort.postMessage({ id: job.id, type: 'error', message: err instanceof Error ? err.message : String(err) }))
})

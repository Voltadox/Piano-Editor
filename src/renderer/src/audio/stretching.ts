import StretchWorker from './stretch.worker?worker'

let worker: Worker | null = null
let nextId = 1
const waiting = new Map<number, (out: Float32Array[]) => void>()

/** Time-stretches audio (one or two channels) to play at `rate` speed with the same pitch, off the main thread. */
export function stretchAudio(channels: Float32Array[], rate: number, sr: number): Promise<Float32Array[]> {
  if (!worker) {
    worker = new StretchWorker()
    worker.onmessage = (e: MessageEvent<{ id: number; channels: Float32Array[] }>) => {
      waiting.get(e.data.id)?.(e.data.channels)
      waiting.delete(e.data.id)
    }
  }
  const id = nextId++
  return new Promise((resolve) => {
    waiting.set(id, resolve)
    worker!.postMessage({ id, channels, rate, sr })
  })
}

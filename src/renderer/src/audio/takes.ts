import { decodeWavMono, encodeWavMono } from './wav'

/** A recorded pass of audio. Takes are referenced by id from songs and live outside undo history. */
export interface TakeData {
  pcm: Float32Array
  rate: number
}

const pool = new Map<string, TakeData>()
const loading = new Map<string, Promise<TakeData | null>>()

/** Keeps a new take and writes it to disk straight away, so a crash can't lose it. */
export function addTake(pcm: Float32Array, rate: number): string {
  const id = crypto.randomUUID()
  pool.set(id, { pcm, rate })
  void window.keyfall.takeWrite(id, encodeWavMono(pcm, rate))
  return id
}

/** Adds a take with a known id (from a project file), saving it for crash recovery too. */
export function putTake(id: string, data: TakeData): void {
  pool.set(id, data)
  void window.keyfall.takeWrite(id, encodeWavMono(data.pcm, data.rate))
}

export const getTake = (id: string): TakeData | undefined => pool.get(id)

/** Makes sure takes are in memory, reading any that are only on disk. Returns the ids that couldn't be found. */
export async function ensureTakes(ids: string[]): Promise<string[]> {
  const missing: string[] = []
  await Promise.all(
    ids.map(async (id) => {
      if (pool.has(id)) return
      const p =
        loading.get(id) ??
        window.keyfall.takeRead(id).then((bytes) => {
          if (!bytes) return null
          const data = decodeWavMono(bytes)
          pool.set(id, data)
          return data
        })
      loading.set(id, p)
      if (!(await p)) missing.push(id)
    })
  )
  return missing
}

export const takeWav = (id: string): Uint8Array | null => {
  const t = pool.get(id)
  return t ? encodeWavMono(t.pcm, t.rate) : null
}

const buffers = new WeakMap<BaseAudioContext, WeakMap<Float32Array, AudioBuffer>>()

/** An AudioBuffer for some PCM in a given context, cached per context. */
export function toBuffer(ctx: BaseAudioContext, pcm: Float32Array, rate: number): AudioBuffer {
  let perCtx = buffers.get(ctx)
  if (!perCtx) buffers.set(ctx, (perCtx = new WeakMap()))
  let b = perCtx.get(pcm)
  if (!b) {
    b = new AudioBuffer({ length: Math.max(1, pcm.length), numberOfChannels: 1, sampleRate: rate })
    b.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0)
    perCtx.set(pcm, b)
  }
  return b
}

/** Peak level per bucket, for drawing a waveform. */
export function peaks(pcm: Float32Array, buckets: number): Float32Array {
  const out = new Float32Array(buckets)
  const per = pcm.length / buckets
  for (let b = 0; b < buckets; b++) {
    let m = 0
    const end = Math.min(pcm.length, Math.floor((b + 1) * per))
    for (let i = Math.floor(b * per); i < end; i++) m = Math.max(m, Math.abs(pcm[i]))
    out[b] = m
  }
  return out
}

/// <reference lib="webworker" />
import { detectPitch, pitchShifts, psola, type TuneSettings } from './pitch'

export interface TuneRequest {
  id: number
  pcm: Float32Array
  rate: number
  settings: TuneSettings
  /** detected pitch from an earlier job on the same take, to skip detection */
  f0?: Float32Array
}

export interface TuneReply {
  id: number
  pcm?: Float32Array
  /** output pitch per frame (MIDI, NaN unvoiced) for drawing */
  pitch?: Float32Array
  f0?: Float32Array
  error?: string
}

self.onmessage = (e: MessageEvent<TuneRequest>) => {
  const { id, pcm, rate, settings } = e.data
  try {
    const f0 = e.data.f0 ?? detectPitch(pcm, rate)
    const { shift, pitch } = pitchShifts(f0, settings)
    const untouched = settings.mode === 'off' && !settings.transpose && !settings.detune && !settings.formant
    const out = untouched ? pcm.slice(0) : psola(pcm, rate, f0, shift, settings.formant)
    const reply: TuneReply = { id, pcm: out, pitch, f0 }
    ;(self as unknown as Worker).postMessage(reply, [out.buffer])
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies TuneReply)
  }
}

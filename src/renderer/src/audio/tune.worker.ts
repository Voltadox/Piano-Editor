/// <reference lib="webworker" />
import { gateGain, levelGain, repairDropouts } from './cleanup'
import { detectPitch, pitchShifts, psola, type TunedNote, type TuneSettings } from './pitch'

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
  /** the notes found and where each lands */
  notes?: TunedNote[]
  f0?: Float32Array
  error?: string
}

self.onmessage = (e: MessageEvent<TuneRequest>) => {
  const { id, rate, settings } = e.data
  try {
    // dropouts from a chattering mic gate are filled before anything else looks at the take
    const pcm = repairDropouts(e.data.pcm, rate).pcm
    const f0 = e.data.f0 ?? detectPitch(pcm, rate)
    const { shift, pitch, notes } = pitchShifts(f0, settings)
    const untouched = settings.mode === 'off' && !settings.edits?.length && !settings.transpose && !settings.detune && !settings.formant
    const out = untouched ? pcm.slice(0) : psola(pcm, rate, f0, shift, settings.formant)
    // brought to a standard level, with the hiss between phrases kept down rather than turned up
    const gain = levelGain(out, rate)
    const gate = gateGain(pcm, rate)
    for (let i = 0; i < out.length; i++) out[i] *= gain * gate[i]
    const reply: TuneReply = { id, pcm: out, pitch, notes, f0 }
    ;(self as unknown as Worker).postMessage(reply, [out.buffer])
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies TuneReply)
  }
}

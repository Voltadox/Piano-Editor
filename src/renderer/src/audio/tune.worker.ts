/// <reference lib="webworker" />
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

/** Loudness a sung take is brought to: the RMS of its singing, about −18 dBFS, a usual lead-vocal level. */
const TARGET_RMS = 0.125

/**
 * The gain that brings a take's singing to TARGET_RMS. Mic takes come in far quieter than the
 * soundfont (there's no automatic gain on the mic), so without this vocals sit under everything.
 * Measured on the louder 20 ms stretches only, so pauses and breaths don't count; never more than
 * +24 dB, so a take that's nearly empty doesn't turn into loud hiss.
 */
function levelGain(pcm: Float32Array, rate: number): number {
  const win = Math.max(1, Math.round(rate * 0.02))
  const levels: number[] = []
  for (let a = 0; a + win <= pcm.length; a += win) {
    let s = 0
    for (let i = a; i < a + win; i++) s += pcm[i] * pcm[i]
    const rms = Math.sqrt(s / win)
    if (rms > 0.002) levels.push(rms)
  }
  if (levels.length < 10) return 1
  levels.sort((x, y) => x - y)
  const loud = levels[Math.floor(levels.length * 0.8)]
  let peak = 0
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]))
  // the compressor and limiter after this catch a little over full scale, not a lot
  return Math.max(0.5, Math.min(16, TARGET_RMS / loud, 1.6 / peak))
}

self.onmessage = (e: MessageEvent<TuneRequest>) => {
  const { id, pcm, rate, settings } = e.data
  try {
    const f0 = e.data.f0 ?? detectPitch(pcm, rate)
    const { shift, pitch, notes } = pitchShifts(f0, settings)
    const untouched = settings.mode === 'off' && !settings.edits?.length && !settings.transpose && !settings.detune && !settings.formant
    const out = untouched ? pcm.slice(0) : psola(pcm, rate, f0, shift, settings.formant)
    const gain = levelGain(out, rate)
    for (let i = 0; i < out.length; i++) out[i] *= gain
    const reply: TuneReply = { id, pcm: out, pitch, notes, f0 }
    ;(self as unknown as Worker).postMessage(reply, [out.buffer])
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies TuneReply)
  }
}

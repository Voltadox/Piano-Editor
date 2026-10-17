/// <reference lib="webworker" />
import { Mp3Encoder } from '@breezystack/lamejs'
import { SoundBankLoader, SpessaSynthProcessor, type MIDIController } from 'spessasynth_core'
import { CC, OFF, ON, PB, PC, type PlayEvent } from './events'

export interface RenderRequest {
  /** the user's soundfont, if one is loaded */
  soundfont: ArrayBuffer | null
  /** the backup soundfont that fills in missing instruments */
  backup: ArrayBuffer | null
  events: PlayEvent[]
  /** seconds of song content */
  duration: number
  /** silence before the song starts (used for video lead-in) */
  lead: number
  /** seconds rendered after the last note so reverb and releases can ring out */
  tail: number
  sampleRate: number
  format: 'wav' | 'mp3' | 'pcm'
  kbps?: number
}

/** Encode already-mixed audio (a mix with vocals) to a file. */
export interface EncodeRequest {
  encode: true
  left: Float32Array
  right: Float32Array
  sampleRate: number
  format: 'wav' | 'mp3'
  kbps?: number
}

export type RenderReply =
  | { type: 'progress'; value: number }
  | { type: 'done'; data: Uint8Array }
  | { type: 'pcm'; left: Float32Array; right: Float32Array }
  | { type: 'error'; message: string }

const post = (msg: RenderReply, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(msg, transfer)

self.onmessage = async (e: MessageEvent<RenderRequest | EncodeRequest>) => {
  try {
    if ('encode' in e.data) {
      const r = e.data
      const data = r.format === 'wav' ? encodeWav(r.left, r.right, r.sampleRate) : encodeMp3(r.left, r.right, r.sampleRate, r.kbps ?? 256)
      post({ type: 'done', data }, [data.buffer])
      return
    }
    const req = e.data
    const { left, right } = await render(req)
    if (req.format === 'pcm') post({ type: 'pcm', left, right }, [left.buffer, right.buffer])
    else {
      const data = req.format === 'wav' ? encodeWav(left, right, req.sampleRate) : encodeMp3(left, right, req.sampleRate, req.kbps ?? 256)
      post({ type: 'done', data }, [data.buffer])
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

async function render(req: RenderRequest): Promise<{ left: Float32Array; right: Float32Array }> {
  const { sampleRate: sr } = req
  const BLOCK = 128
  const synth = new SpessaSynthProcessor(sr, { eventsEnabled: false, effectsEnabled: true, maxBufferSize: BLOCK })
  if (req.soundfont) synth.soundBankManager.addSoundBank(SoundBankLoader.fromArrayBuffer(req.soundfont), 'main')
  if (req.backup) synth.soundBankManager.addSoundBank(SoundBankLoader.fromArrayBuffer(req.backup), 'backup')
  if (req.soundfont && req.backup) synth.soundBankManager.priorityOrder = ['main', 'backup']
  await synth.processorInitialized
  synth.setSystemParameter('autoAllocateVoices', true)

  const total = Math.ceil((req.lead + req.duration + req.tail) * sr)
  const left = new Float32Array(total)
  const right = new Float32Array(total)
  const ev = req.events
  let i = 0
  let lastReport = 0
  for (let pos = 0; pos < total; pos += BLOCK) {
    const now = pos / sr - req.lead
    while (i < ev.length && ev[i].time <= now) {
      const x = ev[i++]
      if (x.kind === ON) synth.noteOn(x.ch, x.a, x.b)
      else if (x.kind === OFF) synth.noteOff(x.ch, x.a)
      else if (x.kind === CC) synth.controllerChange(x.ch, x.a as MIDIController, x.b)
      else if (x.kind === PB) synth.pitchWheel(x.ch, x.a)
      else if (x.kind === PC) {
        synth.controllerChange(x.ch, 0 as MIDIController, x.b)
        synth.programChange(x.ch, x.a)
      }
    }
    synth.process(left, right, pos, Math.min(BLOCK, total - pos))
    if (pos - lastReport > sr / 2) {
      lastReport = pos
      post({ type: 'progress', value: pos / total })
    }
  }

  // keep the mix out of clipping without changing the level of quiet renders
  let peak = 0
  for (let k = 0; k < total; k++) peak = Math.max(peak, Math.abs(left[k]), Math.abs(right[k]))
  if (peak > 0.98) {
    const g = 0.98 / peak
    for (let k = 0; k < total; k++) {
      left[k] *= g
      right[k] *= g
    }
  }
  return { left, right }
}

function toInt16(x: Float32Array, from: number, to: number): Int16Array {
  const out = new Int16Array(to - from)
  for (let k = from; k < to; k++) {
    const s = Math.max(-1, Math.min(1, x[k]))
    out[k - from] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

function encodeWav(left: Float32Array, right: Float32Array, sr: number): Uint8Array {
  const n = left.length
  const buf = new ArrayBuffer(44 + n * 4)
  const v = new DataView(buf)
  const str = (o: number, s: string): void => [...s].forEach((c, k) => v.setUint8(o + k, c.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + n * 4, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 2, true)
  v.setUint32(24, sr, true)
  v.setUint32(28, sr * 4, true)
  v.setUint16(32, 4, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, n * 4, true)
  const l = toInt16(left, 0, n)
  const r = toInt16(right, 0, n)
  for (let k = 0, o = 44; k < n; k++, o += 4) {
    v.setInt16(o, l[k], true)
    v.setInt16(o + 2, r[k], true)
  }
  return new Uint8Array(buf)
}

function encodeMp3(left: Float32Array, right: Float32Array, sr: number, kbps: number): Uint8Array {
  const enc = new Mp3Encoder(2, sr, kbps)
  const chunks: Uint8Array[] = []
  const FRAME = 1152
  for (let k = 0; k < left.length; k += FRAME) {
    const end = Math.min(left.length, k + FRAME)
    const out = enc.encodeBuffer(toInt16(left, k, end), toInt16(right, k, end))
    if (out.length) chunks.push(new Uint8Array(out))
  }
  const tail = enc.flush()
  if (tail.length) chunks.push(new Uint8Array(tail))
  const size = chunks.reduce((a, c) => a + c.length, 0)
  const data = new Uint8Array(size)
  let o = 0
  for (const c of chunks) {
    data.set(c, o)
    o += c.length
  }
  return data
}

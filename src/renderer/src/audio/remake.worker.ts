/// <reference lib="webworker" />
import { SoundBankLoader, SpessaSynthProcessor, type BasicSoundBank, type MIDIController } from 'spessasynth_core'
import {
  BAND_RATE,
  bandSpectrogram,
  compareSound,
  drumTemplate,
  DRUM_NOTES,
  isGeneralMidi,
  suitKey,
  suits,
  transcribeDrums,
  type Hit,
  type PartNote
} from '../model/remake'
import type { RemakePart } from '../model/song'

/**
 * The heavy parts of recreating a backing track, off the page: finding drum hits, and auditioning
 * every preset of a set of soundfonts on each part to see which sounds most like the song.
 */

export interface AuditionPart {
  part: RemakePart
  notes: PartNote[]
  /** stretches to audition on: where each starts (song seconds) and the song's audio there */
  windows: { from: number; audio: Float32Array }[]
}

export type RemakeRequest =
  | { kind: 'drums'; pcm: Float32Array; kit: ArrayBuffer }
  /** soundfonts to audition, each with the presets (by suitKey) this worker is to try */
  | { kind: 'load'; fonts: { path: string; bytes: ArrayBuffer; keys: string[] }[] }
  /** tries the loaded presets on the parts; with `only`, just those (a second round on more windows) */
  | { kind: 'audition'; parts: AuditionPart[]; only?: { part: RemakePart; font: string; key: string }[] }

export interface Score {
  part: RemakePart
  font: string
  /** as the soundfont numbers the preset (plus 128 for a General MIDI drum kit) */
  bank: number
  program: number
  name: string
  /** how unlike the song it sounded in each audition window */
  windows: number[]
  /** how much louder the song was, in each window */
  gains: number[]
}

export type RemakeReply =
  | { type: 'progress'; value: number }
  | { type: 'hits'; hits: Hit[] }
  | { type: 'loaded' }
  | { type: 'scores'; scores: Score[] }
  | { type: 'error'; message: string }

const post = (m: RemakeReply): void => (self as unknown as Worker).postMessage(m)
const BLOCK = 128

/** Renders notes with one preset, mono at BAND_RATE, `length` seconds from `from`. */
async function renderPart(bank: BasicSoundBank, preset: { bankMSB: number; program: number; isGMGSDrum: boolean }, notes: PartNote[], from: number, length: number): Promise<Float32Array> {
  const synth = new SpessaSynthProcessor(BAND_RATE, { eventsEnabled: false, effectsEnabled: false, maxBufferSize: BLOCK })
  synth.soundBankManager.addSoundBank(bank, 'f')
  await synth.processorInitialized
  synth.setSystemParameter('autoAllocateVoices', true)
  // a General MIDI kit plays on the drum channel; anything else (a kit made as an ordinary preset too)
  // on an ordinary one
  const ch = preset.isGMGSDrum ? 9 : 0
  synth.controllerChange(ch, 0 as MIDIController, preset.bankMSB)
  synth.programChange(ch, preset.program)
  const ev = notes
    .filter((n) => n.end > from && n.start < from + length)
    .flatMap((n) => [
      { t: Math.max(0, n.start - from), on: true, n },
      { t: n.end - from, on: false, n }
    ])
    .sort((a, b) => a.t - b.t || Number(a.on) - Number(b.on))
  const total = Math.ceil(length * BAND_RATE)
  const l = new Float32Array(total)
  const r = new Float32Array(total)
  let i = 0
  for (let pos = 0; pos < total; pos += BLOCK) {
    while (i < ev.length && ev[i].t * BAND_RATE <= pos) {
      const e = ev[i++]
      if (e.on) synth.noteOn(ch, e.n.pitch, e.n.vel)
      else synth.noteOff(ch, e.n.pitch)
    }
    synth.process(l, r, pos, Math.min(BLOCK, total - pos))
  }
  for (let k = 0; k < total; k++) l[k] = (l[k] + r[k]) / 2
  return l
}

/** The drum templates, from GeneralUser's standard, power, electronic and 808 kits. */
async function kitTemplates(kit: ArrayBuffer): Promise<{ note: number; w: Float32Array }[]> {
  const bank = SoundBankLoader.fromArrayBuffer(kit)
  const out: { note: number; w: Float32Array }[] = []
  for (const program of [0, 16, 24, 25])
    for (const d of DRUM_NOTES) {
      const x = await renderPart(bank, { bankMSB: 0, program, isGMGSDrum: true }, [{ start: 0.05, end: 0.6, pitch: d.note, vel: 100 }], 0, 1)
      out.push({ note: d.note, w: drumTemplate(x) })
    }
  return out
}

/** Soundfonts this worker auditions, and which of their presets (by suitKey). */
const loaded = new Map<string, { bank: BasicSoundBank; gm: boolean; keys: Set<string> }>()

async function audition(parts: AuditionPart[], only?: { part: RemakePart; font: string; key: string }[]): Promise<Score[]> {
  const scores: Score[] = []
  const targets = parts.map((p) => p.windows.map((w) => bandSpectrogram(w.audio)))
  const LENGTH = parts[0]?.windows[0] ? parts[0].windows[0].audio.length / BAND_RATE : 4
  const jobs: { path: string; bank: BasicSoundBank; preset: BasicSoundBank['presets'][number]; k: number }[] = []
  for (const [path, f] of loaded)
    for (const preset of f.bank.presets) {
      const key = suitKey(preset)
      if (!f.keys.has(key)) continue
      const info = { name: preset.name, bank: preset.bankMSB + (preset.isGMGSDrum ? 128 : 0), program: preset.program }
      parts.forEach((part, k) => {
        if (only ? only.some((o) => o.part === part.part && o.font === path && o.key === key) : suits(part.part, info, f.gm)) jobs.push({ path, bank: f.bank, preset, k })
      })
    }
  let done = 0
  for (const { path, bank, preset, k } of jobs) {
    const part = parts[k]
    const windows: number[] = []
    const gains: number[] = []
    for (const [w, win] of part.windows.entries()) {
      const x = await renderPart(bank, preset, part.notes, win.from, LENGTH)
      const c = compareSound(targets[k][w], bandSpectrogram(x))
      windows.push(c.distance)
      gains.push(c.gainDb)
    }
    scores.push({ part: part.part, font: path, bank: preset.bankMSB + (preset.isGMGSDrum ? 128 : 0), program: preset.program, name: preset.name.trim(), windows, gains })
    if (++done % 4 === 0) post({ type: 'progress', value: done / jobs.length })
  }
  return scores
}

self.onmessage = async (e: MessageEvent<RemakeRequest>) => {
  try {
    const m = e.data
    if (m.kind === 'drums') post({ type: 'hits', hits: transcribeDrums(m.pcm, await kitTemplates(m.kit)) })
    else if (m.kind === 'load') {
      for (const f of m.fonts) {
        try {
          const bank = SoundBankLoader.fromArrayBuffer(f.bytes)
          const gm = isGeneralMidi(bank.presets.map((p) => ({ name: p.name, bank: p.bankMSB + (p.isGMGSDrum ? 128 : 0), program: p.program })))
          loaded.set(f.path, { bank, gm, keys: new Set(f.keys) })
        } catch {
          // not a soundfont the synth can read: nothing to audition from it
        }
      }
      post({ type: 'loaded' })
    } else post({ type: 'scores', scores: await audition(m.parts, m.only) })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

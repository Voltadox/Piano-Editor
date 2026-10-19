import { BUILTIN_FONT, fontName, readPresets } from '../audio/fontSlots'
import type { AuditionPart, RemakeReply, RemakeRequest, Score } from '../audio/remake.worker'
import RemakeWorker from '../audio/remake.worker?worker'
import { getTake } from '../audio/takes'
import { auditionWindows, bassLine, BAND_RATE, drumNotes, isGeneralMidi, keysPart, suits, volumeFor, type Hit, type PartNote } from '../model/remake'
import { DRUM_CHANNEL, newId, newTrack, sortNotes, tempoMap, type RemakePart, type SoundChoice, type Song, type Track } from '../model/song'
import { getState } from '../state/store'
import { referenceTrack } from './reference'
import { resample, separateReference } from './separate'

/**
 * Recreating the reference's backing track as MIDI. The instrumental is split again into drums,
 * bass and everything else; each is turned into notes (drum hits, a bass line, the chords and
 * lines on top), and every preset in the soundfont collection (the design folder, the soundfont
 * list and the built-in GeneralUser GS) is auditioned on each part to find the closest sound.
 */

const SEPARATION_RATE = 44100
const AUDITION_SECONDS = 6

const busy = (label: string, progress: number): void => getState().set({ busy: { label, progress } })

const PARTS: { part: RemakePart; name: string; color: string }[] = [
  { part: 'drums', name: 'Drums (remake)', color: '#a0aec0' },
  { part: 'bass', name: 'Bass (remake)', color: '#f6ad55' },
  { part: 'keys', name: 'Keys (remake)', color: '#63b3ed' }
]

const toArrayBuffer = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer

/** Reads a soundfont by path; the built-in one comes with Keyfall. */
export async function readFont(path: string): Promise<ArrayBuffer | null> {
  if (path === BUILTIN_FONT) {
    const b = await window.keyfall.backupSoundfont()
    return b ? toArrayBuffer(b) : null
  }
  const f = await window.keyfall.readFile(path)
  return f ? toArrayBuffer(f.data) : null
}

/** Every soundfont a recreation can choose from: the design folder, the soundfont list and GeneralUser GS. */
async function collection(): Promise<string[]> {
  const paths = [...(await window.keyfall.designFonts()).map((f) => f.path), ...getState().sfLibrary.map((e) => e.path)].filter((p) => !/\.dls$/i.test(p))
  const seen = new Set<string>()
  const out = paths.filter((p) => {
    const k = p.toLowerCase().replace(/\\/g, '/')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return [...out, BUILTIN_FONT]
}

function runWorker<T extends RemakeReply['type']>(msg: unknown, transfer: Transferable[], want: T, onProgress: (p: number) => void = () => undefined): Promise<Extract<RemakeReply, { type: T }>> {
  return new Promise((resolve, reject) => {
    const w = new RemakeWorker()
    w.onmessage = (e: MessageEvent<RemakeReply>) => {
      const m = e.data
      if (m.type === 'progress') return onProgress(m.value)
      w.terminate()
      if (m.type === want) resolve(m as Extract<RemakeReply, { type: T }>)
      else reject(new Error(m.type === 'error' ? m.message : 'Unexpected result'))
    }
    w.onerror = (e) => {
      w.terminate()
      reject(new Error(e.message))
    }
    w.postMessage(msg, transfer)
  })
}

/** A worker kept for several requests (the audition pool). */
class Pooled {
  private w = new RemakeWorker()
  private pending: { want: RemakeReply['type']; resolve: (m: RemakeReply) => void; reject: (e: Error) => void; progress: (p: number) => void } | null = null
  constructor() {
    this.w.onmessage = (e: MessageEvent<RemakeReply>) => {
      const m = e.data
      const p = this.pending
      if (!p) return
      if (m.type === 'progress') return p.progress(m.value)
      this.pending = null
      if (m.type === p.want) p.resolve(m)
      else p.reject(new Error(m.type === 'error' ? m.message : 'Unexpected result'))
    }
    this.w.onerror = (e) => {
      this.pending?.reject(new Error(e.message))
      this.pending = null
    }
  }
  ask<T extends RemakeReply['type']>(msg: RemakeRequest, transfer: Transferable[], want: T, progress: (p: number) => void = () => undefined): Promise<Extract<RemakeReply, { type: T }>> {
    return new Promise((resolve, reject) => {
      this.pending = { want, resolve: resolve as (m: RemakeReply) => void, reject, progress }
      this.w.postMessage(msg, transfer)
    })
  }
  stop(): void {
    this.w.terminate()
  }
}

/** Presets tried in the first round on each part; the closest this many go on to the second. */
const FINALISTS = 16
/** The first round hears this much of each stretch. */
const FIRST_SECONDS = 3
/** Presets per share of a soundfont: big soundfonts are split over several workers. */
const SHARE = 40

/**
 * Auditions every soundfont's suitable presets on the parts and returns each part's best sounds,
 * best first. The work is shared out by how many presets there are to try, not by file size (a
 * small soundfont can hold a hundred instruments), over a few workers. Every preset is tried on
 * the first stretch of each part; the closest few are then tried on the rest.
 */
async function audition(paths: string[], parts: AuditionPart[], onProgress: (p: number) => void): Promise<Map<RemakePart, SoundChoice[]>> {
  // what each soundfont has to offer, read from its preset headers
  const shares: { path: string; bytes: ArrayBuffer; keys: string[]; cost: number }[] = []
  for (const path of paths) {
    const bytes = await readFont(path)
    if (!bytes) continue
    const presets = readPresets(bytes)
    const gm = isGeneralMidi(presets)
    const suitable = presets.filter((p) => parts.some((pt) => suits(pt.part, p, gm)))
    for (let i = 0; i < suitable.length; i += SHARE) {
      const mine = suitable.slice(i, i + SHARE)
      const cost = mine.reduce((c, p) => c + parts.filter((pt) => suits(pt.part, p, gm)).length, 0)
      shares.push({ path, bytes, keys: mine.map((p) => `${p.bank}:${p.program}`), cost })
    }
  }
  shares.sort((a, b) => b.cost - a.cost)
  const n = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 2) - 1, shares.length))
  const loads = Array.from({ length: n }, () => ({ fonts: new Map<string, { bytes: ArrayBuffer; keys: string[] }>(), cost: 0 }))
  for (const sh of shares) {
    const l = loads.reduce((a, b) => (b.cost < a.cost ? b : a))
    const had = l.fonts.get(sh.path)
    if (had) had.keys.push(...sh.keys)
    else l.fonts.set(sh.path, { bytes: sh.bytes, keys: [...sh.keys] })
    l.cost += sh.cost
  }
  const pool = loads.map(() => new Pooled())
  try {
    // a soundfont shared by several workers is copied for each
    await Promise.all(
      loads.map((l, i) => {
        const fonts = [...l.fonts].map(([path, f]) => ({ path, bytes: f.bytes.slice(0), keys: f.keys }))
        return pool[i].ask({ kind: 'load', fonts }, fonts.map((f) => f.bytes), 'loaded')
      })
    )
    const round = async (rparts: AuditionPart[], only: ((i: number) => { part: RemakePart; font: string; key: string }[]) | null, from: number, to: number): Promise<Score[]> => {
      const progress = new Array(n).fill(0)
      const replies = await Promise.all(
        pool.map((w, i) =>
          w.ask({ kind: 'audition', parts: rparts, only: only?.(i) }, [], 'scores', (p) => {
            progress[i] = p
            onProgress(from + ((to - from) * progress.reduce((s, v) => s + v, 0)) / n)
          })
        )
      )
      return replies.flatMap((r) => r.scores)
    }
    // first round: every suitable preset, on the start of each of a part's stretches
    const first = await round(
      parts.map((p) => ({ ...p, windows: p.windows.map((w) => ({ from: w.from, audio: w.audio.slice(0, Math.round(FIRST_SECONDS * BAND_RATE)) })) })),
      null,
      0,
      0.7
    )
    const mean = (x: number[]): number => x.reduce((a, b) => a + b, 0) / x.length
    const finalists = new Map<RemakePart, Score[]>()
    for (const { part } of parts) {
      const mine = first.filter((s) => s.part === part && s.windows.every(Number.isFinite)).sort((a, b) => mean(a.windows) - mean(b.windows))
      // soundfonts often reuse one sound under several names: keep it once
      const same = (a: Score, b: Score): boolean => a.windows.every((d, w) => Math.abs(d - b.windows[w]) < 1e-9)
      const distinct = mine.filter((r, i) => !mine.slice(0, i).some((o) => same(o, r)))
      finalists.set(part, distinct.slice(0, FINALISTS))
    }
    // second round: the finalists on the whole of each stretch, each in the worker that has its soundfont
    const holder = (font: string, key: string): number => loads.findIndex((l) => l.fonts.get(font)?.keys.includes(key))
    const second = await round(
      parts,
      (i) => [...finalists].flatMap(([part, list]) => list.filter((s) => holder(s.font, `${s.bank}:${s.program}`) === i).map((s) => ({ part, font: s.font, key: `${s.bank}:${s.program}` }))),
      0.7,
      1
    )
    const picked = new Map<RemakePart, { s: Score; windows: number[]; gains: number[] }[]>()
    for (const { part } of parts) {
      const complete = second.filter((s) => s.part === part && s.windows.every(Number.isFinite)).map((s) => ({ s, windows: s.windows, gains: s.gains }))
      if (!complete.length) continue
      // each stretch is judged against the best sound on it, so a stretch where nothing fits well
      // (notes missed there, or another instrument in the stem) doesn't decide the choice
      const best = complete[0].windows.map((_, w) => Math.max(1e-6, Math.min(...complete.map((x) => x.windows[w]))))
      const rank = (x: { windows: number[] }): number => x.windows.reduce((a, d, w) => a + d / best[w], 0) / x.windows.length
      picked.set(part, complete.sort((a, b) => rank(a) - rank(b)).slice(0, 6))
    }
    // levels: each part as loud as in the song, unless one can't get that loud even at full volume;
    // then they all come down together, so the balance between them stays the song's
    const gainOf = (x: { gains: number[] }): number => [...x.gains].sort((a, b) => a - b)[x.gains.length >> 1] ?? 0
    const reach = (gainDb: number): number => 40 * Math.log10(100 / 127) + gainDb
    const over = Math.max(0, ...[...picked.values()].map((list) => reach(gainOf(list[0]))))
    const out = new Map<RemakePart, SoundChoice[]>()
    for (const [part, list] of picked)
      out.set(
        part,
        list.map((x) => ({
          font: x.s.font,
          bank: x.s.bank,
          program: x.s.program,
          name: x.s.name,
          distance: x.windows.reduce((a, d) => a + d, 0) / x.windows.length,
          volume: volumeFor(gainOf(x) - over)
        }))
      )
    return out
  } finally {
    for (const w of pool) w.stop()
  }
}

/** Recreates the reference's backing track: drums, bass and keys as MIDI tracks with matching sounds. */
export async function remakeBacking(): Promise<void> {
  if (!referenceTrack(getState().song)) {
    getState().notify('Open a song in the Reference tab first.', 'error')
    return
  }
  // the backing track is recreated from the instrumental, so the vocals come out first
  if (!getState().song.reference?.stems) {
    await separateReference()
    if (!getState().song.reference?.stems) return
  }
  const song = getState().song
  const inst = song.audioTracks.find((t) => t.id === song.reference!.stems!.instrumental)
  const clip = inst?.clips[0]
  const take = clip ? getTake(clip.takes[clip.active]) : undefined
  if (!inst || !clip || !take) {
    getState().notify('The instrumental is missing. Separate the vocals again first.', 'error')
    return
  }
  const stage = { label: '', from: 0, to: 0 }
  const offModel = window.keyfall.onModelProgress((p) =>
    busy(`Downloading the ${p.name === 'bass' ? 'bass' : 'drum'} separator (${Math.round(p.received / 1e6)} of ${Math.round(p.total / 1e6)} MB, first time only)`, stage.from + (p.received / p.total) * (stage.to - stage.from) * 0.5)
  )
  const offSep = window.keyfall.onSeparateProgress((p) => busy(stage.label, stage.from + p * (stage.to - stage.from)))
  const step = (label: string, from: number, to: number): void => {
    Object.assign(stage, { label, from, to })
    busy(label, from)
  }
  try {
    step('Getting the instrumental ready', 0, 0.02)
    const [l, r] = take.rate === SEPARATION_RATE ? [take.pcm, take.right ?? take.pcm] : await resample([take.pcm, take.right ?? take.pcm], take.rate, SEPARATION_RATE)
    step('Separating the drums', 0.02, 0.2)
    const drums = await window.keyfall.separateStem('drums', l, r)
    step('Separating the bass', 0.2, 0.4)
    const bass = await window.keyfall.separateStem('bass', l, r)
    const mono = (a: Float32Array, b: Float32Array): Float32Array => a.map((v, i) => (v + b[i]) / 2)
    const rest = l.map((v, i) => (v + r[i]) / 2 - (drums.left[i] + drums.right[i]) / 2 - (bass.left[i] + bass.right[i]) / 2)
    const [drums22, bass22, rest22] = await resample([mono(drums.left, drums.right), mono(bass.left, bass.right), rest], SEPARATION_RATE, BAND_RATE)

    step('Finding the bass notes', 0.4, 0.45)
    const bassHeard = await window.keyfall.transcribeNotes(bass22.slice())
    step('Finding the chords and lines', 0.45, 0.5)
    const restHeard = await window.keyfall.transcribeNotes(rest22.slice())
    step('Finding the drum hits', 0.5, 0.55)
    const kit = await readFont(BUILTIN_FONT)
    if (!kit) throw new Error('The built-in GeneralUser GS soundfont is missing from this copy of Keyfall.')
    const { hits } = await runWorker({ kind: 'drums', pcm: drums22.slice(), kit }, [kit], 'hits')

    const bassNotes = bassLine(bassHeard)
    const notes: Record<RemakePart, PartNote[]> = { drums: drumNotes(hits as Hit[]), bass: bassNotes, keys: keysPart(restHeard, bassNotes) }
    const audio: Record<RemakePart, Float32Array> = { drums: drums22, bass: bass22, keys: rest22 }
    const parts: AuditionPart[] = PARTS.filter((p) => notes[p.part].length >= 4).map(({ part }) => ({
      part,
      notes: notes[part],
      windows: auditionWindows(notes[part], 3, AUDITION_SECONDS).map((from) => ({
        from,
        audio: audio[part].slice(Math.round(from * BAND_RATE), Math.round((from + AUDITION_SECONDS) * BAND_RATE))
      }))
    }))
    if (!parts.length) throw new Error('No drums, bass or chords could be made out in the instrumental.')

    const fonts = await collection()
    step(`Trying ${fonts.length} soundfonts on each part`, 0.55, 0.98)
    const choices = await audition(fonts, parts, (p) => busy(`Trying ${fonts.length} soundfonts on each part`, 0.55 + p * 0.43))

    getState().apply((s) => withRemake(s, clip.tick, clip.offset, notes, choices))
    getState().set({ busy: null })
    const made = PARTS.filter((p) => choices.get(p.part)?.length)
    getState().notify(
      `Recreated the backing track: ${made.map((p) => `${p.part} on ${describe(choices.get(p.part)![0])}`).join(', ')}. You're hearing the remake with the song's vocals; switch in Listen to. Click a track in the Tracks tab and press Q to tidy its timing.`
    )
  } catch (err) {
    getState().set({ busy: null })
    getState().notify(`Couldn't recreate the backing track. ${err instanceof Error ? err.message : ''}`, 'error')
  } finally {
    offModel()
    offSep()
  }
}

export const describe = (c: SoundChoice): string => `${c.name} (${fontName(c.font)})`

/**
 * Adds (or replaces) the remade parts as tracks, notes placed where the song plays them, each on
 * its best sound, and switches to hearing the remake with the song's vocals.
 */
function withRemake(song: Song, clipTick: number, clipOffset: number, notes: Record<RemakePart, PartNote[]>, choices: Map<RemakePart, SoundChoice[]>): Song {
  const map = tempoMap(song)
  const startSec = map.tickToSec(clipTick) - clipOffset
  const old = new Map(song.tracks.filter((t) => t.remake).map((t) => [t.remake!, t]))
  let tracks = song.tracks.filter((t) => !t.remake)
  for (const { part, name, color } of PARTS) {
    const best = choices.get(part)?.[0]
    if (!best) continue
    const placed = sortNotes(
      notes[part]
        .filter((n) => n.end > clipOffset)
        .map((n) => {
          const tick = Math.max(0, Math.round(map.secToTick(startSec + n.start)))
          return { id: newId(), pitch: n.pitch, tick, dur: Math.max(10, Math.round(map.secToTick(startSec + n.end)) - tick), vel: n.vel }
        })
    )
    const prev = old.get(part)
    const base = newTrack({ ...song, tracks }, name)
    const t: Track = {
      ...base,
      id: prev?.id ?? base.id,
      channel: part === 'drums' ? DRUM_CHANNEL : base.channel,
      color,
      font: best.font,
      bank: best.bank,
      program: best.program,
      volume: best.volume,
      reverb: part === 'drums' ? 0.15 : 0.3,
      remake: part,
      notes: placed
    }
    tracks = [...tracks, t]
  }
  const remake = Object.fromEntries(choices) as Partial<Record<RemakePart, SoundChoice[]>>
  const next = { ...song, tracks, reference: { ...song.reference!, remake } }
  return hearRemake(next, true)
}

/** Mutes or unmutes the remade parts, with the reference and instrumental the other way round. */
export function hearRemake(song: Song, on: boolean): Song {
  const ref = song.reference
  if (!ref) return song
  return {
    ...song,
    tracks: song.tracks.map((t) => (t.remake ? { ...t, muted: !on } : t)),
    audioTracks: song.audioTracks.map((t) =>
      t.id === ref.trackId || t.id === ref.stems?.instrumental ? { ...t, muted: on || t.muted } : t.id === ref.stems?.vocals && on ? { ...t, muted: false } : t
    )
  }
}

/** Plays a remade part on another of its close matches. */
export function chooseSound(part: RemakePart, choice: SoundChoice): void {
  getState().apply((s) => ({
    ...s,
    tracks: s.tracks.map((t) => (t.remake === part ? { ...t, font: choice.font, bank: choice.bank, program: choice.program, volume: choice.volume } : t))
  }))
}


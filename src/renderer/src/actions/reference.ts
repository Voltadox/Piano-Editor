import type { AnalysisReply } from '../audio/analysis.worker'
import AnalysisWorker from '../audio/analysis.worker?worker'
import { engine } from '../audio/engine'
import { addTake } from '../audio/takes'
import { newAudioTrack } from '../model/audio'
import type { Analysis } from '../model/analysis'
import { newId, newTrack, PALETTE, sortNotes, TempoMap, ticksPerBar, ticksPerBeat, type ChordMark, type Note, type Song, type Tempo, type Track } from '../model/song'
import { getState, useStore } from '../state/store'

/**
 * Reference mode: bring in a finished song, listen to it, and lay the song out to match it: the
 * tempo map follows its downbeats, a chord lane and a soft chord pad follow its harmony, and its
 * key, sections and drum hits are kept for the tools that build on them.
 */

const ANALYSIS_RATE = 22050

function busy(label: string, progress: number): void {
  getState().set({ busy: { label, progress } })
}

/** A mono copy at the analysis sample rate. */
async function forAnalysis(buf: AudioBuffer): Promise<Float32Array> {
  const off = new OfflineAudioContext(1, Math.ceil(buf.duration * ANALYSIS_RATE), ANALYSIS_RATE)
  const src = off.createBufferSource()
  src.buffer = buf
  src.connect(off.destination)
  src.start()
  return (await off.startRendering()).getChannelData(0).slice()
}

function runAnalysis(pcm: Float32Array, onProgress: (p: number) => void): Promise<Analysis> {
  return new Promise((resolve, reject) => {
    const worker = new AnalysisWorker()
    worker.onmessage = (e: MessageEvent<AnalysisReply>) => {
      const m = e.data
      if (m.type === 'progress') return onProgress(m.value)
      worker.terminate()
      if (m.type === 'done') resolve(m.analysis)
      else reject(new Error(m.message))
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message))
    }
    worker.postMessage({ pcm, rate: ANALYSIS_RATE }, [pcm.buffer])
  })
}

/** Picks a song file and imports it as the reference. */
export async function importReference(): Promise<void> {
  const f = await window.keyfall.openFile('audio')
  if (!f) return
  await engine.init()
  busy(`Opening ${f.name}`, 0)
  let buf: AudioBuffer
  try {
    buf = await engine.ctx!.decodeAudioData(f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) as ArrayBuffer)
  } catch {
    getState().set({ busy: null })
    getState().notify(`Couldn't read ${f.name} as audio. Try an MP3 or WAV.`, 'error')
    return
  }
  await importReferenceAudio(f.name, buf)
}

/** Imports decoded audio as the song's reference: analyses it and lays the song out to match. */
export async function importReferenceAudio(name: string, buf: AudioBuffer): Promise<void> {
  try {
    busy(`Listening to ${name}`, 0.05)
    const mono = await forAnalysis(buf)
    const analysis = await runAnalysis(mono, (p) => busy(`Listening to ${name}`, 0.05 + p * 0.9))
    const left = buf.getChannelData(0).slice()
    const right = buf.numberOfChannels > 1 ? buf.getChannelData(1).slice() : undefined
    const takeId = addTake(left, buf.sampleRate, right)
    getState().apply((song) => applyReference(song, name, takeId, buf.duration, analysis))
    getState().set({ busy: null, drawerOpen: true, drawerTab: 'reference' })
    const { song } = getState()
    getState().notify(
      `${name}: ${Math.round(analysis.bpm)} BPM, ${song.key ? keyLabel(song.key.tonic, song.key.minor) : 'key unclear'}, ${song.chords.filter((c) => c.root >= 0).length} chord changes, ${song.sections.length} sections`
    )
  } catch (err) {
    getState().set({ busy: null })
    getState().notify(`Couldn't analyse ${name}. ${err instanceof Error ? err.message : ''}`, 'error')
  }
}

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
export const keyLabel = (tonic: number, minor: boolean): string => `${NAMES[tonic]} ${minor ? 'minor' : 'major'}`
export const chordLabel = (c: { root: number; minor: boolean }): string => (c.root < 0 ? 'No chord' : NAMES[c.root] + (c.minor ? 'm' : ''))

/**
 * The song laid out to match the analysis. Bar lines land on the reference's downbeats: one tempo
 * if the song is steady, otherwise a tempo per bar. Any pickup before the first downbeat gets
 * whole bars of its own, so bar numbers stay musical.
 */
export function applyReference(song: Song, name: string, takeId: string, duration: number, a: Analysis): Song {
  const ppq = song.ppq
  const timeSig: [number, number] = [4, 4]
  const barTicks = ppq * 4
  const down = a.downbeats.map((i) => a.beats[i])
  const barLens = down.slice(1).map((d, i) => d - down[i])
  const median = barLens.length ? [...barLens].sort((x, y) => x - y)[barLens.length >> 1] : 240 / (a.bpm || 120)
  const steady = barLens.every((l) => Math.abs(l / median - 1) < 0.03)
  // a steady song gets one exact average tempo so its last bar lines up as well as its first
  const avgBar = down.length > 1 ? (down[down.length - 1] - down[0]) / (down.length - 1) : median
  const d0 = down[0] ?? 0
  const lead = d0 > 0.05 ? Math.ceil(d0 / avgBar - 0.02) : 0
  const shift = lead * avgBar - d0
  const tempos: Tempo[] = [{ tick: 0, bpm: 240 / avgBar }]
  if (!steady) barLens.forEach((len, i) => tempos.push({ tick: (lead + i) * barTicks, bpm: 240 / len }))
  const map = new TempoMap(tempos, ppq)
  const tickAt = (audioSec: number): number => map.secToTick(audioSec + shift)
  const beatTick = ppq
  const snapBeat = (t: number): number => Math.max(0, Math.round(t / beatTick) * beatTick)

  // the reference audio itself, replacing any earlier reference
  const old = song.reference ? song.audioTracks.find((t) => t.id === song.reference!.trackId) : undefined
  const refTrack = {
    ...newAudioTrack(old?.id ?? newId(), `Reference · ${name.replace(/\.[^.]+$/, '')}`, '#8a91ab'),
    kind: 'reference' as const,
    tune: { mode: 'off' as const, speed: 0, voice: 'root' as const, centre: 57 },
    preset: 'clean' as const,
    amount: 0,
    volume: 0.8,
    clips: [{ id: newId(), tick: Math.max(0, Math.round(map.secToTick(Math.max(0, shift)))), offset: Math.max(0, -shift), duration: duration - Math.max(0, -shift), takes: [takeId], active: 0, fadeIn: 0.005, fadeOut: 0.05 }]
  }
  const audioTracks = old ? song.audioTracks.map((t) => (t.id === old.id ? refTrack : t)) : [refTrack, ...song.audioTracks]

  const chords: ChordMark[] = []
  for (const c of a.chords) {
    const tick = snapBeat(tickAt(a.beats[c.beat]))
    const last = chords[chords.length - 1]
    if (last && last.tick === tick) chords[chords.length - 1] = { tick, root: c.root, minor: c.minor }
    else if (!last || last.root !== c.root || last.minor !== c.minor) chords.push({ tick, root: c.root, minor: c.minor })
  }
  const sections = a.sections.map((s) => ({ id: newId(), name: s.name, bar: s.bar + lead }))
  if (lead > 0 && !sections.some((s) => s.bar === 0)) sections.unshift({ id: newId(), name: 'Intro', bar: 0 })

  const next: Song = {
    ...song,
    tempos,
    timeSig,
    audioTracks,
    chords,
    sections,
    key: a.key ? { tonic: a.key.tonic, minor: a.key.minor } : song.key,
    reference: {
      file: name,
      trackId: refTrack.id,
      drums: {
        kick: a.drums.kick.map((s) => s + shift),
        snare: a.drums.snare.map((s) => s + shift),
        hat: a.drums.hat.map((s) => s + shift)
      },
      barEnergy: [...new Array(lead).fill(0.2), ...a.barEnergy]
    }
  }
  return withChordPad(next)
}

/** Root-position chord voicings for the chord lane, with the root an octave below. */
export function chordPadNotes(song: Song, chords = song.chords): Note[] {
  const notes: Note[] = []
  const end = Math.max(chords.length ? chords[chords.length - 1].tick + ticksPerBar(song) : 0, 0)
  chords.forEach((c, i) => {
    if (c.root < 0) return
    const until = chords[i + 1]?.tick ?? end
    const dur = Math.max(ticksPerBeat(song) / 2, until - c.tick - 10)
    const root = 48 + c.root
    for (const p of [root - 12, root, root + (c.minor ? 3 : 4), root + 7]) notes.push({ id: newId(), pitch: p, tick: c.tick, dur, vel: p < root ? 62 : 54 })
  })
  return sortNotes(notes)
}

/**
 * Keeps the "Chords" pad track in step with the chord lane. It starts muted, so the reference is
 * what you hear; unmute it to hear the chords on their own. Everything that follows chords reads
 * the lane itself, so muting the pad changes nothing else.
 */
export function withChordPad(song: Song): Song {
  const existing = song.tracks.find((t) => t.role === 'chords')
  const notes = chordPadNotes(song)
  if (existing) return { ...song, tracks: song.tracks.map((t) => (t.id === existing.id ? { ...t, notes } : t)) }
  if (!notes.length) return song
  const pad: Track = { ...newTrack(song, 'Chords'), program: 89, role: 'chords', muted: true, volume: 0.55, color: PALETTE[2], notes }
  return { ...song, tracks: [...song.tracks, pad] }
}

/** Changes one chord in the lane (or removes the change with null) and updates the pad. */
export function setChordAt(index: number, chord: { root: number; minor: boolean } | null): void {
  getState().apply((song) => {
    const chords = song.chords.flatMap((c, i) => (i !== index ? [c] : chord ? [{ ...c, ...chord }] : []))
    return withChordPad({ ...song, chords })
  })
}

/** Starts a new chord at a tick (snapped to the beat), copying the one in effect there. */
export function addChordAt(tick: number): number {
  const { song } = getState()
  const t = Math.max(0, Math.round(tick / song.ppq) * song.ppq)
  const before = [...song.chords].reverse().find((c) => c.tick <= t)
  const mark = { tick: t, root: before?.root ?? 0, minor: before?.minor ?? false }
  getState().apply((s) => withChordPad({ ...s, chords: [...s.chords.filter((c) => c.tick !== t), mark].sort((a, b) => a.tick - b.tick) }))
  return getState().song.chords.findIndex((c) => c.tick === t)
}

export const referenceTrack = (song: Song): Song['audioTracks'][number] | undefined =>
  song.reference ? song.audioTracks.find((t) => t.id === song.reference!.trackId) : undefined

/**
 * Doubles or halves the tempo (beat trackers sometimes lock to half or double time). Every
 * position is rescaled with it, so nothing moves in time: the reference still lines up, and only
 * the bar lines change.
 */
export function scaleTempo(factor: 2 | 0.5): void {
  getState().apply((song) => {
    const k = (t: number): number => Math.round(t * factor)
    return {
      ...song,
      tempos: song.tempos.map((t) => ({ tick: k(t.tick), bpm: t.bpm * factor })),
      tracks: song.tracks.map((t) => ({
        ...t,
        notes: t.notes.map((n) => ({ ...n, tick: k(n.tick), dur: Math.max(1, k(n.dur)) })),
        ccs: t.ccs.map((c) => ({ ...c, tick: k(c.tick) })),
        bends: t.bends.map((b) => ({ ...b, tick: k(b.tick) }))
      })),
      audioTracks: song.audioTracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, tick: k(c.tick) })) })),
      chords: song.chords.map((c) => ({ ...c, tick: k(c.tick) })),
      sections: song.sections.map((s) => ({ ...s, bar: Math.round(s.bar * factor) }))
    }
  })
  useStore.getState().notify(factor === 2 ? 'Tempo doubled: bars are now half as long.' : 'Tempo halved: bars are now twice as long.')
}

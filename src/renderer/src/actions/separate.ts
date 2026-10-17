import type { AnalysisReply } from '../audio/analysis.worker'
import AnalysisWorker from '../audio/analysis.worker?worker'
import { engine } from '../audio/engine'
import { addTake, getTake } from '../audio/takes'
import { newAudioTrack } from '../model/audio'
import type { SungNote } from '../model/melody'
import { newId, newTrack, sortNotes, tempoMap, type Song, type Track } from '../model/song'
import { getState } from '../state/store'
import { referenceTrack } from './reference'

const SEPARATION_RATE = 44100

async function resample(channels: Float32Array[], from: number, to: number): Promise<Float32Array[]> {
  if (from === to) return channels.map((c) => c.slice())
  const len = channels[0].length
  const buf = new AudioBuffer({ length: len, numberOfChannels: channels.length, sampleRate: from })
  channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i))
  const off = new OfflineAudioContext(channels.length, Math.ceil((len * to) / from), to)
  const src = off.createBufferSource()
  src.buffer = buf
  src.connect(off.destination)
  src.start()
  const out = await off.startRendering()
  return channels.map((_, i) => out.getChannelData(i).slice())
}

function sungNotes(pcm: Float32Array, rate: number): Promise<SungNote[]> {
  return new Promise((resolve, reject) => {
    const w = new AnalysisWorker()
    w.onmessage = (e: MessageEvent<AnalysisReply>) => {
      if (e.data.type === 'progress') return
      w.terminate()
      if (e.data.type === 'melody') resolve(e.data.notes)
      else reject(new Error(e.data.type === 'error' ? e.data.message : 'Unexpected result'))
    }
    w.postMessage({ kind: 'melody', pcm, rate })
  })
}

const busy = (label: string, progress: number): void => getState().set({ busy: { label, progress } })

/**
 * Splits the reference into vocals and instrumental with the separation model (downloaded the
 * first time), then turns the vocal into notes to sing. Each becomes a track; the reference keeps
 * playing until you choose to listen to the instrumental or the vocals instead.
 */
export async function separateReference(): Promise<void> {
  const { song } = getState()
  const ref = referenceTrack(song)
  const clip = ref?.clips[0]
  const take = clip ? getTake(clip.takes[clip.active]) : undefined
  if (!ref || !clip || !take) {
    getState().notify('Open a song in the Reference tab first.', 'error')
    return
  }
  const offModel = window.keyfall.onModelProgress((p) => busy(`Downloading the vocal separator (${Math.round(p.received / 1e6)} of ${Math.round(p.total / 1e6)} MB, first time only)`, (p.received / p.total) * 0.3))
  const offSep = window.keyfall.onSeparateProgress((p) => busy('Separating the vocals', 0.3 + p * 0.6))
  try {
    busy('Preparing the song', 0.02)
    const [l, r] = await resample([take.pcm, take.right ?? take.pcm], take.rate, SEPARATION_RATE)
    const vocals = await window.keyfall.separateVocals(l, r)
    const instL = l.map((v, i) => v - vocals.left[i])
    const instR = r.map((v, i) => v - vocals.right[i])
    busy('Finding the notes that are sung', 0.92)
    const mono = vocals.left.map((v, i) => (v + vocals.right[i]) / 2)
    const notes = await sungNotes(mono, SEPARATION_RATE)
    const vocalTake = addTake(vocals.left, SEPARATION_RATE, vocals.right)
    const instTake = addTake(instL, SEPARATION_RATE, instR)
    getState().apply((s) => withStems(s, vocalTake, instTake, notes))
    getState().set({ busy: null })
    getState().notify(`Separated the vocals and found ${notes.length} sung notes. Choose what to listen to in the Reference tab.`)
  } catch (err) {
    getState().set({ busy: null })
    getState().notify(`Couldn't separate the vocals. ${err instanceof Error ? err.message : ''}`, 'error')
  } finally {
    offModel()
    offSep()
  }
}

/** Adds (or replaces) the vocal and instrumental stems and the "Melody" notes to sing. */
function withStems(song: Song, vocalTake: string, instTake: string, sung: SungNote[]): Song {
  const ref = referenceTrack(song)!
  const clip = ref.clips[0]
  const stem = (id: number | undefined, name: string, color: string, takeId: string) => ({
    ...newAudioTrack(id ?? newId(), name, color),
    kind: 'stem' as const,
    tune: { mode: 'off' as const, speed: 0, voice: 'root' as const, centre: 57 },
    preset: 'clean' as const,
    amount: 0,
    volume: ref.volume,
    muted: true,
    clips: [{ ...clip, id: newId(), takes: [takeId], active: 0 }]
  })
  const prev = song.reference?.stems
  const vocals = stem(prev?.vocals, 'Vocals (from the song)', '#f687b3', vocalTake)
  const inst = stem(prev?.instrumental, 'Instrumental (from the song)', '#90cdf4', instTake)
  const kept = song.audioTracks.filter((t) => t.id !== vocals.id && t.id !== inst.id)
  const at = kept.findIndex((t) => t.id === ref.id) + 1
  const audioTracks = [...kept.slice(0, at), vocals, inst, ...kept.slice(at)]

  // sung notes, placed where the song plays them
  const map = tempoMap(song)
  const startSec = map.tickToSec(clip.tick) - clip.offset
  const notes = sortNotes(
    sung
      .filter((n) => n.end > clip.offset)
      .map((n) => {
        const tick = Math.round(map.secToTick(startSec + n.start))
        return { id: newId(), pitch: n.pitch, tick, dur: Math.max(10, Math.round(map.secToTick(startSec + n.end)) - tick), vel: n.vel }
      })
  )
  const existing = song.tracks.find((t) => t.role === 'melody')
  const melody: Track = existing
    ? { ...existing, notes }
    : { ...newTrack(song, 'Melody (to sing)'), role: 'melody', silent: true, color: '#fbd38d', notes }
  const tracks = existing ? song.tracks.map((t) => (t.id === existing.id ? melody : t)) : [...song.tracks, melody]
  return { ...song, audioTracks, tracks, reference: { ...song.reference!, stems: { vocals: vocals.id, instrumental: inst.id } } }
}

export type Listen = 'song' | 'instrumental' | 'vocals'

export function listening(song: Song): Listen {
  const ref = referenceTrack(song)
  const stems = song.reference?.stems
  if (!ref || !stems) return 'song'
  const inst = song.audioTracks.find((t) => t.id === stems.instrumental)
  const voc = song.audioTracks.find((t) => t.id === stems.vocals)
  if (inst && !inst.muted) return 'instrumental'
  if (voc && !voc.muted) return 'vocals'
  return 'song'
}

/** Plays the full song, only its instrumental (a backing track to sing over), or only its vocals. */
export function listenTo(which: Listen): void {
  getState().apply((song) => {
    const ref = referenceTrack(song)
    const stems = song.reference?.stems
    if (!ref || !stems) return song
    return {
      ...song,
      audioTracks: song.audioTracks.map((t) =>
        t.id === ref.id ? { ...t, muted: which !== 'song' } : t.id === stems.instrumental ? { ...t, muted: which !== 'instrumental' } : t.id === stems.vocals ? { ...t, muted: which !== 'vocals' } : t
      )
    }
  })
  void engine.init()
}

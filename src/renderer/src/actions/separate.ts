import type { AnalysisReply } from '../audio/analysis.worker'
import AnalysisWorker from '../audio/analysis.worker?worker'
import { engine } from '../audio/engine'
import { addTake, getTake } from '../audio/takes'
import { newAudioTrack } from '../model/audio'
import { harmonyLines } from '../model/harmonyLines'
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
    busy('Listening for harmonies', 0.96)
    const [forNotes] = await resample([mono], SEPARATION_RATE, 22050)
    const heard = await window.keyfall.transcribeNotes(forNotes)
    const harmony = harmonyLines(heard, notes)
    const vocalTake = addTake(vocals.left, SEPARATION_RATE, vocals.right)
    const instTake = addTake(instL, SEPARATION_RATE, instR)
    getState().apply((s) => withStems(s, vocalTake, instTake, notes, harmony))
    getState().set({ busy: null })
    const h = harmony.above.length + harmony.below.length
    getState().notify(
      `Separated the vocals: ${notes.length} sung notes${h ? `, and harmonies (${harmony.above.length} notes above the lead, ${harmony.below.length} below)` : ', no harmonies heard'}. Choose what to listen to in the Reference tab.`
    )
  } catch (err) {
    getState().set({ busy: null })
    getState().notify(`Couldn't separate the vocals. ${err instanceof Error ? err.message : ''}`, 'error')
  } finally {
    offModel()
    offSep()
  }
}

/** Adds (or replaces) the vocal and instrumental stems, the "Melody" notes to sing and any harmony lines. */
function withStems(song: Song, vocalTake: string, instTake: string, sung: SungNote[], harmony: { above: SungNote[]; below: SungNote[] }): Song {
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
  const place = (list: SungNote[]) =>
    sortNotes(
      list
        .filter((n) => n.end > clip.offset)
        .map((n) => {
          const tick = Math.round(map.secToTick(startSec + n.start))
          return { id: newId(), pitch: n.pitch, tick, dur: Math.max(10, Math.round(map.secToTick(startSec + n.end)) - tick), vel: n.vel }
        })
    )
  let tracks = song.tracks
  const upsert = (role: NonNullable<Track['role']>, name: string, color: string, list: SungNote[]): void => {
    const existing = tracks.find((t) => t.role === role)
    const notes = place(list)
    if (existing) tracks = tracks.map((t) => (t.id === existing.id ? { ...t, notes } : t))
    else if (notes.length) tracks = [...tracks, { ...newTrack({ ...song, tracks }, name), role, silent: true, color, notes }]
  }
  upsert('melody', 'Melody (to sing)', '#fbd38d', sung)
  upsert('harmony-above', 'Harmony above (to sing)', '#b794f4', harmony.above)
  upsert('harmony-below', 'Harmony below (to sing)', '#81e6d9', harmony.below)
  return { ...song, audioTracks, tracks, reference: { ...song.reference!, stems: { vocals: vocals.id, instrumental: inst.id } } }
}

/**
 * Lyrics from the separated vocal (Whisper, downloaded the first time). Each line starts at the
 * first sung note inside it, since the recogniser's own timing can run early.
 */
export async function findLyrics(): Promise<void> {
  const { song } = getState()
  const stem = song.audioTracks.find((t) => t.id === song.reference?.stems?.vocals)
  const clip = stem?.clips[0]
  const take = clip ? getTake(clip.takes[clip.active]) : undefined
  if (!stem || !clip || !take) {
    getState().notify('Separate the vocals first; the lyrics are read from them.', 'error')
    return
  }
  const off = window.keyfall.onSeparateProgress((p) => busy(p < 0.8 ? 'Downloading the lyrics model (first time only)' : 'Listening for the words', p))
  try {
    busy('Listening for the words', 0.02)
    const mono = take.right ? take.pcm.map((v, i) => (v + take.right![i]) / 2) : take.pcm
    const [pcm16k] = await resample([mono], take.rate, 16000)
    const lines = await window.keyfall.transcribeLyrics(pcm16k)
    getState().apply((s) => {
      const map = tempoMap(s)
      const startSec = map.tickToSec(clip.tick) - clip.offset
      const melody = s.tracks.find((t) => t.role === 'melody')
      const sung = (melody?.notes ?? []).map((n) => map.tickToSec(n.tick) - startSec)
      const lyrics = lines.flatMap((l) => {
        const first = sung.find((t) => t >= l.start - 0.2 && t < l.end)
        const start = first ?? l.start
        const end = Math.max(l.end, start + 0.5)
        // long runs read better as short lines: split where a new phrase starts (the recogniser
        // capitalises it), then any piece still too long by length; time is shared by length,
        // each piece starting on the sung note nearest its share
        const words = l.text.split(/\s+/)
        const phrases: string[][] = [[]]
        for (const w of words) {
          const cur = phrases[phrases.length - 1]
          const startsPhrase = /^[A-Z]/.test(w) && !/^I('|$)/.test(w)
          if (startsPhrase && cur.length >= 3) phrases.push([w])
          else cur.push(w)
        }
        const pieces = phrases.flatMap((ph) => {
          const out: string[] = []
          for (let i = 0; i < ph.length; i += 9) out.push(ph.slice(i, i + 9).join(' '))
          return out
        })
        const total = l.text.length
        let used = 0
        return pieces.map((text) => {
          const guess = start + ((end - start) * used) / total
          used += text.length + 1
          const until = start + ((end - start) * used) / total
          const near = used === text.length + 1 ? start : sung.reduce((b, t) => (Math.abs(t - guess) < Math.abs(b - guess) && t < until ? t : b), guess)
          return { tick: Math.round(map.secToTick(startSec + near)), end: Math.round(map.secToTick(startSec + Math.min(end, until))), text }
        })
      })
      return { ...s, lyrics }
    })
    getState().set({ busy: null })
    getState().notify(lines.length ? `Found ${lines.length} lines of lyrics. Fix any words in the Reference tab.` : 'No words could be made out in the vocals.')
  } catch (err) {
    getState().set({ busy: null })
    getState().notify(`Couldn't read the lyrics. ${err instanceof Error ? err.message : ''}`, 'error')
  } finally {
    off()
  }
}

export function setLyric(index: number, text: string): void {
  getState().apply((s) => ({ ...s, lyrics: s.lyrics.map((l, i) => (i === index ? { ...l, text } : l)) }))
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

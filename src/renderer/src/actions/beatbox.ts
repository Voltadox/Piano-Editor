import { ensureTakes, getTake } from '../audio/takes'
import { DEFAULT_TUNE } from '../model/audio'
import { transcribeBeatbox } from '../model/beatbox'
import { BAND_RATE, type Hit } from '../model/remake'
import { DRUM_CHANNEL, newId, newTrack, snapTicks, sortNotes, tempoMap, type Note, type Snap, type Song, type Track } from '../model/song'
import { loadPref, savePref } from '../state/prefs'
import { getState } from '../state/store'
import { addAudioTrack } from '../state/vocalEdit'
import { resample } from './separate'
import { recordVocals } from './transport'

/**
 * Beatboxing a beat: you record into the mic over the song like a vocal take, and the take is
 * turned into a drum track. The take is kept (muted) on a Beatbox audio track, so the drums can be
 * rebuilt from it with another grid or after picking another take.
 */

export type BeatboxSnap = Extract<Snap, '1/8' | '1/16' | '1/16T' | 'off'>
export const beatboxSnap = (): BeatboxSnap => loadPref<BeatboxSnap>('beatboxSnap', '1/16')

/** Hits found in each take, in seconds into it: the same take is only listened to once. */
const heard = new Map<string, Hit[]>()

async function hitsOf(takeId: string): Promise<Hit[]> {
  const known = heard.get(takeId)
  if (known) return known
  const take = getTake(takeId)
  if (!take) return []
  const [mono] = await resample([take.pcm], take.rate, BAND_RATE)
  const hits = transcribeBeatbox(mono)
  heard.set(takeId, hits)
  return hits
}

export const beatboxAudio = (song: Song): Song['audioTracks'][number] | undefined => song.audioTracks.find((t) => t.kind === 'beatbox')
export const beatboxDrums = (song: Song): Track | undefined => song.tracks.find((t) => t.beatbox)

/** Starts (or stops) recording a beatbox over the song, into the Beatbox audio track. */
export function recordBeatbox(): void {
  const st = getState()
  if (st.vocalRec) return void recordVocals({ kind: 'beatbox', trackIds: [] })
  const id =
    beatboxAudio(st.song)?.id ??
    addAudioTrack('Beatbox', { kind: 'beatbox', color: '#f6ad55', preset: 'clean', amount: 0, tune: { ...DEFAULT_TUNE, mode: 'off' } })
  void recordVocals({ kind: 'beatbox', trackIds: [id] })
}

/**
 * The kit a new beatbox track plays: the recreated drums' sound if the song has one, else the
 * beat's kit, else the main soundfont's standard kit.
 */
function startingKit(song: Song): Pick<Track, 'font' | 'bank' | 'program'> {
  const like = song.tracks.find((t) => t.remake === 'drums') ?? song.tracks.find((t) => t.channel === DRUM_CHANNEL && !t.beatbox)
  return like ? { font: like.font, bank: like.bank, program: like.program } : { font: undefined, bank: 0, program: 0 }
}

/**
 * Turns the Beatbox track's takes (the one playing in each clip) into the Beatbox drums track,
 * every hit snapped to the grid, replacing what that track had. The take is muted so the kit is
 * what you hear.
 */
export async function convertBeatbox(snap: BeatboxSnap = beatboxSnap()): Promise<void> {
  savePref('beatboxSnap', snap)
  const song = getState().song
  const audio = beatboxAudio(song)
  if (!audio?.clips.length) {
    getState().notify('Record a beatbox first.', 'error')
    return
  }
  getState().set({ busy: { label: 'Turning your beatbox into drums', progress: 0 } })
  try {
    const missing = await ensureTakes(audio.clips.map((c) => c.takes[c.active]))
    if (missing.length) throw new Error('The recording is missing from this song.')
    const map = tempoMap(song)
    const grid = snapTicks(song.ppq, snap)
    const notes = new Map<string, Note>()
    for (const [i, c] of audio.clips.entries()) {
      const start = map.tickToSec(c.tick)
      for (const h of await hitsOf(c.takes[c.active])) {
        if (h.time < c.offset || h.time > c.offset + c.duration) continue
        const tick = Math.max(0, Math.round(map.secToTick(start + h.time - c.offset) / grid) * grid)
        // two hits of one drum snapped onto the same step are one hit
        const key = `${tick}:${h.note}`
        const had = notes.get(key)
        if (!had || had.vel < h.vel) notes.set(key, { id: newId(), pitch: h.note, tick, dur: Math.round(song.ppq / (h.note === 46 ? 2 : 4)), vel: h.vel })
      }
      getState().set({ busy: { label: 'Turning your beatbox into drums', progress: (i + 1) / audio.clips.length } })
    }
    const list = sortNotes([...notes.values()])
    if (!list.length) throw new Error('No beats could be heard in the recording. Get closer to the mic, or turn it up (Vocals tab → Check level).')
    getState().apply((s) => {
      const had = beatboxDrums(s)
      const track: Track = had
        ? { ...had, notes: list, muted: false }
        : { ...newTrack(s, 'Beatbox drums'), ...startingKit(s), channel: DRUM_CHANNEL, color: '#f6ad55', reverb: 0.15, beatbox: true, notes: list }
      return {
        ...s,
        tracks: had ? s.tracks.map((t) => (t.id === had.id ? track : t)) : [...s.tracks, track],
        audioTracks: s.audioTracks.map((t) => (t.id === audio.id ? { ...t, muted: true } : t))
      }
    })
    const count = (pitches: number[]): number => list.filter((n) => pitches.includes(n.pitch)).length
    const parts = [
      [count([36]), 'kick'],
      [count([38]), 'snare'],
      [count([42, 46]), 'hi-hat']
    ].filter(([n]) => n) as [number, string][]
    getState().notify(
      `Made ${parts.map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`).join(', ')} from your beatbox${snap === 'off' ? '' : `, snapped to ${snap} notes`}. Your recording is muted on the Beatbox track; unmute it to compare.`
    )
  } catch (err) {
    getState().notify(`Couldn't turn the beatbox into drums. ${err instanceof Error ? err.message : ''}`, 'error')
  } finally {
    getState().set({ busy: null })
  }
}

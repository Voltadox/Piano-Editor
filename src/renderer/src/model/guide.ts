import type { GuideVoice } from './audio'
import { detectKey, recognizeChord, type Key } from './harmony'
import { DRUM_CHANNEL, isAudible, songEndTick, tempoMap, ticksPerBeat, trackTimes, type Song, type Track } from './song'

const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] }

const keyCache = new WeakMap<Track[], { set: Song['key']; key: Key | null }>()

/** The song's key: the one the user set, otherwise detected from its notes. */
export function songKey(song: Song): Key | null {
  if (song.key) return { ...song.key, confidence: 1 }
  const hit = keyCache.get(song.tracks)
  if (hit && hit.set === song.key) return hit.key
  const weights = new Array(12).fill(0)
  const map = tempoMap(song)
  for (const t of song.tracks) {
    if (t.channel === DRUM_CHANNEL) continue
    const times = trackTimes(t, map)
    t.notes.forEach((n, i) => (weights[n.pitch % 12] += Math.min(2, times.end[i] - times.start[i])))
  }
  const key = detectKey(weights)
  keyCache.set(song.tracks, { set: song.key, key })
  return key
}

export function scaleOf(key: Key | null): number[] {
  if (!key) return [...Array(12).keys()]
  return (key.minor ? SCALES.minor : SCALES.major).map((s) => (key.tonic + s) % 12)
}

/** Root, third and fifth (pitch classes) of the chord in each beat, carried over silent beats. */
const timelineCache = new WeakMap<Track[], { tempos: Song['tempos']; chords: (number[] | null)[] }>()
function chordTimeline(song: Song): (number[] | null)[] {
  const hit = timelineCache.get(song.tracks)
  if (hit && hit.tempos === song.tempos) return hit.chords
  const tpb = ticksPerBeat(song)
  const beats = Math.ceil(songEndTick(song) / tpb) + 1
  const scale = scaleOf(songKey(song))
  const chords: (number[] | null)[] = []
  let prev: number[] | null = null
  for (let b = 0; b < beats; b++) {
    const lo = b * tpb
    const hi = lo + tpb
    const pitches: number[] = []
    for (const t of song.tracks) {
      if (t.channel === DRUM_CHANNEL || !isAudible(t, song)) continue
      for (const n of t.notes) if (n.tick < hi && n.tick + n.dur > lo) pitches.push(n.pitch)
    }
    let triad: number[] | null = null
    const named = recognizeChord(pitches)
    if (named) triad = named.pcs.slice(0, 3)
    else if (pitches.length) {
      // no clear chord: build the key's triad on the bass note
      const root = Math.min(...pitches) % 12
      const i = scale.indexOf(root)
      triad = i >= 0 && scale.length === 7 ? [root, scale[(i + 2) % 7], scale[(i + 4) % 7]] : [root, (root + 4) % 12, (root + 7) % 12]
    }
    prev = triad ?? prev
    chords.push(prev)
  }
  timelineCache.set(song.tracks, { tempos: song.tempos, chords })
  return chords
}

const nearest = (pc: number, centre: number): number => {
  const base = centre - (((centre - pc) % 12) + 12) % 12
  return centre - base > 6 ? base + 12 : base
}

/** The note a harmony voice should sing at a song time, placed near `centre`. */
export function guidePitchAt(song: Song, sec: number, voice: GuideVoice, centre: number): number | null {
  if (sec < 0) return null
  const chords = chordTimeline(song)
  const beat = Math.floor(tempoMap(song).secToTick(sec) / ticksPerBeat(song))
  const chord = chords[Math.min(chords.length - 1, beat)]
  if (!chord) return null
  if (voice === 'octave') return nearest(chord[0], centre) + 12
  return nearest(chord[voice === 'root' ? 0 : voice === 'third' ? 1 : 2], centre)
}

/** A voice's guide pitch per analysis frame, starting at `startSec`. */
export function guideLine(song: Song, voice: GuideVoice, centre: number, startSec: number, frames: number, hop: number): Float32Array {
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) out[i] = guidePitchAt(song, startSec + i * hop, voice, centre) ?? NaN
  return out
}

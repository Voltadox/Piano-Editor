import { DEFAULT_TUNE, isSongLine, newAudioTrack, type AudioClip, type AudioTrack, type GuideVoice } from '../model/audio'
import { newId, PALETTE, tempoMap } from '../model/song'
import { getState, useStore, type VocalNoteRef } from './store'
import { planWordMove, type Span } from '../model/vocalTiming'

/** Audio-track edits. Each is one undo step, like note edits. */

const VOCAL_COLORS = ['#b794f4', '#f687b3', '#81e6d9', '#fbd38d', '#90cdf4', '#fc8181']

export function addAudioTrack(name = 'Vocals', patch: Partial<AudioTrack> = {}): number {
  let id = -1
  getState().apply((song) => {
    const base = newAudioTrack(newId(), name, VOCAL_COLORS[song.audioTracks.length % VOCAL_COLORS.length] ?? PALETTE[0])
    // with the song's vocals separated, a new track follows the song's melody to start with
    if (song.tracks.some((x) => x.role === 'melody')) base.tune = { ...DEFAULT_TUNE, mode: 'reference', voice: 'melody' }
    const t = { ...base, ...patch }
    id = t.id
    return { ...song, audioTracks: [...song.audioTracks, t] }
  })
  useStore.setState({ activeAudioId: id })
  return id
}

export function updateAudioTrack(id: number, patch: Partial<AudioTrack>): void {
  getState().apply((song) => ({ ...song, audioTracks: song.audioTracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
}

export function removeAudioTrack(id: number): void {
  getState().apply((song) => ({ ...song, audioTracks: song.audioTracks.filter((t) => t.id !== id) }))
}

function mapClips(trackId: number, fn: (clips: AudioClip[]) => AudioClip[]): void {
  getState().apply((song) => ({
    ...song,
    audioTracks: song.audioTracks.map((t) => (t.id === trackId ? { ...t, clips: fn(t.clips).sort((a, b) => a.tick - b.tick) } : t))
  }))
}

export function updateClip(trackId: number, clipId: number, patch: Partial<AudioClip>): void {
  mapClips(trackId, (clips) => clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)))
}

export function deleteClip(trackId: number, clipId: number): void {
  mapClips(trackId, (clips) => clips.filter((c) => c.id !== clipId))
}

/**
 * Adds recorded passes to a track. A pass that starts where an existing clip starts becomes
 * another take of that clip (and the one that plays); anything else becomes a new clip.
 */
export function addRecordedPasses(trackId: number, passes: { tick: number; duration: number; takeId: string }[]): void {
  if (!passes.length) return
  const near = getState().song.ppq / 4
  mapClips(trackId, (clips) => {
    const out = [...clips]
    for (const p of passes) {
      const i = out.findIndex((c) => Math.abs(c.tick - p.tick) <= near)
      if (i >= 0) {
        const c = out[i]
        out[i] = { ...c, takes: [...c.takes, p.takeId], active: c.takes.length, duration: Math.max(c.duration, p.duration) }
      } else out.push({ id: newId(), tick: p.tick, offset: 0, duration: p.duration, takes: [p.takeId], active: 0, fadeIn: 0.01, fadeOut: 0.08 })
    }
    return out
  })
}

/**
 * Sets where one sung note lands: a pitch (MIDI, fractions bend it between keys), null to leave it
 * as sung, or undefined to hand it back to autotune. Any earlier edit inside the note is replaced.
 */
export function setNoteEdit(note: VocalNoteRef, pitch: number | null | undefined): void {
  mapClips(note.trackId, (clips) =>
    clips.map((c) => {
      if (c.id !== note.clipId) return c
      const kept = (c.edits?.[note.takeId] ?? []).filter((e) => e.at < note.start || e.at >= note.end)
      const list = pitch === undefined ? kept : [...kept, { at: (note.start + note.end) / 2, pitch }]
      const edits = { ...c.edits, [note.takeId]: list }
      if (!list.length) delete edits[note.takeId]
      return { ...c, edits }
    })
  )
}

/**
 * Moves the word sung at `at` (seconds into the clip's take) earlier or later by `delta` seconds,
 * cutting it out of its clip and trimming the silence it moves into (see planWordMove).
 * `notes` are the take's sung notes, in take seconds. Returns how far it really moved.
 */
export function moveVocalWord(trackId: number, clipId: number, notes: Span[], at: number, delta: number): number {
  let moved = 0
  getState().apply((song) => {
    const map = tempoMap(song)
    const track = song.audioTracks.find((t) => t.id === trackId)
    if (!track) return song
    const pieces = track.clips.map((c) => ({ ...c, start: map.tickToSec(c.tick), takeId: c.takes[c.active] }))
    const plan = planWordMove(pieces, clipId, notes, at, delta, newId)
    if (!plan || Math.abs(plan.moved) < 0.001) return song
    moved = plan.moved
    const clips: AudioClip[] = plan.pieces.map(({ start, takeId: _t, ...c }) => ({ ...(c as AudioClip), tick: Math.max(0, Math.round(map.secToTick(start))) }))
    return { ...song, audioTracks: song.audioTracks.map((t) => (t.id === trackId ? { ...t, clips: clips.sort((a, b) => a.tick - b.tick) } : t)) }
  })
  return moved
}

/** Hands every note of a vocal track back to autotune. */
export function clearNoteEdits(trackId: number): void {
  mapClips(trackId, (clips) => clips.map((c) => (c.edits ? { ...c, edits: undefined } : c)))
}

/** Moves a clip earlier (negative) or later by some milliseconds, to line a take up by ear. */
export function nudgeClip(trackId: number, clipId: number, ms: number): void {
  const map = tempoMap(getState().song)
  mapClips(trackId, (clips) =>
    clips.map((c) => {
      if (c.id !== clipId) return c
      let sec = map.tickToSec(c.tick) + ms / 1000
      let { offset, duration } = c
      // pulled back past the start of the song: drop the part that would be before it
      if (sec < 0) {
        offset -= sec
        duration += sec
        sec = 0
      }
      return duration > 0.05 ? { ...c, tick: Math.round(map.secToTick(sec)), offset, duration } : c
    })
  )
}

/** Cuts a clip in two at a song tick; both halves keep every take, so each can play a different one. */
export function splitClipAt(trackId: number, clipId: number, tick: number): boolean {
  const { song } = getState()
  const map = tempoMap(song)
  const clip = song.audioTracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId)
  if (!clip) return false
  const startSec = map.tickToSec(clip.tick)
  const at = map.tickToSec(tick) - startSec
  if (at <= 0.05 || at >= clip.duration - 0.05) return false
  mapClips(trackId, (clips) =>
    clips.flatMap((c) =>
      c.id !== clipId
        ? [c]
        : [
            { ...c, duration: at, fadeOut: 0.02 },
            { ...c, id: newId(), tick, offset: c.offset + at, duration: c.duration - at, fadeIn: 0.02 }
          ]
    )
  )
  return true
}

const VOICE_NAMES: Record<GuideVoice, string> = {
  root: 'Root',
  third: 'Third',
  fifth: 'Fifth',
  octave: 'Octave up',
  melody: 'Melody',
  above: 'Harmony above',
  below: 'Harmony below'
}

/**
 * The tracks a harmony stack records into, one per voice, reused if they exist. Each gets its own
 * pan, a few cents of detune and the guide it follows, so the stack spreads out and doesn't sound pasted.
 */
export function harmonyTracks(voices: GuideVoice[], centre: number): number[] {
  const spread: Record<GuideVoice, { pan: number; detune: number }> = {
    root: { pan: 0, detune: 0 },
    third: { pan: -0.45, detune: 6 },
    fifth: { pan: 0.45, detune: -7 },
    octave: { pan: 0.2, detune: 4 },
    melody: { pan: 0, detune: 0 },
    above: { pan: -0.4, detune: 5 },
    below: { pan: 0.4, detune: -5 }
  }
  return voices.map((v) => {
    const name = `Harmony · ${VOICE_NAMES[v]}`
    const found = getState().song.audioTracks.find((t) => t.name === name)
    const tune = { mode: isSongLine(v) ? ('reference' as const) : ('guide' as const), speed: 0.9, voice: v, centre }
    if (found) {
      updateAudioTrack(found.id, { tune })
      return found.id
    }
    return addAudioTrack(name, { tune, preset: 'haze', amount: 0.55, volume: v === 'root' ? 0.8 : 0.6, ...spread[v] })
  })
}

export const voiceName = (v: GuideVoice): string => VOICE_NAMES[v]

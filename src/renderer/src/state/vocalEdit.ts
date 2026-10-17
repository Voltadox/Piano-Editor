import { newAudioTrack, type AudioClip, type AudioTrack, type GuideVoice } from '../model/audio'
import { newId, PALETTE, tempoMap } from '../model/song'
import { getState, useStore } from './store'

/** Audio-track edits. Each is one undo step, like note edits. */

const VOCAL_COLORS = ['#b794f4', '#f687b3', '#81e6d9', '#fbd38d', '#90cdf4', '#fc8181']

export function addAudioTrack(name = 'Vocals', patch: Partial<AudioTrack> = {}): number {
  let id = -1
  getState().apply((song) => {
    const t = { ...newAudioTrack(newId(), name, VOCAL_COLORS[song.audioTracks.length % VOCAL_COLORS.length] ?? PALETTE[0]), ...patch }
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
    const tune = { mode: 'guide' as const, speed: 0.9, voice: v, centre }
    if (found) {
      updateAudioTrack(found.id, { tune })
      return found.id
    }
    return addAudioTrack(name, { tune, preset: 'haze', amount: 0.55, volume: v === 'root' ? 0.8 : 0.6, ...spread[v] })
  })
}

export const voiceName = (v: GuideVoice): string => VOICE_NAMES[v]

import { beatNotes, type Beat } from '../model/beat'
import { generateBeat } from '../model/beatgen'
import { DRUM_CHANNEL, newId, newTrack, songEndTick, sortNotes, ticksPerBar, type Section, type Song } from '../model/song'
import { getState, useStore } from './store'

// ---------- beats ----------

/** Replaces a drum track's beat and regenerates its notes from it. */
export function setBeat(trackId: number, beat: Beat): void {
  getState().apply((song) => ({
    ...song,
    tracks: song.tracks.map((t) => (t.id === trackId ? { ...t, beat, notes: beatNotes(song, beat) } : t))
  }))
}

/** The song's drum-machine track, created (on the drum channel) if there isn't one yet. */
export function beatTrackId(): number {
  const existing = getState().song.tracks.find((t) => t.beat)
  if (existing) return existing.id
  let id = -1
  getState().apply((song) => {
    const t = { ...newTrack(song, 'Drums'), channel: DRUM_CHANNEL, program: 0, color: '#a0aec0', beat: { patterns: [], bars: [], swing: 0 } }
    id = t.id
    return { ...song, tracks: [...song.tracks, t] }
  })
  return id
}

/** Writes a new beat in a style, fitted to the song, into the drum track. */
export function generateDrums(styleId: string, seed: number): void {
  const id = beatTrackId()
  const beat = generateBeat(getState().song, styleId, seed)
  setBeat(id, beat)
  useStore.setState({ beatPattern: beat.patterns[0]?.id ?? -1 })
}

// ---------- sections ----------

export function addSection(bar: number, name: string): void {
  getState().apply((song) => {
    if (song.sections.some((s) => s.bar === bar)) return song
    return { ...song, sections: [...song.sections, { id: newId(), name, bar }].sort((a, b) => a.bar - b.bar) }
  })
}

export function renameSection(id: number, name: string): void {
  getState().apply((song) => ({ ...song, sections: song.sections.map((s) => (s.id === id ? { ...s, name } : s)) }))
}

/** Takes the marker away; the music stays where it is. */
export function removeSectionMarker(id: number): void {
  getState().apply((song) => ({ ...song, sections: song.sections.filter((s) => s.id !== id) }))
}

/** A section's bars: from its marker to the next one (or the end of the song). */
export function sectionRange(song: Song, s: Section): { from: number; to: number } {
  const next = song.sections.filter((x) => x.bar > s.bar).sort((a, b) => a.bar - b.bar)[0]
  const end = Math.max(s.bar + 1, Math.ceil(songEndTick(song) / ticksPerBar(song)))
  return { from: s.bar, to: next ? next.bar : end }
}

/**
 * Moves everything on the timeline: each item's bar goes through `fn`, which returns where the
 * item should be now — no bars to drop it, two to copy it. Notes, pedal and pitch-bend events,
 * vocal clips, drum-machine bars and section markers all move together.
 */
function remap(song: Song, fn: (bar: number) => number[]): Song {
  const B = ticksPerBar(song)
  const place = (tick: number): number[] => fn(Math.floor(tick / B)).map((bar) => tick + (bar - Math.floor(tick / B)) * B)
  const tracks = song.tracks.map((t) => {
    if (t.beat) {
      const bars: (number | null)[] = []
      t.beat.bars.forEach((p, b) => fn(b).forEach((nb) => (bars[nb] = p)))
      const beat = { ...t.beat, bars: Array.from({ length: bars.length }, (_, i) => bars[i] ?? null) }
      return { ...t, beat, notes: beatNotes(song, beat) }
    }
    return {
      ...t,
      notes: sortNotes(t.notes.flatMap((n) => place(n.tick).map((tick, i) => ({ ...n, tick, id: i ? newId() : n.id })))),
      ccs: t.ccs.flatMap((c) => place(c.tick).map((tick) => ({ ...c, tick }))).sort((a, b) => a.tick - b.tick),
      bends: t.bends.flatMap((c) => place(c.tick).map((tick) => ({ ...c, tick }))).sort((a, b) => a.tick - b.tick)
    }
  })
  const audioTracks = song.audioTracks.map((t) => ({
    ...t,
    clips: t.clips.flatMap((c) => place(c.tick).map((tick, i) => ({ ...c, tick, id: i ? newId() : c.id }))).sort((a, b) => a.tick - b.tick)
  }))
  const sections = song.sections
    .flatMap((s) => fn(s.bar).map((bar, i) => ({ ...s, bar, id: i ? newId() : s.id, name: i ? `${s.name} 2` : s.name })))
    .sort((a, b) => a.bar - b.bar)
  return { ...song, tracks, audioTracks, sections }
}

/** Plays a section twice: a copy goes right after it and everything later moves along. */
export function duplicateSection(id: number): void {
  getState().apply((song) => {
    const s = song.sections.find((x) => x.id === id)
    if (!s) return song
    const { from, to } = sectionRange(song, s)
    const len = to - from
    return remap(song, (bar) => (bar < from ? [bar] : bar < to ? [bar, bar + len] : [bar + len]))
  })
}

/** Removes a section's bars and closes the gap. */
export function deleteSection(id: number): void {
  getState().apply((song) => {
    const s = song.sections.find((x) => x.id === id)
    if (!s) return song
    const { from, to } = sectionRange(song, s)
    const len = to - from
    return remap(song, (bar) => (bar < from ? [bar] : bar < to ? [] : [bar - len]))
  })
}

/** Swaps a section with the one before (-1) or after (+1) it. */
export function moveSection(id: number, dir: -1 | 1): void {
  getState().apply((song) => {
    const list = [...song.sections].sort((a, b) => a.bar - b.bar)
    const i = list.findIndex((x) => x.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= list.length) return song
    const first = sectionRange(song, list[Math.min(i, j)])
    const second = sectionRange(song, list[Math.max(i, j)])
    const a = first.from
    const b = second.from
    const c = second.to
    return remap(song, (bar) => (bar >= a && bar < b ? [bar + (c - b)] : bar >= b && bar < c ? [bar - (b - a)] : [bar]))
  })
}

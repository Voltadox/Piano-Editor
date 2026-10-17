import {
  DRUM_CHANNEL,
  HIGHEST,
  LOWEST,
  newId,
  newTrack,
  snapTicks,
  snapTo,
  sortNotes,
  type CC,
  type Note,
  type Song,
  type Track
} from '../model/song'
import { getState, useStore } from './store'

const clampPitch = (p: number): number => Math.min(HIGHEST, Math.max(LOWEST, p))

/** Returns a new song where notes in `ids` are transformed; untouched tracks keep their identity. */
export function mapNotes(song: Song, ids: Set<number>, fn: (n: Note) => Note): Song {
  let changed = false
  const tracks = song.tracks.map((t) => {
    if (!t.notes.some((n) => ids.has(n.id))) return t
    changed = true
    return { ...t, notes: sortNotes(t.notes.map((n) => (ids.has(n.id) ? fn(n) : n))) }
  })
  return changed ? { ...song, tracks } : song
}

export function updateTrack(id: number, patch: Partial<Track>): void {
  getState().apply((song) => ({ ...song, tracks: song.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
}

export function addTrack(): void {
  let id = -1
  getState().apply((song) => {
    const t = newTrack(song)
    id = t.id
    return { ...song, tracks: [...song.tracks, t] }
  })
  useStore.setState({ activeTrackId: id })
}

export function removeTrack(id: number): void {
  const { song, activeTrackId } = getState()
  if (song.tracks.length <= 1) {
    getState().notify('A song needs at least one track.')
    return
  }
  getState().apply((s) => ({ ...s, tracks: s.tracks.filter((t) => t.id !== id) }))
  if (activeTrackId === id) useStore.setState({ activeTrackId: getState().song.tracks[0].id })
}

export function setDrums(id: number, drums: boolean): void {
  const { song } = getState()
  const track = song.tracks.find((t) => t.id === id)
  if (!track) return
  if (drums) updateTrack(id, { channel: DRUM_CHANNEL, program: 0 })
  else {
    const fresh = newTrack({ ...song, tracks: song.tracks.filter((t) => t.id !== id) })
    updateTrack(id, { channel: fresh.channel })
  }
}

export function addNote(trackId: number, note: Omit<Note, 'id'>): Note {
  const n = { ...note, id: newId(), pitch: clampPitch(note.pitch) }
  getState().apply((song) => ({
    ...song,
    tracks: song.tracks.map((t) => (t.id === trackId ? { ...t, notes: sortNotes([...t.notes, n]) } : t))
  }))
  return n
}

export function deleteNotes(ids: Set<number>): void {
  if (!ids.size) return
  getState().apply((song) => ({
    ...song,
    tracks: song.tracks.map((t) => (t.notes.some((n) => ids.has(n.id)) ? { ...t, notes: t.notes.filter((n) => !ids.has(n.id)) } : t))
  }))
  const sel = new Set(getState().selection)
  ids.forEach((id) => sel.delete(id))
  getState().setSelection(sel)
}

export function transpose(ids: Set<number>, semis: number): void {
  getState().apply((song) => mapNotes(song, ids, (n) => ({ ...n, pitch: clampPitch(n.pitch + semis) })))
}

export function nudge(ids: Set<number>, ticks: number): void {
  getState().apply((song) => mapNotes(song, ids, (n) => ({ ...n, tick: Math.max(0, n.tick + ticks) })))
}

/** Quantize the selection, or the whole song when nothing is selected. */
export function quantize(ends: boolean): void {
  const { song, snap, selection } = getState()
  if (snap === 'off') {
    getState().notify('Pick a snap value first. Quantize uses the snap grid.')
    return
  }
  const grid = snapTicks(song.ppq, snap)
  const ids = selection.size ? selection : new Set(song.tracks.flatMap((t) => t.notes.map((n) => n.id)))
  getState().apply((s) =>
    mapNotes(s, ids, (n) => {
      const tick = snapTo(n.tick, grid)
      const dur = ends ? Math.max(grid, snapTo(n.tick + n.dur, grid) - tick) : n.dur
      return { ...n, tick, dur }
    })
  )
  getState().notify(`Quantized ${ids.size} note${ids.size === 1 ? '' : 's'} to ${snap}${ends ? ' (starts and ends)' : ''}`)
}

export function selectAll(): void {
  const { song } = getState()
  getState().setSelection(new Set(song.tracks.flatMap((t) => t.notes.map((n) => n.id))))
}

// ---------- clipboard ----------

interface Clip {
  trackId: number
  tick: number
  dur: number
  pitch: number
  vel: number
}
let clipboard: Clip[] = []

export function copySelection(): number {
  const { song, selection } = getState()
  const picked: Clip[] = []
  for (const t of song.tracks)
    for (const n of t.notes) if (selection.has(n.id)) picked.push({ trackId: t.id, tick: n.tick, dur: n.dur, pitch: n.pitch, vel: n.vel })
  if (!picked.length) return 0
  const min = Math.min(...picked.map((c) => c.tick))
  clipboard = picked.map((c) => ({ ...c, tick: c.tick - min }))
  return picked.length
}

export function cutSelection(): void {
  if (copySelection()) deleteNotes(new Set(getState().selection))
}

export function paste(atTick: number): void {
  if (!clipboard.length) return
  const { song, activeTrackId } = getState()
  const fallback = song.tracks.some((t) => t.id === activeTrackId) ? activeTrackId : song.tracks[0].id
  const sel = new Set<number>()
  getState().apply((s) => ({
    ...s,
    tracks: s.tracks.map((t) => {
      const mine = clipboard.filter((c) => (s.tracks.some((x) => x.id === c.trackId) ? c.trackId : fallback) === t.id)
      if (!mine.length) return t
      const added = mine.map((c) => {
        const n = { id: newId(), tick: atTick + c.tick, dur: c.dur, pitch: c.pitch, vel: c.vel }
        sel.add(n.id)
        return n
      })
      return { ...t, notes: sortNotes([...t.notes, ...added]) }
    })
  }))
  getState().setSelection(sel)
}

/** Recorded notes and pedal moves arrive in ticks already; this adds them as one undo step. */
export function addRecorded(trackId: number, notes: Omit<Note, 'id'>[], ccs: CC[] = []): void {
  if (!notes.length && !ccs.length) return
  getState().apply((song) => ({
    ...song,
    tracks: song.tracks.map((t) =>
      t.id === trackId
        ? {
            ...t,
            notes: sortNotes([...t.notes, ...notes.map((n) => ({ ...n, id: newId() }))]),
            ccs: ccs.length ? [...t.ccs, ...ccs].sort((a, b) => a.tick - b.tick) : t.ccs
          }
        : t
    )
  }))
}

export function setVelocities(vels: Map<number, number>): void {
  if (!vels.size) return
  const ids = new Set(vels.keys())
  getState().apply((song) => mapNotes(song, ids, (n) => ({ ...n, vel: Math.min(127, Math.max(1, Math.round(vels.get(n.id)!))) })))
}

// ---------- selection ----------

function selectWhere(pred: (n: Note, t: Track) => boolean, emptyMsg: string): void {
  const sel = new Set<number>()
  for (const t of getState().song.tracks) for (const n of t.notes) if (pred(n, t)) sel.add(n.id)
  getState().setSelection(sel)
  if (!sel.size) getState().notify(emptyMsg)
}

export function selectTrack(trackId = getState().activeTrackId): void {
  selectWhere((_n, t) => t.id === trackId, 'The active track has no notes.')
}

/** Every note with the same pitch as a selected note, in the same track. */
export function selectSamePitch(): void {
  const { song, selection } = getState()
  if (!selection.size) {
    getState().notify('Select a note first. This picks every note of the same pitch in its track.')
    return
  }
  const keys = new Set<string>()
  for (const t of song.tracks) for (const n of t.notes) if (selection.has(n.id)) keys.add(`${t.id}:${n.pitch}`)
  selectWhere((n, t) => keys.has(`${t.id}:${n.pitch}`), '')
}

/** Notes that start inside a tick range, in every track. */
export function selectRange(start: number, end: number): void {
  selectWhere((n) => n.tick >= start && n.tick < end, 'No notes start inside that range.')
}

export function invertSelection(): void {
  const { selection } = getState()
  selectWhere((n) => !selection.has(n.id), 'Every note was already selected.')
}

export function setTempo(bpm: number): void {
  const v = Math.min(400, Math.max(20, bpm))
  getState().apply((song) => {
    const tempos = song.tempos.length ? [...song.tempos] : [{ tick: 0, bpm: v }]
    tempos[0] = { ...tempos[0], bpm: v }
    return { ...song, tempos }
  })
}

export function setTimeSig(num: number, den: number): void {
  getState().apply((song) => ({ ...song, timeSig: [num, den] }))
}

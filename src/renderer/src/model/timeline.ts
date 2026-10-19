import type { AudioClip } from './audio'
import { beatNotes } from './beat'
import { newId, songEndTick, sortNotes, tempoMap, ticksPerBar, type Bend, type CC, type Song, type Track } from './song'

/**
 * The big-picture edits of the timeline view: a stretch of the song, on some of its tracks,
 * cleared, repeated, or cut out of the song altogether. Pure functions on a song.
 */

/** A stretch of the song (ticks) on some of its lanes: note tracks and audio tracks, by id. */
export interface Range {
  from: number
  to: number
  tracks: number[]
  audio: number[]
}

/** Short fades where a clip is cut, so the cut doesn't click. */
const CUT_FADE = 0.015
/** Pedals that hold notes down: sustain, sostenuto, soft. */
const PEDALS = [64, 66, 67]
const CENTRE = 8192

/** Where the song ends: its last note, or the end of its last audio clip if that's later. */
export function arrangeEnd(song: Song): number {
  const map = tempoMap(song)
  let end = songEndTick(song)
  for (const t of song.audioTracks) for (const c of t.clips) end = Math.max(end, map.secToTick(map.tickToSec(c.tick) + c.duration))
  return Math.ceil(end)
}

/** The part of a clip between two ticks (either can be ±Infinity), or null if it has none there. */
function clipPart(song: Song, c: AudioClip, from: number, to: number): AudioClip | null {
  const map = tempoMap(song)
  const s0 = map.tickToSec(c.tick)
  const s1 = s0 + c.duration
  const a = Math.max(s0, map.tickToSec(from))
  const b = Math.min(s1, map.tickToSec(to))
  if (b - a < 0.02) return null
  const cutStart = a > s0 + 1e-6
  const cutEnd = b < s1 - 1e-6
  if (!cutStart && !cutEnd) return c
  return {
    ...c,
    tick: cutStart ? from : c.tick,
    offset: c.offset + (a - s0),
    duration: b - a,
    fadeIn: cutStart ? CUT_FADE : c.fadeIn,
    fadeOut: cutEnd ? CUT_FADE : c.fadeOut
  }
}

/** Clips with nothing left between two ticks: any clip across the gap is cut in two. */
function clearClips(song: Song, clips: AudioClip[], from: number, to: number): AudioClip[] {
  return clips.flatMap((c) => {
    const before = clipPart(song, c, -Infinity, from)
    const after = clipPart(song, c, to, Infinity)
    return [before, after && before ? { ...after, id: newId() } : after].filter((x): x is AudioClip => !!x)
  })
}

/** The last value of a controller before a tick (pedals up, bend centred if there's none). */
const ccBefore = (ccs: CC[], num: number, tick: number): number => ccs.filter((c) => c.num === num && c.tick < tick).pop()?.val ?? 0
const bendBefore = (bends: Bend[], tick: number): number => bends.filter((b) => b.tick < tick).pop()?.val ?? CENTRE

/**
 * A note track with nothing between two ticks: notes starting there go, notes ringing into it stop
 * where it starts. Pedals are let go where the gap starts and put back as they were where it ends.
 */
function clearNotes(t: Track, from: number, to: number): Track {
  const notes = t.notes.filter((n) => n.tick < from || n.tick >= to).map((n) => (n.tick < from && n.tick + n.dur > from ? { ...n, dur: from - n.tick } : n))
  const ccs = t.ccs.filter((c) => c.tick < from || c.tick >= to)
  for (const num of PEDALS) {
    if (!t.ccs.some((c) => c.num === num)) continue
    if (ccBefore(t.ccs, num, from) >= 64) ccs.push({ tick: from, num, val: 0 })
    const back = ccBefore(t.ccs, num, to)
    if (back >= 64 && !t.ccs.some((c) => c.num === num && c.tick === to)) ccs.push({ tick: to, num, val: back })
  }
  const bends = t.bends.filter((b) => b.tick < from || b.tick >= to)
  if (bendBefore(t.bends, from) !== CENTRE) bends.push({ tick: from, val: CENTRE })
  const bendBack = bendBefore(t.bends, to)
  if (bendBack !== CENTRE && !t.bends.some((b) => b.tick === to)) bends.push({ tick: to, val: bendBack })
  return { ...t, notes, ccs: ccs.sort((a, b) => a.tick - b.tick), bends: bends.sort((a, b) => a.tick - b.tick) }
}

/**
 * A drum-machine track is edited bar by bar. Across part of a bar it becomes an ordinary track of
 * the notes it plays (its step patterns are let go), so any stretch can be edited.
 */
const barAligned = (song: Song, from: number, to: number): boolean => from % ticksPerBar(song) === 0 && to % ticksPerBar(song) === 0
const freeze = (t: Track): Track => ({ ...t, beat: undefined })

function clearTrack(song: Song, t: Track, from: number, to: number): Track {
  if (t.beat && barAligned(song, from, to)) {
    const B = ticksPerBar(song)
    const bars = t.beat.bars.map((p, b) => (b >= from / B && b < to / B ? null : p))
    const beat = { ...t.beat, bars }
    return { ...t, beat, notes: beatNotes(song, beat) }
  }
  return clearNotes(t.beat ? freeze(t) : t, from, to)
}

/** Silences a range on its lanes; the rest of the song stays where it is. */
export function clearRange(song: Song, r: Range): Song {
  return {
    ...song,
    tracks: song.tracks.map((t) => (r.tracks.includes(t.id) ? clearTrack(song, t, r.from, r.to) : t)),
    audioTracks: song.audioTracks.map((t) => (r.audio.includes(t.id) ? { ...t, clips: clearClips(song, t.clips, r.from, r.to) } : t))
  }
}

/**
 * Plays a range again straight after itself, `times` times, stopping at `limit` (a tick; the last
 * copy is cut short there). What was on those lanes where the copies go is replaced. With `only`,
 * just those notes are copied and nothing is replaced.
 */
export function repeatRange(song: Song, r: Range, times: number, limit = Infinity, only?: Set<number>): Song {
  const len = r.to - r.from
  if (len <= 0 || times < 1) return song
  const copies: { off: number; end: number }[] = []
  for (let k = 1; k <= times && r.from + k * len < limit; k++) copies.push({ off: k * len, end: Math.min(r.from + (k + 1) * len, limit) })
  if (!copies.length) return song
  const last = copies[copies.length - 1].end
  const B = ticksPerBar(song)

  const repeatTrack = (t: Track): Track => {
    if (t.beat && !only && barAligned(song, r.from, r.to)) {
      const bars = [...t.beat.bars]
      for (const { off, end } of copies)
        for (let b = r.from / B; b < r.to / B && b * B + off < end; b++) bars[b + off / B] = t.beat.bars[b] ?? null
      const beat = { ...t.beat, bars: Array.from({ length: bars.length }, (_, i) => bars[i] ?? null) }
      return { ...t, beat, notes: beatNotes(song, beat) }
    }
    const base = only ? (t.beat ? freeze(t) : t) : clearTrack(song, t.beat ? freeze(t) : t, r.to, last)
    const src = t.notes.filter((n) => n.tick >= r.from && n.tick < r.to && (!only || only.has(n.id)))
    const notes = [...base.notes]
    const ccs = [...base.ccs]
    const bends = [...base.bends]
    const srcCcs = only ? [] : t.ccs.filter((c) => c.tick >= r.from && c.tick < r.to)
    const srcBends = only ? [] : t.bends.filter((b) => b.tick >= r.from && b.tick < r.to)
    for (const { off, end } of copies) {
      for (const n of src) if (n.tick + off < end) notes.push({ ...n, id: newId(), tick: n.tick + off, dur: Math.min(n.dur, end - n.tick - off) })
      if (only) continue
      // each copy starts with the pedals and bend as they were where the range starts
      for (const num of PEDALS) {
        const v = ccBefore(t.ccs, num, r.from)
        if (v >= 64 && !srcCcs.some((c) => c.num === num && c.tick === r.from)) ccs.push({ tick: r.from + off, num, val: v })
      }
      const bend = bendBefore(t.bends, r.from)
      if (bend !== CENTRE && !srcBends.some((b) => b.tick === r.from)) bends.push({ tick: r.from + off, val: bend })
      for (const c of srcCcs) if (c.tick + off < end) ccs.push({ ...c, tick: c.tick + off })
      for (const b of srcBends) if (b.tick + off < end) bends.push({ ...b, tick: b.tick + off })
    }
    return { ...base, notes: sortNotes(notes), ccs: ccs.sort((a, b) => a.tick - b.tick), bends: bends.sort((a, b) => a.tick - b.tick) }
  }

  const repeatClips = (clips: AudioClip[]): AudioClip[] => {
    const parts = clips.map((c) => clipPart(song, c, r.from, r.to)).filter((x): x is AudioClip => !!x)
    const out = clearClips(song, clips, r.to, last)
    for (const { off, end } of copies)
      for (const p of parts) {
        const placed = clipPart(song, { ...p, tick: p.tick + off }, -Infinity, end)
        if (placed) out.push({ ...placed, id: newId() })
      }
    return out.sort((a, b) => a.tick - b.tick)
  }

  return {
    ...song,
    tracks: song.tracks.map((t) => (r.tracks.includes(t.id) ? repeatTrack(t) : t)),
    audioTracks: song.audioTracks.map((t) => (r.audio.includes(t.id) && !only ? { ...t, clips: repeatClips(t.clips) } : t))
  }
}

/**
 * Takes bars out of the whole song and closes the gap: every track, clip, chord, lyric, section
 * and tempo change after them moves back. `from` and `to` are bar lines.
 */
export function removeBars(song: Song, from: number, to: number): Song {
  const len = to - from
  const B = ticksPerBar(song)
  if (len <= 0) return song
  const map = tempoMap(song)
  const cleared = clearRange(song, { from, to, tracks: song.tracks.map((t) => t.id), audio: song.audioTracks.map((t) => t.id) })
  const shift = (tick: number): number => (tick >= to ? tick - len : tick)
  const tracks = cleared.tracks.map((t) => {
    if (t.beat) {
      const bars = [...t.beat.bars]
      bars.splice(from / B, len / B)
      const beat = { ...t.beat, bars }
      return { ...t, beat, notes: beatNotes(song, beat) }
    }
    return {
      ...t,
      notes: t.notes.map((n) => ({ ...n, tick: shift(n.tick) })),
      ccs: t.ccs.map((c) => ({ ...c, tick: shift(c.tick) })),
      bends: t.bends.map((b) => ({ ...b, tick: shift(b.tick) }))
    }
  })
  const audioTracks = cleared.audioTracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, tick: shift(c.tick) })) }))
  /** Marks (chords, sections) in the gap: the last one is still in effect after it, so it moves to where the gap was. */
  function marks<T>(list: T[], tickOf: (m: T) => number, withTick: (m: T, tick: number) => T): T[] {
    const inGap = list.filter((m) => tickOf(m) >= from && tickOf(m) < to)
    const carry = inGap[inGap.length - 1]
    const out = list.filter((m) => tickOf(m) < from)
    if (carry && !list.some((m) => tickOf(m) === to)) out.push(withTick(carry, from))
    return [...out, ...list.filter((m) => tickOf(m) >= to).map((m) => withTick(m, tickOf(m) - len))]
  }
  const chords = marks(song.chords, (c) => c.tick, (c, tick) => ({ ...c, tick }))
  const sections = marks(song.sections, (s) => s.bar * B, (s, tick) => ({ ...s, bar: Math.round(tick / B) }))
  const lyrics = song.lyrics
    .filter((l) => l.tick < from || l.tick >= to)
    .map((l) => (l.tick >= to ? { ...l, tick: l.tick - len, end: l.end - len } : { ...l, end: Math.min(l.end, from) }))
  // the tempo playing where the gap ends carries on from where it started
  const tempos = [
    ...song.tempos.filter((t) => t.tick < from),
    ...(song.tempos.some((t) => t.tick === to) ? [] : [{ tick: from, bpm: map.bpmAt(to) }]),
    ...song.tempos.filter((t) => t.tick >= to).map((t) => ({ ...t, tick: t.tick - len }))
  ].filter((t, i, all) => i === 0 || t.bpm !== all[i - 1].bpm)
  return { ...cleared, tracks, audioTracks, chords, sections, lyrics, tempos }
}

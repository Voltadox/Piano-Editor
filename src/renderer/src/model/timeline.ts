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

/** What the timeline snaps to as you select, move and crop. */
export type TimelineSnap = 'bar' | 'beat' | '1/8' | '1/16' | 'off'
export const TIMELINE_SNAPS: [TimelineSnap, string][] = [['bar', 'Bar'], ['beat', 'Beat'], ['1/8', '1/8'], ['1/16', '1/16'], ['off', 'Off']]

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
 * Moves a range along the song by some ticks, on its own lanes: what was where it lands is
 * replaced, and where it was is left silent. With `copy`, the original stays too. A drum-machine
 * track moved by whole bars keeps its patterns; otherwise it becomes an ordinary track of its notes.
 */
export function moveRange(song: Song, r: Range, ticks: number, copy = false): Song {
  ticks = Math.max(ticks, -r.from)
  if (!ticks) return song
  const from = r.from + ticks
  const to = r.to + ticks
  const B = ticksPerBar(song)

  const moveTrack = (t: Track): Track => {
    if (t.beat && barAligned(song, r.from, r.to) && ticks % B === 0) {
      const bars = [...t.beat.bars]
      if (!copy) for (let b = r.from / B; b < r.to / B; b++) bars[b] = null
      for (let b = r.from / B; b < r.to / B; b++) bars[b + ticks / B] = t.beat.bars[b] ?? null
      const beat = { ...t.beat, bars: Array.from({ length: bars.length }, (_, i) => bars[i] ?? null) }
      return { ...t, beat, notes: beatNotes(song, beat) }
    }
    const src = t.beat ? freeze(t) : t
    const base = clearNotes(copy ? src : clearNotes(src, r.from, r.to), from, to)
    const inside = <T extends { tick: number }>(x: T): boolean => x.tick >= r.from && x.tick < r.to
    const notes = [...base.notes, ...src.notes.filter(inside).map((n) => ({ ...n, id: copy ? newId() : n.id, tick: n.tick + ticks }))]
    const ccs = [...base.ccs, ...src.ccs.filter(inside).map((c) => ({ ...c, tick: c.tick + ticks }))]
    const bends = [...base.bends, ...src.bends.filter(inside).map((b) => ({ ...b, tick: b.tick + ticks }))]
    // it starts with the pedals and bend as they were where the range started
    for (const num of PEDALS) {
      const v = ccBefore(src.ccs, num, r.from)
      if (v >= 64 && !src.ccs.some((c) => c.num === num && c.tick === r.from)) ccs.push({ tick: from, num, val: v })
    }
    const bend = bendBefore(src.bends, r.from)
    if (bend !== CENTRE && !src.bends.some((b) => b.tick === r.from)) bends.push({ tick: from, val: bend })
    return { ...base, notes: sortNotes(notes), ccs: ccs.sort((a, b) => a.tick - b.tick), bends: bends.sort((a, b) => a.tick - b.tick) }
  }

  const moveClips = (clips: AudioClip[]): AudioClip[] => {
    const parts = clips.map((c) => [c, clipPart(song, c, r.from, r.to)] as const).filter((x): x is readonly [AudioClip, AudioClip] => !!x[1])
    const out = clearClips(song, copy ? clips : clearClips(song, clips, r.from, r.to), from, to)
    for (const [c, p] of parts) out.push({ ...p, id: !copy && p === c ? c.id : newId(), tick: p.tick + ticks })
    return out.sort((a, b) => a.tick - b.tick)
  }

  return {
    ...song,
    tracks: song.tracks.map((t) => (r.tracks.includes(t.id) ? moveTrack(t) : t)),
    audioTracks: song.audioTracks.map((t) => (r.audio.includes(t.id) ? { ...t, clips: moveClips(t.clips) } : t))
  }
}

/** Keeps only the range on its lanes: everything before and after it there is cleared. */
export function cropRange(song: Song, r: Range): Song {
  const end = arrangeEnd(song) + ticksPerBar(song)
  const before = r.from > 0 ? clearRange(song, { ...r, from: 0, to: r.from }) : song
  return r.to < end ? clearRange(before, { ...r, from: r.to, to: end }) : before
}

/**
 * Moves one edge of an audio clip to a tick, cropping it (or, outward, bringing back what was
 * cropped, up to the ends of its take, `takeSec` long). It never gets shorter than a twentieth of a second.
 */
export function trimClip(song: Song, trackId: number, clipId: number, edge: 'start' | 'end', tick: number, takeSec: number): Song {
  const map = tempoMap(song)
  const MIN = 0.05
  return {
    ...song,
    audioTracks: song.audioTracks.map((t) =>
      t.id !== trackId
        ? t
        : {
            ...t,
            clips: t.clips
              .map((c) => {
                if (c.id !== clipId) return c
                const s0 = map.tickToSec(c.tick)
                const s1 = s0 + c.duration
                if (edge === 'end') {
                  const duration = Math.max(MIN, Math.min(takeSec - c.offset, map.tickToSec(tick) - s0))
                  return { ...c, duration, fadeOut: duration < c.duration ? CUT_FADE : c.fadeOut }
                }
                // the start can't go before the take does, nor before the song does
                const start = Math.max(s0 - c.offset, 0, Math.min(s1 - MIN, map.tickToSec(tick)))
                const offset = c.offset + (start - s0)
                return { ...c, tick: map.secToTick(start), offset, duration: s1 - start, fadeIn: offset > 1e-6 ? CUT_FADE : c.fadeIn }
              })
              .sort((a, b) => a.tick - b.tick)
          }
    )
  }
}

/**
 * Crops a block of a note track (`from`..`to`, where its notes run) to start or end at a tick
 * inside it. Notes crossing the new edge are shortened to it.
 */
export function trimNotes(song: Song, trackId: number, from: number, to: number, edge: 'start' | 'end', tick: number): Song {
  if (tick <= from || tick >= to) return song
  return {
    ...song,
    tracks: song.tracks.map((t0) => {
      if (t0.id !== trackId) return t0
      const t = t0.beat ? freeze(t0) : t0
      if (edge === 'end') return clearNotes(t, tick, to)
      const crossing = t.notes.filter((n) => n.tick >= from && n.tick < tick && n.tick + n.dur > tick)
      const cleared = clearNotes(t, from, tick)
      return { ...cleared, notes: sortNotes([...cleared.notes, ...crossing.map((n) => ({ ...n, tick, dur: n.tick + n.dur - tick }))]) }
    })
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

/** The audio tracks that are the reference song: the song itself and its separated stems. */
export function songAudio(song: Song): number[] {
  const ref = song.reference
  return ref ? [ref.trackId, ...(ref.stems ? [ref.stems.vocals, ref.stems.instrumental] : [])] : []
}

/**
 * Moves a clip along the song by some ticks. The reference song moves as one with everything made
 * from it: its stems, the notes to sing, the recreated parts, the chord lane and pad, the lyrics
 * and the drum hits heard in it. Whatever is pulled back past the start of the song is cut off.
 */
export function moveClip(song: Song, trackId: number, clipId: number, ticks: number): Song {
  if (!ticks) return song
  const map = tempoMap(song)
  const whole = songAudio(song).includes(trackId)
  const shiftClip = (c: AudioClip): AudioClip | null => {
    const tick = c.tick + ticks
    if (tick >= 0) return { ...c, tick }
    const lost = -map.tickToSec(tick)
    return c.duration - lost > 0.05 ? { ...c, tick: 0, offset: c.offset + lost, duration: c.duration - lost, fadeIn: CUT_FADE } : null
  }
  const moving = whole ? songAudio(song) : [trackId]
  const audioTracks = song.audioTracks.map((t) => {
    if (!moving.includes(t.id)) return t
    const clips = t.clips.map((c) => (whole || c.id === clipId ? shiftClip(c) : c)).filter((c): c is AudioClip => !!c)
    return { ...t, clips: clips.sort((a, b) => a.tick - b.tick) }
  })
  if (!whole) return { ...song, audioTracks }

  const later = <T extends { tick: number }>(list: T[]): T[] => list.map((x) => ({ ...x, tick: x.tick + ticks })).filter((x) => x.tick >= 0)
  const tracks = song.tracks.map((t) => (t.remake || t.role ? { ...t, notes: later(t.notes), ccs: later(t.ccs), bends: later(t.bends) } : t))
  // the chord in effect at the start of the song stays in effect there
  const moved = song.chords.map((c) => ({ ...c, tick: c.tick + ticks }))
  const before = moved.filter((c) => c.tick < 0).pop()
  const chords = [...(before && !moved.some((c) => c.tick === 0) ? [{ ...before, tick: 0 }] : []), ...moved.filter((c) => c.tick >= 0)]
  const lyrics = song.lyrics.map((l) => ({ ...l, tick: l.tick + ticks, end: l.end + ticks })).filter((l) => l.tick >= 0)
  const ref = song.reference!
  const clip = song.audioTracks.find((t) => t.id === ref.trackId)?.clips[0]
  const secs = clip ? map.tickToSec(clip.tick + ticks) - map.tickToSec(clip.tick) : 0
  const shiftHits = (hits: number[]): number[] => hits.map((h) => h + secs).filter((h) => h >= 0)
  const bars = Math.round(ticks / ticksPerBar(song))
  const barEnergy = bars >= 0 ? [...new Array(bars).fill(0), ...ref.barEnergy] : ref.barEnergy.slice(-bars)
  const reference = { ...ref, drums: { kick: shiftHits(ref.drums.kick), snare: shiftHits(ref.drums.snare), hat: shiftHits(ref.drums.hat) }, barEnergy }
  return { ...song, tracks, audioTracks, chords, lyrics, reference }
}

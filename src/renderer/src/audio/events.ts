import { isAudible, tempoMap, trackTimes, type Song, type Track } from '../model/song'
import { soundSlot } from './fontSlots'

/** A track's mixer settings as MIDI controllers: volume (7), pan (10) and reverb send (91). */
export function mixerCCs(t: Track): [number, number][] {
  const clamp = (v: number): number => Math.max(0, Math.min(127, Math.round(v)))
  return [
    [7, clamp(t.volume * 127)],
    [10, clamp(64 + t.pan * 63)],
    [91, clamp(t.reverb * 127)]
  ]
}

export const OFF = 0
export const PC = 1
export const CC = 2
export const PB = 3
export const ON = 4

export interface PlayEvent {
  time: number
  kind: number
  ch: number
  a: number
  b: number
  /** note id for ON/OFF, -1 otherwise */
  id: number
}

export interface NoteInfo {
  ch: number
  pitch: number
  start: number
  end: number
  audible: boolean
}

export interface EventList {
  events: PlayEvent[]
  notes: Map<number, NoteInfo>
  duration: number
}

/** Flattens the song into time-sorted synth events (seconds). Shared by live playback and export. */
export function buildEvents(song: Song): EventList {
  const map = tempoMap(song)
  const events: PlayEvent[] = []
  const notes = new Map<number, NoteInfo>()
  let duration = 0
  for (const t of song.tracks) {
    const audible = isAudible(t, song)
    const ch = t.channel
    const times = trackTimes(t, map)
    // program change carries the bank in `b` (a preset from another soundfont plays from its slot)
    const slot = soundSlot(t)
    events.push({ time: 0, kind: PC, ch, a: slot.program, b: slot.bank, id: -1 })
    for (const [num, val] of mixerCCs(t)) events.push({ time: 0, kind: CC, ch, a: num, b: val, id: -1 })
    // the mixer owns each track's volume and pan
    for (const c of t.ccs)
      if (c.num !== 7 && c.num !== 10 && c.num !== 0 && c.num !== 32) events.push({ time: map.tickToSec(c.tick), kind: CC, ch, a: c.num, b: c.val, id: -1 })
    for (const b of t.bends) events.push({ time: map.tickToSec(b.tick), kind: PB, ch, a: b.val, b: 0, id: -1 })
    t.notes.forEach((n, i) => {
      const start = times.start[i]
      const end = times.end[i]
      notes.set(n.id, { ch, pitch: n.pitch, start, end, audible })
      duration = Math.max(duration, end)
      // silent tracks (reference notes to sing) are shown but never played
      if (!audible || t.silent) return
      events.push({ time: start, kind: ON, ch, a: n.pitch, b: n.vel, id: n.id })
      events.push({ time: end, kind: OFF, ch, a: n.pitch, b: 0, id: n.id })
    })
  }
  events.sort((x, y) => x.time - y.time || x.kind - y.kind)
  return { events, notes, duration }
}

/** First event index with time >= sec. */
export function eventIndexAt(events: PlayEvent[], sec: number): number {
  let lo = 0
  let hi = events.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (events[mid].time < sec) lo = mid + 1
    else hi = mid
  }
  return lo
}

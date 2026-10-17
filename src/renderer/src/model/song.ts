export interface Note {
  id: number
  pitch: number
  tick: number
  dur: number
  vel: number
}

export interface CC {
  tick: number
  num: number
  val: number
}

export interface Bend {
  tick: number
  /** 0..16383, centre 8192 */
  val: number
}

export interface Track {
  id: number
  name: string
  channel: number
  program: number
  color: string
  muted: boolean
  solo: boolean
  /** Always sorted by tick. */
  notes: Note[]
  ccs: CC[]
  bends: Bend[]
}

export interface Tempo {
  tick: number
  bpm: number
}

export interface Song {
  ppq: number
  tempos: Tempo[]
  timeSig: [number, number]
  tracks: Track[]
}

export const PALETTE = [
  '#4fd1c5', '#f6ad55', '#9f7aea', '#f56565', '#68d391', '#63b3ed',
  '#f687b3', '#ecc94b', '#ed8936', '#81e6d9', '#b794f4', '#fc8181'
]

export const DRUM_CHANNEL = 9
export const LOWEST = 21 // A0
export const HIGHEST = 108 // C8

let nextId = 1
export const newId = (): number => nextId++

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
export const noteName = (p: number): string => NAMES[p % 12] + (Math.floor(p / 12) - 1)
export const isBlack = (p: number): boolean => [1, 3, 6, 8, 10].includes(p % 12)

export const sortNotes = (notes: Note[]): Note[] => notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch)

export function newTrack(song: Song, name?: string): Track {
  const used = new Set(song.tracks.map((t) => t.channel))
  let channel = 0
  while ((used.has(channel) || channel === DRUM_CHANNEL) && channel < 15) channel++
  if (used.has(channel)) channel = 0
  return {
    id: newId(),
    name: name ?? `Track ${song.tracks.length + 1}`,
    channel,
    program: 0,
    color: PALETTE[song.tracks.length % PALETTE.length],
    muted: false,
    solo: false,
    notes: [],
    ccs: [],
    bends: []
  }
}

export function emptySong(): Song {
  const song: Song = { ppq: 480, tempos: [{ tick: 0, bpm: 120 }], timeSig: [4, 4], tracks: [] }
  song.tracks.push(newTrack(song, 'Piano'))
  return song
}

/** A short two-hand loop so the editor opens with something to look at. */
export function demoSong(): Song {
  const song: Song = { ppq: 480, tempos: [{ tick: 0, bpm: 100 }], timeSig: [4, 4], tracks: [] }
  const left = newTrack(song, 'Left hand')
  song.tracks.push(left)
  const right = newTrack(song, 'Right hand')
  right.channel = 0
  song.tracks.push(right)
  const q = song.ppq
  const chords = [[48, 52, 55], [45, 48, 52], [41, 45, 48], [43, 47, 50]]
  for (let rep = 0; rep < 2; rep++) {
    chords.forEach((c, i) => {
      const bar = (rep * 4 + i) * q * 4
      left.notes.push({ id: newId(), pitch: c[0] - 12, tick: bar, dur: q * 4 - 20, vel: 80 })
      left.notes.push({ id: newId(), pitch: c[0], tick: bar, dur: q * 4 - 20, vel: 70 })
      const arp = [c[0] + 12, c[1] + 12, c[2] + 12, c[0] + 24, c[2] + 12, c[1] + 12, c[2] + 12, c[0] + 24]
      arp.forEach((p, j) => right.notes.push({ id: newId(), pitch: p, tick: bar + (j * q) / 2, dur: q / 2 - 10, vel: 90 }))
    })
  }
  sortNotes(left.notes)
  sortNotes(right.notes)
  return song
}

// ---------- tempo map ----------

interface Seg {
  tick: number
  sec: number
  spt: number // seconds per tick
}

export class TempoMap {
  readonly segs: Seg[] = []
  constructor(
    tempos: Tempo[],
    readonly ppq: number
  ) {
    const sorted = [...tempos].sort((a, b) => a.tick - b.tick)
    if (!sorted.length || sorted[0].tick > 0) sorted.unshift({ tick: 0, bpm: sorted[0]?.bpm ?? 120 })
    let sec = 0
    sorted.forEach((t, i) => {
      if (i > 0) {
        const p = this.segs[this.segs.length - 1]
        sec = p.sec + (t.tick - p.tick) * p.spt
      }
      const seg = { tick: t.tick, sec, spt: 60 / (t.bpm * ppq) }
      if (this.segs.length && this.segs[this.segs.length - 1].tick === t.tick) this.segs[this.segs.length - 1] = seg
      else this.segs.push(seg)
    })
  }
  tickToSec(tick: number): number {
    const s = this.find((g) => g.tick <= tick)
    return s.sec + (tick - s.tick) * s.spt
  }
  secToTick(sec: number): number {
    const s = this.find((g) => g.sec <= sec)
    return s.tick + (sec - s.sec) / s.spt
  }
  bpmAt(tick: number): number {
    return 60 / (this.find((g) => g.tick <= tick).spt * this.ppq)
  }
  private find(pred: (s: Seg) => boolean): Seg {
    let lo = 0
    let hi = this.segs.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (pred(this.segs[mid])) lo = mid
      else hi = mid - 1
    }
    return this.segs[lo]
  }
}

const tempoCache = new WeakMap<Tempo[], { ppq: number; map: TempoMap }>()
export function tempoMap(song: Song): TempoMap {
  const hit = tempoCache.get(song.tempos)
  if (hit && hit.ppq === song.ppq) return hit.map
  const map = new TempoMap(song.tempos, song.ppq)
  tempoCache.set(song.tempos, { ppq: song.ppq, map })
  return map
}

/** Note start/end times in seconds, cached per track object + tempo map. */
export interface TrackTimes {
  start: Float64Array
  end: Float64Array
  maxDur: number
}
const timesCache = new WeakMap<Track, { map: TempoMap; times: TrackTimes }>()
export function trackTimes(track: Track, map: TempoMap): TrackTimes {
  const hit = timesCache.get(track)
  if (hit && hit.map === map) return hit.times
  const n = track.notes.length
  const start = new Float64Array(n)
  const end = new Float64Array(n)
  let maxDur = 0
  for (let i = 0; i < n; i++) {
    const note = track.notes[i]
    start[i] = map.tickToSec(note.tick)
    end[i] = map.tickToSec(note.tick + note.dur)
    maxDur = Math.max(maxDur, end[i] - start[i])
  }
  const times = { start, end, maxDur }
  timesCache.set(track, { map, times })
  return times
}

/** First index whose start >= sec. */
export function lowerBound(arr: Float64Array, sec: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] < sec) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function songEndTick(song: Song): number {
  let end = 0
  for (const t of song.tracks) for (const n of t.notes) end = Math.max(end, n.tick + n.dur)
  return end
}

export function songDuration(song: Song): number {
  return tempoMap(song).tickToSec(songEndTick(song))
}

export const ticksPerBeat = (song: Song): number => (song.ppq * 4) / song.timeSig[1]
export const ticksPerBar = (song: Song): number => ticksPerBeat(song) * song.timeSig[0]

export function isAudible(track: Track, song: Song): boolean {
  const anySolo = song.tracks.some((t) => t.solo)
  return !track.muted && (!anySolo || track.solo)
}

// ---------- snapping ----------

export type Snap = '1/4' | '1/8' | '1/16' | '1/32' | '1/8T' | '1/16T' | 'off'
export const SNAPS: Snap[] = ['1/4', '1/8', '1/16', '1/32', '1/8T', '1/16T', 'off']

export function snapTicks(ppq: number, snap: Snap): number {
  switch (snap) {
    case '1/4': return ppq
    case '1/8': return ppq / 2
    case '1/16': return ppq / 4
    case '1/32': return ppq / 8
    case '1/8T': return ppq / 3
    case '1/16T': return ppq / 6
    case 'off': return 1
  }
}

export const snapTo = (tick: number, grid: number): number => Math.round(tick / grid) * grid

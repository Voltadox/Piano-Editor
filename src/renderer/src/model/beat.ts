import { newId, ticksPerBar, type Note, type Song } from './song'

/** A drum-machine part: a few patterns and which one plays in each bar. Its notes are generated from this. */
export interface Beat {
  patterns: Pattern[]
  /** pattern id for each bar from the start of the song; null is a silent bar */
  bars: (number | null)[]
  /** 0 straight .. 0.6 heavy swing on the off-beat sixteenths */
  swing: number
  /** the style it was generated in, if any */
  style?: string
}

export interface Pattern {
  id: number
  name: string
  /** drum pitch -> velocity per step (0 = no hit) */
  hits: Record<number, number[]>
}

export interface DrumLane {
  pitch: number
  name: string
}

/** General MIDI drum sounds offered in the grid, top to bottom. */
export const DRUM_LANES: DrumLane[] = [
  { pitch: 49, name: 'Crash' },
  { pitch: 51, name: 'Ride' },
  { pitch: 46, name: 'Open hat' },
  { pitch: 42, name: 'Closed hat' },
  { pitch: 39, name: 'Clap' },
  { pitch: 38, name: 'Snare' },
  { pitch: 37, name: 'Rim' },
  { pitch: 50, name: 'High tom' },
  { pitch: 45, name: 'Low tom' },
  { pitch: 36, name: 'Kick' }
]

/** Sixteenth-note steps in one bar of this song's time signature. */
export const stepsPerBar = (song: Song): number => Math.max(1, Math.round(ticksPerBar(song) / (song.ppq / 4)))

export function emptyPattern(song: Song, name: string): Pattern {
  const n = stepsPerBar(song)
  const hits: Record<number, number[]> = {}
  for (const l of DRUM_LANES) hits[l.pitch] = new Array(n).fill(0)
  return { id: newId(), name, hits }
}

/** The notes a beat plays, bar by bar, with swing applied to off-beat sixteenths. */
export function beatNotes(song: Song, beat: Beat): Note[] {
  const bar = ticksPerBar(song)
  const steps = stepsPerBar(song)
  const step = bar / steps
  const notes: Note[] = []
  beat.bars.forEach((pid, b) => {
    const p = beat.patterns.find((x) => x.id === pid)
    if (!p) return
    for (const [pitch, row] of Object.entries(p.hits)) {
      for (let s = 0; s < Math.min(steps, row.length); s++) {
        const vel = row[s]
        if (!vel) continue
        const swing = s % 2 === 1 ? beat.swing * step * 0.5 : 0
        notes.push({ id: newId(), pitch: Number(pitch), tick: Math.round(b * bar + s * step + swing), dur: Math.round(step * 0.5), vel })
      }
    }
  })
  return notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch)
}

import { tempoMap, ticksPerBar, type Song } from './song'

/** How much the last release counts against the note starts when fitting a beat (1/s² against s²). */
const END_WEIGHT = 0.005

/**
 * The beat length and first downbeat (seconds) of a passage played without a click, taken to last
 * `beats` beats from its first note to its last release. The release only says roughly how long a
 * beat is (a last chord is often let go early, or left ringing): the beat is the one, within 12% of
 * that, whose beats the note starts sit closest to.
 */
export function loopBeat(onsets: number[], end: number, beats: number): { beat: number; downbeat: number } {
  const sorted = [...onsets].sort((a, b) => a - b)
  const guess = (end - sorted[0]) / beats
  // a chord's notes land within a few milliseconds of each other: count each chord once
  const hits: number[] = []
  for (const t of sorted) if (!hits.length || t - hits[hits.length - 1] > 0.04) hits.push(t)
  let best = { cost: Infinity, beat: guess, downbeat: sorted[0] }
  for (let f = 0.88; f <= 1.12; f += 0.0005) {
    const beat = guess * f
    // the downbeat that best fits the starts, settled in two passes
    let downbeat = hits[0]
    let ks: number[] = []
    for (let pass = 0; pass < 2; pass++) {
      ks = hits.map((t) => Math.round((t - downbeat) / beat))
      downbeat = hits.reduce((s, t, i) => s + t - ks[i] * beat, 0) / hits.length
    }
    const spread = hits.reduce((s, t, i) => s + (t - downbeat - ks[i] * beat) ** 2, 0) / hits.length
    const cost = spread + END_WEIGHT * (downbeat + beats * beat - end) ** 2
    if (cost < best.cost) best = { cost, beat, downbeat }
  }
  return { beat: best.beat, downbeat: best.downbeat }
}

/** Quarter notes per minute for a beat of this many seconds in this song's time signature. */
export const bpmOf = (song: Song, beat: number): number => 60 / ((beat * song.timeSig[1]) / 4)

/**
 * The song with a new steady tempo, every position moved so it still sounds at the same moment:
 * `toTick` gives the new tick for a time in seconds. A drum-machine beat is laid out in bars, so it
 * stays on its bars. Anything that would land before the start is pulled to it (audio is trimmed).
 */
export function retime(song: Song, bpm: number, toTick: (sec: number) => number): Song {
  const map = tempoMap(song)
  const k = (tick: number): number => Math.max(0, Math.round(toTick(map.tickToSec(tick))))
  const spt = 60 / (bpm * song.ppq)
  const bar = ticksPerBar(song)
  return {
    ...song,
    tempos: [{ tick: 0, bpm }],
    tracks: song.tracks.map((t) =>
      t.beat
        ? t
        : {
            ...t,
            notes: t.notes.map((n) => ({ ...n, tick: k(n.tick), dur: Math.max(1, k(n.tick + n.dur) - k(n.tick)) })),
            ccs: t.ccs.map((c) => ({ ...c, tick: k(c.tick) })),
            bends: t.bends.map((b) => ({ ...b, tick: k(b.tick) }))
          }
    ),
    audioTracks: song.audioTracks.map((t) => ({
      ...t,
      clips: t.clips.flatMap((c) => {
        const at = toTick(map.tickToSec(c.tick))
        if (at >= 0) return [{ ...c, tick: Math.round(at) }]
        // starts before the song now does: keep only what comes after
        const cut = -at * spt
        return c.duration > cut ? [{ ...c, tick: 0, offset: c.offset + cut, duration: c.duration - cut }] : []
      })
    })),
    chords: song.chords.map((c) => ({ ...c, tick: k(c.tick) })),
    lyrics: song.lyrics.map((l) => ({ ...l, tick: k(l.tick), end: k(l.end) })),
    sections: song.sections.map((s) => ({ ...s, bar: Math.round(k(s.bar * bar) / bar) }))
  }
}

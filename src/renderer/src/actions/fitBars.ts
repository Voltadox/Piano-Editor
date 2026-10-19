import { engine } from '../audio/engine'
import { bpmOf, loopBeat, retime } from '../model/fit'
import { tempoMap, ticksPerBar, ticksPerBeat, type Song } from '../model/song'
import { getState } from '../state/store'

/** Bar counts offered for fitting a passage, when the tempo they give is a playable one. */
const BAR_CHOICES = [1, 2, 4, 8, 16]

interface Fit {
  bars: number
  bpm: number
  /** seconds: where the passage's first bar starts */
  downbeat: number
}

/** How the selected notes would fit into `bars` bars: the tempo and where they start. */
function plan(song: Song, selection: Set<number>, bars: number): Fit | null {
  const map = tempoMap(song)
  const onsets: number[] = []
  let end = -Infinity
  for (const t of song.tracks)
    for (const n of t.notes)
      if (selection.has(n.id)) {
        onsets.push(map.tickToSec(n.tick))
        end = Math.max(end, map.tickToSec(n.tick + n.dur))
      }
  if (onsets.length < 2 || !(end > Math.min(...onsets))) return null
  const { beat, downbeat } = loopBeat(onsets, end, bars * song.timeSig[0])
  return { bars, bpm: Math.round(bpmOf(song, beat) * 100) / 100, downbeat }
}

/** The bar counts the selection could become, each with the tempo it gives. */
export function fitChoices(): Fit[] {
  const { song, selection } = getState()
  return BAR_CHOICES.map((b) => plan(song, selection, b)).filter((f): f is Fit => !!f && f.bpm >= 40 && f.bpm <= 240)
}

/**
 * Makes the selected notes last exactly `bars` bars: sets the tempo they were played at and moves
 * the bar lines so the first one starts a bar. Nothing changes how it sounds, notes and vocals
 * included; only the grid moves. The passage then loops.
 */
export function fitToBars(bars: number): void {
  const { song, selection } = getState()
  if (song.reference) {
    getState().notify('This song follows its reference song\'s tempo. Use ×2 or ÷2 in the Reference tab if its bars are the wrong length.')
    return
  }
  const fit = plan(song, selection, bars)
  if (!fit) {
    getState().notify('Select the notes of the passage first (at least two).')
    return
  }
  const map = tempoMap(song)
  const spt = 60 / (fit.bpm * song.ppq)
  const bar = ticksPerBar(song)
  // the passage starts on a bar line; anything played before it keeps whole bars in front of it
  let first = fit.downbeat
  for (const t of song.tracks) if (!t.beat && t.notes.length) first = Math.min(first, map.tickToSec(t.notes[0].tick))
  for (const t of song.audioTracks) for (const c of t.clips) first = Math.min(first, map.tickToSec(c.tick))
  for (const l of song.lyrics) first = Math.min(first, map.tickToSec(l.tick))
  // a note a touch ahead of the first beat doesn't need a bar of its own
  const lead = Math.max(0, Math.ceil(((fit.downbeat - first) / spt - ticksPerBeat(song) / 2) / bar))
  const toTick = (sec: number): number => (sec - fit.downbeat) / spt + lead * bar
  getState().apply((s) => retime(s, fit.bpm, toTick))
  getState().set({ loop: { start: lead * bar, end: (lead + bars) * bar }, loopOn: true })
  engine.seek(lead * bar * spt)
  getState().notify(`Tempo set to ${fit.bpm} BPM: the selection fills bars ${lead + 1}–${lead + bars} and loops. Ctrl+Z puts it back.`)
}

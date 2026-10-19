import { arrangeEnd, clearRange, removeBars, repeatRange, type Range } from '../model/timeline'
import { ticksPerBar } from '../model/song'
import { savePref } from '../state/prefs'
import { getState } from '../state/store'
import { setLoop } from './transport'

/** Switches between the falling-notes stage and the timeline of every track. */
export function toggleTimeline(): void {
  const on = !getState().timeline
  // note selections and timeline ranges don't carry across: each view edits its own way
  getState().set({ timeline: on, tlRange: null, selection: new Set(), contextMenu: null })
  savePref('timeline', on)
}

const bars = (song: Parameters<typeof ticksPerBar>[0], r: { from: number; to: number }): number => (r.to - r.from) / ticksPerBar(song)
const barsText = (n: number): string => `${Number.isInteger(n) ? n : n.toFixed(2)} bar${n === 1 ? '' : 's'}`

/** Silences the timeline's range on its lanes. */
export function clearTimelineRange(): void {
  const r = getState().tlRange
  if (!r) return
  getState().apply((s) => clearRange(s, r))
}

/**
 * Plays the timeline's range again straight after itself: `times` times, or (`'end'`) until the
 * song ends. The range then covers everything it filled, so it can be cut into straight away.
 */
export function repeatTimelineRange(times: number | 'end'): void {
  const r = getState().tlRange
  if (!r) return
  const len = r.to - r.from
  const end = arrangeEnd(getState().song)
  const n = times === 'end' ? Math.ceil((end - r.to) / len) : times
  if (n < 1) {
    getState().notify('Nothing in the song comes after this range to repeat it up to. Pick a number of times instead.', 'error')
    return
  }
  getState().apply((s) => repeatRange(s, r, n, times === 'end' ? end : Infinity))
  const to = times === 'end' ? end : r.to + n * len
  getState().set({ tlRange: { ...r, to } })
}

/** Takes the range's bars out of the whole song and closes the gap. */
export function removeTimelineBars(): void {
  const r = getState().tlRange
  if (!r) return
  const song = getState().song
  const B = ticksPerBar(song)
  const from = Math.floor(r.from / B) * B
  const to = Math.max(from + B, Math.ceil(r.to / B) * B)
  getState().apply((s) => removeBars(s, from, to))
  getState().set({ tlRange: null })
  getState().notify(`Took out ${barsText(bars(song, { from, to }))} from every track; everything after moved back.`)
}

export function loopTimelineRange(): void {
  const r = getState().tlRange
  if (r) setLoop(r.from, r.to)
}

/**
 * From the falling-notes stage: repeats the selected notes' bars, `times` times or to the end of
 * the song. Only the selected notes are copied.
 */
export function repeatSelection(times: number | 'end'): void {
  const { song, selection } = getState()
  const B = ticksPerBar(song)
  let lo = Infinity
  let hi = -Infinity
  const tracks: number[] = []
  for (const t of song.tracks)
    for (const n of t.notes)
      if (selection.has(n.id)) {
        lo = Math.min(lo, n.tick)
        hi = Math.max(hi, n.tick + n.dur)
        if (!tracks.includes(t.id)) tracks.push(t.id)
      }
  if (!tracks.length) return
  const r: Range = { from: Math.floor(lo / B) * B, to: Math.max(Math.ceil(hi / B), Math.floor(lo / B) + 1) * B, tracks, audio: [] }
  const len = r.to - r.from
  const end = repeatEnd(song, r)
  const n = times === 'end' ? Math.ceil((end - r.to) / len) : times
  if (n < 1) return
  getState().apply((s) => repeatRange(s, r, n, times === 'end' ? end : Infinity, new Set(selection)))
  getState().notify(`Repeated ${barsText(len / B)} ${times === 'end' ? 'to the end of the song' : `${n} more time${n === 1 ? '' : 's'}`}. Ctrl+Z undoes it.`)
}

/** Where repeating a range to the end of the song stops (the range's own end if nothing comes after it). */
export function repeatEnd(song: Parameters<typeof arrangeEnd>[0], r: { to: number }): number {
  return Math.max(r.to, arrangeEnd(song))
}

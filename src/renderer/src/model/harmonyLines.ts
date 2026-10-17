import type { SungNote } from './melody'

export interface HeardNote {
  start: number
  end: number
  pitch: number
  amp: number
}

/**
 * Harmony lines in a separated vocal: of every note heard in it, the ones sung alongside the lead
 * that aren't the lead itself (or its octave). Fragments of one held note are joined, faint
 * overtone ghosts and very short notes are dropped, and the rest is split into the part above
 * the lead and the part below it.
 */
export function harmonyLines(heard: HeardNote[], lead: SungNote[]): { above: SungNote[]; below: SungNote[] } {
  const joined: HeardNote[] = []
  for (const n of [...heard].sort((a, b) => a.pitch - b.pitch || a.start - b.start)) {
    const last = joined[joined.length - 1]
    if (last && last.pitch === n.pitch && n.start - last.end < 0.06) {
      last.end = Math.max(last.end, n.end)
      last.amp = Math.max(last.amp, n.amp)
    } else joined.push({ ...n })
  }
  const above: SungNote[] = []
  const below: SungNote[] = []
  for (const n of joined) {
    if (n.amp < 0.45 || n.end - n.start < 0.15) continue
    // the lead note sounding over most of this note
    let best: SungNote | null = null
    let overlap = 0
    for (const l of lead) {
      const o = Math.min(l.end, n.end) - Math.max(l.start, n.start)
      if (o > overlap) {
        overlap = o
        best = l
      }
    }
    if (!best || overlap < 0.5 * (n.end - n.start)) continue
    const d = n.pitch - best.pitch
    if (Math.abs(d) <= 1 || Math.abs(d) === 12 || Math.abs(d) > 12) continue
    const note = { start: n.start, end: n.end, pitch: n.pitch, vel: Math.round(40 + 70 * Math.min(1, n.amp)) }
    ;(d > 0 ? above : below).push(note)
  }
  const byTime = (a: SungNote, b: SungNote): number => a.start - b.start
  return { above: above.sort(byTime), below: below.sort(byTime) }
}

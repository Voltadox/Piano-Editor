import type { Note } from './song'

type Played = Omit<Note, 'id'>

/** Widest interval one hand plays comfortably (a tenth). */
const REACH = 16
const MAX_FINGERS = 5
/** Cost of a stretch or note count the hand can't manage; high, but a fallback when nothing fits. */
const IMPOSSIBLE = 40
const CROSSING = 8

interface Hand {
  /** where the hand is sitting, as a pitch */
  centre: number
  /** notes this hand is still holding: end tick and pitch */
  holding: { end: number; pitch: number }[]
}

/**
 * Guesses which hand played each note of a recording. Notes struck together are grouped, and every
 * way of splitting a group into a lower part (left hand) and upper part (right hand) is scored:
 * each note's distance from its hand, a penalty for crossing over the other hand, and a large one
 * for a stretch or note count the hand couldn't manage alongside what it is still holding. Each
 * hand's position then follows what it just played.
 */
export function splitHands(notes: Played[], togetherTicks: number): { left: Played[]; right: Played[] } {
  const sorted = [...notes].sort((a, b) => a.tick - b.tick || a.pitch - b.pitch)
  const left: Played[] = []
  const right: Played[] = []
  if (!sorted.length) return { left, right }

  // start the hands either side of the first notes (around middle C if they don't say)
  const first = sorted.filter((n) => n.tick - sorted[0].tick <= togetherTicks).map((n) => n.pitch)
  const L: Hand = { centre: Math.min(52, Math.min(...first)), holding: [] }
  const R: Hand = { centre: Math.max(67, Math.max(...first)), holding: [] }

  const cost = (h: Hand, pitches: number[], other: Hand, isLeft: boolean): number => {
    if (!pitches.length) return 0
    const all = [...h.holding.map((x) => x.pitch), ...pitches]
    let c = Math.max(...all) - Math.min(...all) > REACH || all.length > MAX_FINGERS ? IMPOSSIBLE : 0
    for (const p of pitches) {
      c += Math.abs(p - h.centre)
      if (isLeft ? p > other.centre : p < other.centre) c += CROSSING
    }
    return c
  }
  const take = (h: Hand, group: Played[], into: Played[]): void => {
    if (!group.length) return
    for (const n of group) {
      into.push(n)
      h.holding.push({ end: n.tick + n.dur, pitch: n.pitch })
    }
    const mid = group.reduce((a, n) => a + n.pitch, 0) / group.length
    h.centre = h.centre * 0.5 + mid * 0.5
  }

  let i = 0
  while (i < sorted.length) {
    const start = sorted[i].tick
    const group: Played[] = []
    while (i < sorted.length && sorted[i].tick - start <= togetherTicks) group.push(sorted[i++])
    group.sort((a, b) => a.pitch - b.pitch)
    L.holding = L.holding.filter((x) => x.end > start)
    R.holding = R.holding.filter((x) => x.end > start)

    // cut = how many of the lowest notes go to the left hand
    const pitches = group.map((n) => n.pitch)
    let best = 0
    let bestCost = Infinity
    for (let cut = 0; cut <= group.length; cut++) {
      const c = cost(L, pitches.slice(0, cut), R, true) + cost(R, pitches.slice(cut), L, false)
      if (c < bestCost) {
        bestCost = c
        best = cut
      }
    }
    take(L, group.slice(0, best), left)
    take(R, group.slice(best), right)
  }
  return { left, right }
}

/**
 * Moving sung words in time: a word is cut out of its clip halfway through the silence either
 * side and moved as a clip of its own. The silence it moves into is trimmed off the neighbouring
 * pieces, but never a sung note. Pure functions, in seconds.
 */

/** Notes closer together than this (seconds) are one word, and move together. */
export const WORD_GAP = 0.1
/** Space kept between a moved word and the singing next to it, so a breath isn't clipped. */
const KEEP = 0.02
/** Fade on a new cut, so it doesn't click. */
const CUT_FADE = 0.015

export interface Span {
  start: number
  end: number
}

/** A clip as the planner sees it: where it plays in the song, and which part of which take. */
export interface Piece {
  id: number
  /** song seconds where it starts */
  start: number
  /** seconds into the take where it begins */
  offset: number
  duration: number
  takeId: string
  fadeIn: number
  fadeOut: number
}

/**
 * The word a moment of a take belongs to: the note sung then, with any notes joined to it by less
 * than WORD_GAP, and the cut points halfway through the silence before and after it (open-ended at
 * the first and last notes).
 */
export function wordAt(notes: Span[], at: number): { from: number; to: number; cutBefore: number; cutAfter: number } | null {
  const sorted = [...notes].sort((a, b) => a.start - b.start)
  const i = sorted.findIndex((n) => at >= n.start && at < n.end)
  if (i < 0) return null
  let lo = i
  let hi = i
  while (lo > 0 && sorted[lo].start - sorted[lo - 1].end < WORD_GAP) lo--
  while (hi < sorted.length - 1 && sorted[hi + 1].start - sorted[hi].end < WORD_GAP) hi++
  const from = sorted[lo].start
  const to = sorted[hi].end
  return {
    from,
    to,
    cutBefore: lo > 0 ? (sorted[lo - 1].end + from) / 2 : -Infinity,
    cutAfter: hi < sorted.length - 1 ? (to + sorted[hi + 1].start) / 2 : Infinity
  }
}

/**
 * The track's clips after moving the word sung at `at` (take seconds) in clip `clipId` by `delta`
 * seconds, with the move held back where it would cut into neighbouring singing or start before
 * the song. `notes` are the take's notes. Returns the new pieces and how far the word really moved.
 */
export function planWordMove(pieces: Piece[], clipId: number, notes: Span[], at: number, delta: number, newId: () => number): { pieces: Piece[]; moved: number; word: Span } | null {
  const c = pieces.find((p) => p.id === clipId)
  const w = wordAt(notes, at)
  if (!c || !w) return null
  const origin = c.start - c.offset
  const end = c.offset + c.duration
  const cb = Math.max(c.offset, w.cutBefore)
  const ca = Math.min(end, w.cutAfter)
  if (ca - cb < 0.03) return null
  const out = pieces.filter((p) => p !== c)
  if (cb > c.offset + 0.01) out.push({ ...c, duration: cb - c.offset, fadeOut: CUT_FADE })
  const word: Piece = { ...c, id: cb > c.offset + 0.01 ? newId() : c.id, start: origin + cb, offset: cb, duration: ca - cb, fadeIn: cb > c.offset + 0.01 ? CUT_FADE : c.fadeIn, fadeOut: ca < end - 0.01 ? CUT_FADE : c.fadeOut }
  if (ca < end - 0.01) out.push({ ...c, id: newId(), start: origin + ca, offset: ca, duration: end - ca, fadeIn: CUT_FADE })

  // how far it may go: not into the singing of the same take's other pieces, and not before the song
  const sungIn = (p: Piece): Span[] => notes.filter((n) => n.end > p.offset && n.start < p.offset + p.duration)
  let lo = -word.start
  let hi = Infinity
  for (const p of out) {
    if (p.takeId !== c.takeId) continue
    const sung = sungIn(p)
    if (!sung.length) continue
    const pOrigin = p.start - p.offset
    if (p.start < word.start) lo = Math.max(lo, pOrigin + Math.max(...sung.map((n) => Math.min(n.end, p.offset + p.duration))) + KEEP - (origin + w.from))
    else hi = Math.min(hi, pOrigin + Math.min(...sung.map((n) => Math.max(n.start, p.offset))) - KEEP - (origin + w.to))
  }
  const moved = Math.max(lo, Math.min(hi, delta))
  if (lo > hi) return { pieces, moved: 0, word: { start: w.from, end: w.to } }
  word.start += moved
  // the silence carried either side of the word gives way to neighbouring singing it now overlaps
  for (const p of out) {
    if (p.takeId !== c.takeId) continue
    const sung = sungIn(p)
    if (!sung.length) continue
    const pOrigin = p.start - p.offset
    if (p.start < word.start - moved) {
      const singEnd = pOrigin + Math.max(...sung.map((n) => Math.min(n.end, p.offset + p.duration))) + KEEP
      if (word.start < singEnd) {
        const cut = singEnd - word.start
        Object.assign(word, { start: singEnd, offset: word.offset + cut, duration: word.duration - cut, fadeIn: CUT_FADE })
      }
    } else {
      const singStart = pOrigin + Math.min(...sung.map((n) => Math.max(n.start, p.offset))) - KEEP
      if (word.start + word.duration > singStart) Object.assign(word, { duration: singStart - word.start, fadeOut: CUT_FADE })
    }
  }
  const wEnd = word.start + word.duration

  // trim the silence it now overlaps off the pieces either side
  const result: Piece[] = [word]
  for (const p of out) {
    const pEnd = p.start + p.duration
    if (p.takeId === c.takeId && p.start < word.start && pEnd > word.start) {
      const duration = word.start - p.start
      if (duration >= 0.03) result.push({ ...p, duration, fadeOut: CUT_FADE })
    } else if (p.takeId === c.takeId && p.start >= word.start - moved && p.start < wEnd && pEnd > wEnd) {
      const cut = wEnd - p.start
      if (p.duration - cut >= 0.03) result.push({ ...p, start: wEnd, offset: p.offset + cut, duration: p.duration - cut, fadeIn: CUT_FADE })
    } else result.push(p)
  }
  result.sort((a, b) => a.start - b.start)
  return { pieces: result, moved, word: { start: w.from, end: w.to } }
}

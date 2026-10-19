import { detectPitch, HOP_SEC, hzToMidi, segmentNotes } from '../audio/pitch'

export interface SungNote {
  /** seconds into the audio */
  start: number
  end: number
  pitch: number
  vel: number
}

/**
 * The notes a voice sings: pitch is tracked every 10 ms and split into notes where the voice
 * moves to a new pitch (see segmentNotes); very short notes are dropped and repeated notes split
 * by a tiny gap are joined.
 */
export function melodyNotes(pcm: Float32Array, rate: number): SungNote[] {
  const f0 = detectPitch(pcm, rate)
  const hop = Math.round(rate * HOP_SEC)
  const midi = Array.from(f0, (f) => (f > 0 ? hzToMidi(f) : NaN))
  const loud = Array.from(f0, (_, i) => {
    let s = 0
    const a = i * hop
    const b = Math.min(pcm.length, a + hop)
    for (let j = a; j < b; j++) s += pcm[j] * pcm[j]
    return Math.sqrt(s / Math.max(1, b - a))
  })
  const notes: SungNote[] = []
  for (const { start, end } of segmentNotes(midi)) {
    if ((end - start) * HOP_SEC < 0.08) continue
    const run = midi.slice(start, end).sort((a, b) => a - b)
    const pitch = Math.round(run[run.length >> 1])
    const peak = Math.max(...loud.slice(start, end))
    notes.push({ start: start * HOP_SEC, end: end * HOP_SEC, pitch, vel: Math.max(40, Math.min(120, Math.round(40 + peak * 400))) })
  }
  // join repeats split by a breath shorter than 60 ms
  const joined: SungNote[] = []
  for (const n of notes) {
    const last = joined[joined.length - 1]
    if (last && last.pitch === n.pitch && n.start - last.end < 0.06) last.end = n.end
    else joined.push({ ...n })
  }
  return joined
}

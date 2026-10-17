import { detectPitch, HOP_SEC, hzToMidi } from '../audio/pitch'

export interface SungNote {
  /** seconds into the audio */
  start: number
  end: number
  pitch: number
  vel: number
}

/**
 * The notes a voice sings: pitch is tracked every 10 ms, and a note runs while the voice stays
 * near one pitch. A move of more than ¾ of a semitone that lasts 40 ms starts the next note;
 * very short notes are dropped and repeated notes split by a tiny gap are joined.
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
  let i = 0
  while (i < midi.length) {
    if (Number.isNaN(midi[i])) {
      i++
      continue
    }
    const start = i
    let centre = midi[i]
    let away = 0
    let j = i + 1
    for (; j < midi.length && !Number.isNaN(midi[j]); j++) {
      if (Math.abs(midi[j] - centre) > 0.75) {
        if (++away >= 4) {
          j -= away - 1
          break
        }
      } else {
        away = 0
        // follow slow drift, so vibrato and scoops stay one note
        centre += (midi[j] - centre) * 0.1
      }
    }
    const run = midi.slice(start, j).filter((m) => !Number.isNaN(m)).sort((a, b) => a - b)
    const pitch = Math.round(run[run.length >> 1])
    const peak = Math.max(...loud.slice(start, j))
    if ((j - start) * HOP_SEC >= 0.08) notes.push({ start: start * HOP_SEC, end: j * HOP_SEC, pitch, vel: Math.max(40, Math.min(120, Math.round(40 + peak * 400))) })
    i = Math.max(j, start + 1)
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

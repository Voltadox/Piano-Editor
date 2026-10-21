import { newTrack } from '../model/song'
import { GEN_PARTS, generatePart, type GenSettings } from '../model/trackgen'
import { getState, useStore } from './store'

const NO_CHORDS = 'There are no chords to follow yet. Play some chords on a track (or bring in a song for its chord lane), then try again.'

export const newSeed = (): number => Math.floor(Math.random() * 2 ** 31)

/**
 * Adds a generated part as a new track, playing the sound picked for it, as one undo step.
 * Returns false (and says why) when there was nothing to write it to.
 */
export function addGeneratedTrack(gen: GenSettings, sound: { bank: number; program: number; font?: string }): boolean {
  const part = GEN_PARTS.find((p) => p.id === gen.part) ?? GEN_PARTS[0]
  const { notes, ccs } = generatePart(getState().song, gen)
  if (!notes.length) {
    getState().notify(NO_CHORDS, 'error')
    return false
  }
  let id = -1
  getState().apply((s) => {
    const t = { ...newTrack(s, part.name), ...sound, notes, ccs, gen, volume: part.volume, reverb: part.reverb }
    id = t.id
    return { ...s, tracks: [...s.tracks, t] }
  })
  useStore.setState({ activeTrackId: id })
  getState().notify(`Added ${part.name} (${notes.length} notes). The ↻ button on its card writes another variation; Ctrl+Z takes it away.`)
  return true
}

/** Writes another variation of a generated track in place, keeping its sound and mix. */
export function regenerateTrack(id: number): void {
  const t = getState().song.tracks.find((x) => x.id === id)
  if (!t?.gen) return
  const gen = { ...t.gen, seed: newSeed() }
  const { notes, ccs } = generatePart(getState().song, gen)
  if (!notes.length) {
    getState().notify(NO_CHORDS, 'error')
    return
  }
  getState().apply((s) => ({ ...s, tracks: s.tracks.map((x) => (x.id === id ? { ...x, notes, ccs, gen } : x)) }))
}

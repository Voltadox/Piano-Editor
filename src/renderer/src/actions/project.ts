import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { ensureTakes, putTake, takeWav } from '../audio/takes'
import { decodeWavMono } from '../audio/wav'
import { normalizeSong, reserveIds, type Song } from '../model/song'

/**
 * A .keyfall song file: a zip holding the song as JSON and every recorded take it uses as a WAV,
 * so vocals, beats and sections survive a save. MIDI files only keep the notes.
 */

const FORMAT = 'keyfall-song'

/** Whether a song has anything a MIDI file can't hold. */
export const needsProject = (song: Song): boolean =>
  song.audioTracks.some((t) => t.clips.length) || song.tracks.some((t) => t.beat) || song.sections.length > 0 || song.key !== null

export async function packProject(song: Song): Promise<Uint8Array> {
  const ids = [...new Set(song.audioTracks.flatMap((t) => t.clips.flatMap((c) => c.takes)))]
  const missing = await ensureTakes(ids)
  const files: Zippable = { 'song.json': [strToU8(JSON.stringify({ format: FORMAT, version: 1, song })), { level: 6 }] }
  for (const id of ids) {
    if (missing.includes(id)) continue
    const wav = takeWav(id)
    // float audio barely compresses; storing it is much faster
    if (wav) files[`takes/${id}.wav`] = [wav, { level: 0 }]
  }
  return zipSync(files)
}

export function unpackProject(bytes: Uint8Array): Song {
  const files = unzipSync(bytes)
  const raw = files['song.json']
  if (!raw) throw new Error('This file has no song in it.')
  const data = JSON.parse(strFromU8(raw)) as { format?: string; song?: Song }
  if (data.format !== FORMAT || !data.song) throw new Error('This isn’t a Keyfall song file.')
  for (const [name, content] of Object.entries(files)) {
    const m = /^takes\/(.+)\.wav$/.exec(name)
    if (m) putTake(m[1], decodeWavMono(content))
  }
  const song = normalizeSong(data.song)
  reserveIds(song)
  return song
}

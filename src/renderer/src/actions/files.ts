import { engine } from '../audio/engine'
import { parseMidiFile, writeMidiFile } from '../model/midiio'
import { emptySong } from '../model/song'
import { getState } from '../state/store'

const SF_KEY = 'keyfall.soundfont'
const api = (): Window['keyfall'] => window.keyfall

const stripExt = (name: string): string => name.replace(/\.[^.]+$/, '')

function confirmDiscard(): boolean {
  const { dirty, fileName } = getState()
  return !dirty || window.confirm(`"${fileName}" has unsaved changes. Discard them?`)
}

export function newSong(): void {
  if (!confirmDiscard()) return
  engine.seek(0)
  getState().loadSong(emptySong(), 'Untitled', null)
}

export function loadMidiBytes(data: Uint8Array, name: string, path: string | null): void {
  if (!confirmDiscard()) return
  try {
    const song = parseMidiFile(data)
    if (!song.tracks.length) throw new Error('No notes found in this file.')
    engine.pause()
    engine.seek(0)
    getState().set({ playing: false, recording: false })
    getState().loadSong(song, stripExt(name), path)
    const notes = song.tracks.reduce((a, t) => a + t.notes.length, 0)
    getState().notify(`Opened ${name}: ${song.tracks.length} tracks, ${notes.toLocaleString()} notes`)
  } catch (err) {
    getState().notify(`Couldn't open ${name}. ${err instanceof Error ? err.message : ''}`, 'error')
  }
}

export async function openMidi(): Promise<void> {
  const f = await api().openFile('midi')
  if (f) loadMidiBytes(f.data, f.name, f.path)
}

export async function openMidiPath(path: string): Promise<void> {
  const f = await api().readFile(path)
  if (f) loadMidiBytes(f.data, f.name, f.path)
}

export async function saveSong(saveAs = false): Promise<void> {
  const st = getState()
  let path = st.filePath
  if (saveAs || !path) {
    path = await api().saveDialog('midi', `${st.fileName || 'Untitled'}.mid`)
    if (!path) return
  }
  try {
    const res = await api().writeFile(path, writeMidiFile(st.song, st.fileName))
    getState().markSaved(stripExt(res.name), res.path)
    getState().notify(`Saved ${res.name}`)
  } catch (err) {
    getState().notify(`Couldn't save. ${err instanceof Error ? err.message : ''}`, 'error')
  }
}

export async function loadSoundfontBytes(data: ArrayBuffer, name: string, path: string | null): Promise<void> {
  getState().set({ sfLoading: true })
  try {
    await engine.loadSoundfont(data)
    getState().set({ sfName: name, sfLoading: false })
    if (path) {
      try {
        localStorage.setItem(SF_KEY, path)
      } catch {
        // storage unavailable; the soundfont just won't auto-load next time
      }
    }
    getState().notify(`Loaded soundfont ${name}`)
  } catch (err) {
    getState().set({ sfLoading: false })
    getState().notify(`Couldn't load ${name} as a soundfont. ${err instanceof Error ? err.message : ''}`, 'error')
  }
}

const toArrayBuffer = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer

export async function openSoundfont(): Promise<void> {
  const f = await api().openFile('soundfont')
  if (f) await loadSoundfontBytes(toArrayBuffer(f.data), f.name, f.path)
}

export async function restoreSoundfont(): Promise<void> {
  let path: string | null = null
  try {
    path = localStorage.getItem(SF_KEY)
  } catch {
    return
  }
  if (!path) return
  getState().set({ sfLoading: true })
  const f = await api().readFile(path)
  if (f) await loadSoundfontBytes(toArrayBuffer(f.data), f.name, f.path)
  else getState().set({ sfLoading: false })
}

const SOUNDFONT_EXT = /\.(sf2|sf3|sfogg|dls)$/i
const MIDI_EXT = /\.(mid|midi)$/i

export async function handleDroppedFiles(files: FileList): Promise<void> {
  for (const file of Array.from(files)) {
    let path: string | null = null
    try {
      path = api().pathForFile(file) || null
    } catch {
      path = null
    }
    if (SOUNDFONT_EXT.test(file.name)) await loadSoundfontBytes(await file.arrayBuffer(), file.name, path)
    else if (MIDI_EXT.test(file.name)) loadMidiBytes(new Uint8Array(await file.arrayBuffer()), file.name, path)
    else getState().notify(`${file.name} isn't a MIDI file or soundfont.`, 'error')
  }
}

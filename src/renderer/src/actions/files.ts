import { engine } from '../audio/engine'
import { parseMidiFile, writeMidiFile } from '../model/midiio'
import { emptySong, type Song } from '../model/song'
import { savePref } from '../state/prefs'
import { getState, type RecentFile, type SoundfontEntry } from '../state/store'
import { clearAutosave } from './autosave'
import { needsProject, packProject, unpackProject } from './project'

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

const RECENT_MAX = 8

function setRecent(recent: RecentFile[]): void {
  getState().set({ recent })
  savePref('recent', recent)
}

function remember(path: string, name: string): void {
  setRecent([{ path, name }, ...getState().recent.filter((r) => r.path !== path)].slice(0, RECENT_MAX))
}

export function forgetRecent(path?: string): void {
  setRecent(path ? getState().recent.filter((r) => r.path !== path) : [])
}

export async function openRecent(path: string): Promise<void> {
  const f = await api().readFile(path)
  if (f) loadMidiBytes(f.data, f.name, f.path)
  else {
    getState().notify(`Couldn't find ${path}. It was removed from the recent list.`, 'error')
    forgetRecent(path)
  }
}

const PROJECT_EXT = /\.keyfall$/i

/** Opens a song from file bytes: a .keyfall song file, or a MIDI file. */
export function loadMidiBytes(data: Uint8Array, name: string, path: string | null): void {
  if (!confirmDiscard()) return
  try {
    const song: Song = PROJECT_EXT.test(name) ? unpackProject(data) : parseMidiFile(data)
    if (!song.tracks.length && !song.audioTracks.length) throw new Error('No notes found in this file.')
    engine.pause()
    engine.seek(0)
    getState().set({ playing: false, recording: false })
    getState().loadSong(song, stripExt(name), path)
    const notes = song.tracks.reduce((a, t) => a + t.notes.length, 0)
    const vocals = song.audioTracks.length
    if (path) remember(path, name)
    getState().notify(`Opened ${name}: ${song.tracks.length} tracks, ${notes.toLocaleString()} notes${vocals ? `, ${vocals} vocal track${vocals === 1 ? '' : 's'}` : ''}`)
  } catch (err) {
    getState().notify(`Couldn't open ${name}. ${err instanceof Error ? err.message : ''}`, 'error')
  }
}

export async function openMidi(): Promise<void> {
  const f = await api().openFile('song')
  if (f) loadMidiBytes(f.data, f.name, f.path)
}

export async function openMidiPath(path: string): Promise<void> {
  const f = await api().readFile(path)
  if (f) loadMidiBytes(f.data, f.name, f.path)
}

/**
 * Saves as a .keyfall song file when the song has vocals, a beat or sections (MIDI can't hold
 * them), otherwise as MIDI. Saving such a song over a .mid asks for a .keyfall name instead.
 */
export async function saveSong(saveAs = false): Promise<void> {
  const st = getState()
  const project = needsProject(st.song)
  let path = st.filePath
  if (saveAs || !path || (project && !PROJECT_EXT.test(path))) {
    path = await api().saveDialog(project ? 'keyfall' : 'song', `${st.fileName || 'Untitled'}.${project ? 'keyfall' : 'mid'}`)
    if (!path) return
  }
  try {
    const bytes = PROJECT_EXT.test(path) ? await packProject(st.song) : writeMidiFile(st.song, st.fileName)
    const res = await api().writeFile(path, bytes)
    getState().markSaved(stripExt(res.name), res.path)
    remember(res.path, res.name)
    void clearAutosave()
    getState().notify(`Saved ${res.name}`)
  } catch (err) {
    getState().notify(`Couldn't save. ${err instanceof Error ? err.message : ''}`, 'error')
  }
}

// ---------- soundfont library ----------

const sfDisplayName = (fileName: string): string => stripExt(fileName).replace(/[_]+/g, ' ').trim()

function setLibrary(sfLibrary: SoundfontEntry[]): void {
  getState().set({ sfLibrary })
  savePref('soundfonts', sfLibrary)
}

/** Adds soundfonts to the library by path (the files stay where they are). Returns the entries for those paths. */
function addToLibrary(files: { path: string; name: string }[]): SoundfontEntry[] {
  const lib = [...getState().sfLibrary]
  for (const f of files) if (!lib.some((e) => e.path === f.path)) lib.push({ path: f.path, name: sfDisplayName(f.name) })
  setLibrary(lib)
  return files.map((f) => lib.find((e) => e.path === f.path)!)
}

export function renameSoundfont(path: string, name: string): void {
  const clean = name.trim()
  if (!clean) return
  setLibrary(getState().sfLibrary.map((e) => (e.path === path ? { ...e, name: clean } : e)))
  if (getState().sfActive === path) getState().set({ sfName: clean })
}

/** Takes a soundfont off the list. If it is the one playing, it keeps playing until another is chosen. */
export function removeSoundfont(path: string): void {
  setLibrary(getState().sfLibrary.filter((e) => e.path !== path))
  if (getState().sfActive === path) getState().set({ sfActive: null })
}

/** Reads the loaded soundfont's preset list (it arrives from the audio thread shortly after loading). */
async function readPresets(before: unknown): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const list = engine.synth?.presetList ?? []
    if (list.length && (list !== before || i > 10)) {
      const presets = list
        .map((p) => ({ name: p.name.trim() || `Program ${p.program + 1}`, program: p.program, bank: p.bankMSB, drum: p.isGMGSDrum }))
        .sort((a, b) => Number(a.drum) - Number(b.drum) || a.bank - b.bank || a.program - b.program)
      getState().set({ sfPresets: presets })
      return
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

export async function loadSoundfontBytes(data: ArrayBuffer, name: string, path: string | null): Promise<void> {
  getState().set({ sfLoading: true })
  try {
    const before = engine.synth?.presetList
    await engine.loadSoundfont(data)
    void readPresets(before)
    const entry = path ? addToLibrary([{ path, name }])[0] : null
    getState().set({ sfName: entry?.name ?? name, sfActive: path, sfLoading: false })
    if (path) {
      try {
        localStorage.setItem(SF_KEY, path)
      } catch {
        // storage unavailable; the soundfont just won't auto-load next time
      }
    }
    getState().notify(`Loaded soundfont ${entry?.name ?? name}`)
  } catch (err) {
    getState().set({ sfLoading: false })
    getState().notify(`Couldn't load ${name} as a soundfont. ${err instanceof Error ? err.message : ''}`, 'error')
  }
}

const toArrayBuffer = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer

/** Loads a soundfont from the library. */
export async function switchSoundfont(path: string): Promise<void> {
  if (getState().sfActive === path || getState().sfLoading) return
  getState().set({ sfLoading: true })
  const f = await api().readFile(path)
  if (f) await loadSoundfontBytes(toArrayBuffer(f.data), f.name, f.path)
  else {
    getState().set({ sfLoading: false })
    getState().notify(`Couldn't find ${path}. If you moved it, remove it from the list and add it again.`, 'error')
  }
}

/** Picks one or more soundfonts to add to the library; loads the first one if nothing is loaded yet. */
export async function addSoundfonts(): Promise<void> {
  const picked = await api().pickFiles('soundfont')
  if (!picked.length) return
  const added = addToLibrary(picked)
  if (!getState().sfName) await switchSoundfont(added[0].path)
  else if (added.length > 1) getState().notify(`Added ${added.length} soundfonts. Pick one from the soundfont list.`)
  else await switchSoundfont(added[0].path)
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
const MIDI_EXT = /\.(mid|midi|keyfall)$/i

export async function handleDroppedFiles(files: FileList): Promise<void> {
  const fonts: { path: string; name: string }[] = []
  for (const file of Array.from(files)) {
    let path: string | null = null
    try {
      path = api().pathForFile(file) || null
    } catch {
      path = null
    }
    if (SOUNDFONT_EXT.test(file.name)) {
      if (path) fonts.push({ path, name: file.name })
      else await loadSoundfontBytes(await file.arrayBuffer(), file.name, null)
    } else if (MIDI_EXT.test(file.name)) loadMidiBytes(new Uint8Array(await file.arrayBuffer()), file.name, path)
    else getState().notify(`${file.name} isn't a MIDI file or soundfont.`, 'error')
  }
  // several soundfonts dropped at once go into the library; the first one is loaded
  if (fonts.length) {
    const added = addToLibrary(fonts)
    if (fonts.length > 1) getState().notify(`Added ${fonts.length} soundfonts to the list.`)
    await switchSoundfont(added[0].path)
  }
}

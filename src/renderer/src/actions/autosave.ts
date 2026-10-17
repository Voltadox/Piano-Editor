import { engine } from '../audio/engine'
import { newId, type Song } from '../model/song'
import { getState, type Recovery } from '../state/store'

const INTERVAL = 30_000
const api = (): Window['keyfall'] => window.keyfall

/** The song last written to the autosave file, so an unchanged song isn't rewritten. */
let written: Song | null = null

async function tick(): Promise<void> {
  const { song, dirty, fileName, filePath, recovery } = getState()
  if (dirty) {
    if (song === written) return
    written = song
    await api().autosaveWrite(JSON.stringify({ version: 1, fileName, filePath, savedAt: Date.now(), song }))
  } else if (written && !recovery) {
    // saved or discarded since the last autosave
    await clearAutosave()
  }
}

export async function clearAutosave(): Promise<void> {
  written = null
  await api().autosaveClear()
}

/** Offers back a song autosaved by a session that didn't close cleanly, then keeps autosaving. */
export async function startAutosave(): Promise<() => void> {
  try {
    const raw = await api().autosaveRead()
    if (raw) {
      const data = JSON.parse(raw) as Recovery
      if (data?.song?.tracks?.length) getState().set({ recovery: data })
    }
  } catch {
    // an unreadable autosave is just ignored
  }
  const id = window.setInterval(() => void tick().catch(() => undefined), INTERVAL)
  return () => window.clearInterval(id)
}

/** Note ids from the old session could collide with this one's, so everything gets fresh ids. */
function withFreshIds(song: Song): Song {
  return {
    ...song,
    tracks: song.tracks.map((t) => ({ ...t, id: newId(), notes: t.notes.map((n) => ({ ...n, id: newId() })) }))
  }
}

export function restoreRecovery(): void {
  const { recovery, dirty, fileName } = getState()
  if (!recovery) return
  if (dirty && !window.confirm(`"${fileName}" has unsaved changes. Replace it with the recovered song?`)) return
  engine.pause()
  engine.seek(0)
  getState().set({ playing: false, recording: false, recovery: null })
  getState().loadSong(withFreshIds(recovery.song), recovery.fileName, recovery.filePath)
  getState().set({ dirty: true })
  getState().notify(`Recovered ${recovery.fileName}. Save it to keep it.`)
}

export function discardRecovery(): void {
  getState().set({ recovery: null })
  if (!getState().dirty) void clearAutosave()
}

import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface LoadedFile {
  path: string
  name: string
  data: Uint8Array
}
export type FilterKind = 'midi' | 'song' | 'keyfall' | 'soundfont' | 'wav' | 'mp3' | 'mp4' | 'webm' | 'image' | 'audio'

const api = {
  openFile: (kind: FilterKind): Promise<LoadedFile | null> => ipcRenderer.invoke('open-file', kind),
  pickFiles: (kind: FilterKind): Promise<{ path: string; name: string }[]> => ipcRenderer.invoke('pick-files', kind),
  readFile: (path: string): Promise<LoadedFile | null> => ipcRenderer.invoke('read-file', path),
  saveDialog: (kind: FilterKind, defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('save-dialog', kind, defaultName),
  writeFile: (path: string, data: Uint8Array): Promise<{ path: string; name: string }> =>
    ipcRenderer.invoke('write-file', path, data),
  setDirty: (dirty: boolean): void => ipcRenderer.send('set-dirty', dirty),
  autosaveWrite: (json: string): Promise<void> => ipcRenderer.invoke('autosave-write', json),
  autosaveRead: (): Promise<string | null> => ipcRenderer.invoke('autosave-read'),
  autosaveClear: (): Promise<void> => ipcRenderer.invoke('autosave-clear'),
  takeWrite: (id: string, data: Uint8Array): Promise<void> => ipcRenderer.invoke('take-write', id, data),
  backupSoundfont: (): Promise<Uint8Array | null> => ipcRenderer.invoke('backup-soundfont'),
  separateVocals: (left: Float32Array, right: Float32Array): Promise<{ left: Float32Array; right: Float32Array }> =>
    ipcRenderer.invoke('separate-vocals', left, right),
  transcribeNotes: (pcm: Float32Array): Promise<{ start: number; end: number; pitch: number; amp: number }[]> => ipcRenderer.invoke('transcribe-notes', pcm),
  transcribeLyrics: (pcm16k: Float32Array): Promise<{ start: number; end: number; text: string }[]> => ipcRenderer.invoke('transcribe-lyrics', pcm16k),
  onSeparateProgress: (fn: (p: number) => void): (() => void) => {
    const h = (_e: unknown, p: number): void => fn(p)
    ipcRenderer.on('separate-progress', h)
    return () => ipcRenderer.removeListener('separate-progress', h)
  },
  onModelProgress: (fn: (p: { name: string; received: number; total: number }) => void): (() => void) => {
    const h = (_e: unknown, p: { name: string; received: number; total: number }): void => fn(p)
    ipcRenderer.on('model-progress', h)
    return () => ipcRenderer.removeListener('model-progress', h)
  },
  takeRead: (id: string): Promise<Uint8Array | null> => ipcRenderer.invoke('take-read', id),
  startupFile: (): Promise<string | null> => ipcRenderer.invoke('startup-file'),
  selftest: (): Promise<string | null> => ipcRenderer.invoke('selftest'),
  selftestDone: (): void => ipcRenderer.send('selftest-done'),
  selftestCapture: (path: string): Promise<void> => ipcRenderer.invoke('selftest-capture', path),
  pathForFile: (file: File): string => webUtils.getPathForFile(file)
}

export type KeyfallApi = typeof api

contextBridge.exposeInMainWorld('keyfall', api)

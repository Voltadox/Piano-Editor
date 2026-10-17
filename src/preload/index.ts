import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface LoadedFile {
  path: string
  name: string
  data: Uint8Array
}
export type FilterKind = 'midi' | 'soundfont' | 'wav' | 'mp3' | 'mp4' | 'webm'

const api = {
  openFile: (kind: FilterKind): Promise<LoadedFile | null> => ipcRenderer.invoke('open-file', kind),
  readFile: (path: string): Promise<LoadedFile | null> => ipcRenderer.invoke('read-file', path),
  saveDialog: (kind: FilterKind, defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('save-dialog', kind, defaultName),
  writeFile: (path: string, data: Uint8Array): Promise<{ path: string; name: string }> =>
    ipcRenderer.invoke('write-file', path, data),
  setDirty: (dirty: boolean): void => ipcRenderer.send('set-dirty', dirty),
  startupFile: (): Promise<string | null> => ipcRenderer.invoke('startup-file'),
  selftest: (): Promise<string | null> => ipcRenderer.invoke('selftest'),
  selftestDone: (): void => ipcRenderer.send('selftest-done'),
  pathForFile: (file: File): string => webUtils.getPathForFile(file)
}

export type KeyfallApi = typeof api

contextBridge.exposeInMainWorld('keyfall', api)

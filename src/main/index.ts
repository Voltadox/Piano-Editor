import { app, BrowserWindow, dialog, ipcMain, session, type FileFilter } from 'electron'
import { join, basename } from 'path'
import { rmSync } from 'fs'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'

const FILTERS: Record<string, FileFilter[]> = {
  midi: [{ name: 'MIDI files', extensions: ['mid', 'midi'] }],
  song: [
    { name: 'Keyfall songs and MIDI files', extensions: ['keyfall', 'mid', 'midi'] },
    { name: 'Keyfall song (keeps vocals, beats and sections)', extensions: ['keyfall'] },
    { name: 'MIDI file (notes only)', extensions: ['mid', 'midi'] }
  ],
  keyfall: [{ name: 'Keyfall song', extensions: ['keyfall'] }],
  soundfont: [{ name: 'Soundfonts', extensions: ['sf2', 'sf3', 'sfogg', 'dls'] }],
  wav: [{ name: 'WAV audio', extensions: ['wav'] }],
  mp3: [{ name: 'MP3 audio', extensions: ['mp3'] }],
  mp4: [{ name: 'MP4 video', extensions: ['mp4'] }],
  webm: [{ name: 'WebM video', extensions: ['webm'] }],
  image: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }]
}
type FilterKind = 'midi' | 'song' | 'keyfall' | 'soundfont' | 'wav' | 'mp3' | 'mp4' | 'webm' | 'image'

/** Crash-recovery copy of the open song, written by the renderer while there are unsaved changes. */
const autosavePath = (): string => join(app.getPath('userData'), 'autosave.json')
/** Recorded takes, kept as WAV files so autosave and recovery can find them. */
const takePath = (id: string): string => join(app.getPath('userData'), 'takes', `${id.replace(/[^\w-]/g, '')}.wav`)

// Debug helper: `--screenshot=out.png` saves a capture of the window a few seconds after load, then quits.
const shotArg = process.argv.find((a) => a.startsWith('--screenshot='))
const shotPath = shotArg?.slice('--screenshot='.length)
// Debug helper: `--selftest=<soundfont>|<outDir>` runs playback + export checks in the renderer and logs results.
const selftestArg = process.argv.find((a) => a.startsWith('--selftest='))?.slice('--selftest='.length) ?? null
const startupFile = process.argv.slice(1).find((a) => /\.(mid|midi)$/i.test(a)) ?? null
// debug runs get their own settings and autosave, so they never touch the user's
if (shotPath || selftestArg) app.setPath('userData', join(app.getPath('temp'), 'keyfall-selftest'))

let win: BrowserWindow | null = null
let dirty = false

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0a0c14',
    title: 'Keyfall',
    autoHideMenuBar: true,
    show: !shotPath && !selftestArg,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      autoplayPolicy: 'no-user-gesture-required',
      // debug runs use a hidden window, which must keep painting for its screenshot
      backgroundThrottling: !shotPath && !selftestArg
    }
  })
  win.setMenuBarVisibility(false)

  // MIDI keyboards, and the microphone for vocal recording
  const allow = (perm: string): boolean => perm === 'midi' || perm === 'midiSysex' || perm === 'media'
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(allow(perm)))
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => allow(perm))

  win.on('close', (e) => {
    if (!dirty || shotPath) return
    const choice = dialog.showMessageBoxSync(win!, {
      type: 'warning',
      buttons: ['Discard changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'This song has unsaved changes.',
      detail: 'Close Keyfall and lose them?'
    })
    if (choice === 1) e.preventDefault()
    else rmSync(autosavePath(), { force: true })
  })

  if (shotPath || selftestArg) {
    win.webContents.on('console-message', (event) => {
      console.log(`[renderer:${event.level}] ${event.message}`)
    })
  }
  if (shotPath && !selftestArg) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const img = await win!.webContents.capturePage()
        await writeFile(shotPath, img.toPNG())
        app.exit(0)
      }, 3500)
    })
  }

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

ipcMain.handle('open-file', async (_e, kind: FilterKind) => {
  const res = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: FILTERS[kind] })
  if (res.canceled || !res.filePaths[0]) return null
  const path = res.filePaths[0]
  return { path, name: basename(path), data: new Uint8Array(await readFile(path)) }
})

ipcMain.handle('pick-files', async (_e, kind: FilterKind) => {
  const res = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'], filters: FILTERS[kind] })
  return res.canceled ? [] : res.filePaths.map((path) => ({ path, name: basename(path) }))
})

ipcMain.handle('read-file', async (_e, path: string) => {
  try {
    return { path, name: basename(path), data: new Uint8Array(await readFile(path)) }
  } catch {
    return null
  }
})

ipcMain.handle('save-dialog', async (_e, kind: FilterKind, defaultName: string) => {
  const res = await dialog.showSaveDialog(win!, { defaultPath: defaultName, filters: FILTERS[kind] })
  return res.canceled || !res.filePath ? null : res.filePath
})

ipcMain.handle('write-file', async (_e, path: string, data: Uint8Array) => {
  await writeFile(path, data)
  return { path, name: basename(path) }
})

ipcMain.handle('autosave-write', async (_e, json: string) => {
  const path = autosavePath()
  await writeFile(`${path}.tmp`, json, 'utf8')
  await rename(`${path}.tmp`, path)
})
ipcMain.handle('autosave-read', async () => {
  try {
    return await readFile(autosavePath(), 'utf8')
  } catch {
    return null
  }
})
ipcMain.handle('take-write', async (_e, id: string, data: Uint8Array) => {
  await mkdir(join(app.getPath('userData'), 'takes'), { recursive: true })
  await writeFile(takePath(id), data)
})
ipcMain.handle('take-read', async (_e, id: string) => {
  try {
    return new Uint8Array(await readFile(takePath(id)))
  } catch {
    return null
  }
})
ipcMain.handle('autosave-clear', () => rm(autosavePath(), { force: true }))

ipcMain.on('set-dirty', (_e, value: boolean) => {
  dirty = value
})

ipcMain.handle('startup-file', () => startupFile)
ipcMain.handle('selftest', () => selftestArg)
ipcMain.handle('selftest-capture', async (_e, path: string) => {
  if (selftestArg && win) await writeFile(path, (await win.webContents.capturePage()).toPNG())
})
ipcMain.on('selftest-done', async () => {
  if (shotPath && win) await writeFile(shotPath, (await win.webContents.capturePage()).toPNG())
  app.exit(0)
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())

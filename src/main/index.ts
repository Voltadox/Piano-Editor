import { app, BrowserWindow, dialog, ipcMain, session, type FileFilter } from 'electron'
import { join, basename } from 'path'
import { readFile, writeFile } from 'fs/promises'

const FILTERS: Record<string, FileFilter[]> = {
  midi: [{ name: 'MIDI files', extensions: ['mid', 'midi'] }],
  soundfont: [{ name: 'Soundfonts', extensions: ['sf2', 'sf3', 'sfogg', 'dls'] }],
  wav: [{ name: 'WAV audio', extensions: ['wav'] }],
  mp3: [{ name: 'MP3 audio', extensions: ['mp3'] }],
  mp4: [{ name: 'MP4 video', extensions: ['mp4'] }],
  webm: [{ name: 'WebM video', extensions: ['webm'] }]
}
type FilterKind = 'midi' | 'soundfont' | 'wav' | 'mp3' | 'mp4' | 'webm'

// Debug helper: `--screenshot=out.png` saves a capture of the window a few seconds after load, then quits.
const shotArg = process.argv.find((a) => a.startsWith('--screenshot='))
const shotPath = shotArg?.slice('--screenshot='.length)
// Debug helper: `--selftest=<soundfont>|<outDir>` runs playback + export checks in the renderer and logs results.
const selftestArg = process.argv.find((a) => a.startsWith('--selftest='))?.slice('--selftest='.length) ?? null
const startupFile = process.argv.slice(1).find((a) => /\.(mid|midi)$/i.test(a)) ?? null

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
      autoplayPolicy: 'no-user-gesture-required'
    }
  })
  win.setMenuBarVisibility(false)

  const allow = (perm: string): boolean => perm === 'midi' || perm === 'midiSysex'
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

ipcMain.on('set-dirty', (_e, value: boolean) => {
  dirty = value
})

ipcMain.handle('startup-file', () => startupFile)
ipcMain.handle('selftest', () => selftestArg)
ipcMain.on('selftest-done', async () => {
  if (shotPath && win) await writeFile(shotPath, (await win.webContents.capturePage()).toPNG())
  app.exit(0)
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())

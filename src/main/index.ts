import { app, BrowserWindow, dialog, ipcMain, session, utilityProcess, type FileFilter, type UtilityProcess, type WebContents } from 'electron'
import { createWriteStream } from 'fs'
import { stat } from 'fs/promises'
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
  image: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
  audio: [{ name: 'Songs', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'] }]
}
type FilterKind = 'midi' | 'song' | 'keyfall' | 'soundfont' | 'wav' | 'mp3' | 'mp4' | 'webm' | 'image' | 'audio'

/** Crash-recovery copy of the open song, written by the renderer while there are unsaved changes. */
const autosavePath = (): string => join(app.getPath('userData'), 'autosave.json')
/** GeneralUser GS, shipped with Keyfall to fill in instruments a soundfont lacks (drums especially). */
const backupFontPath = (): string =>
  app.isPackaged ? join(process.resourcesPath, 'soundfonts', 'GeneralUser-GS.sf2') : join(app.getAppPath(), 'resources', 'soundfonts', 'GeneralUser-GS.sf2')
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
// ---------- downloadable models ----------

/** Models fetched on first use and kept in the user's data folder. */
const MODELS: Record<string, { url: string; bytes: number; file: string }> = {
  separator: {
    url: 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx',
    bytes: 66759214,
    file: 'Kim_Vocal_2.onnx'
  }
}

const modelPath = (name: string): string => join(app.getPath('userData'), 'models', MODELS[name].file)

/** Downloads a model if it isn't on disk yet, reporting progress to the page. */
async function ensureModel(name: string, sender: WebContents): Promise<string> {
  const m = MODELS[name]
  const path = modelPath(name)
  try {
    if ((await stat(path)).size === m.bytes) return path
  } catch {
    // not downloaded yet
  }
  await mkdir(join(app.getPath('userData'), 'models'), { recursive: true })
  const res = await fetch(m.url)
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
  const tmp = `${path}.part`
  const out = createWriteStream(tmp)
  let got = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    got += value.length
    if (!out.write(value)) await new Promise((r) => out.once('drain', r))
    sender.send('model-progress', { name, received: got, total: m.bytes })
  }
  await new Promise<void>((r, j) => out.end((err?: Error | null) => (err ? j(err) : r())))
  if (got !== m.bytes) throw new Error('The download was incomplete. Check your connection and try again.')
  await rename(tmp, path)
  return path
}

// ---------- vocal separation ----------

let separator: UtilityProcess | null = null
let nextJob = 1
const jobs = new Map<number, { sender: WebContents; resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function getSeparator(): UtilityProcess {
  if (separator) return separator
  separator = utilityProcess.fork(join(__dirname, 'separator.js'), [], { serviceName: 'Keyfall vocal separator' })
  separator.on('message', (m: { id: number; type: string; value?: number; message?: string; left?: Float32Array; right?: Float32Array }) => {
    const job = jobs.get(m.id)
    if (!job) return
    if (m.type === 'progress') job.sender.send('separate-progress', m.value)
    else {
      jobs.delete(m.id)
      if (m.type === 'done') job.resolve({ left: m.left, right: m.right })
      else job.reject(new Error(m.message))
    }
  })
  separator.on('exit', () => {
    separator = null
    for (const [id, job] of jobs) {
      jobs.delete(id)
      job.reject(new Error('The vocal separator stopped unexpectedly.'))
    }
  })
  return separator
}

ipcMain.handle('separate-vocals', async (e, left: Float32Array, right: Float32Array) => {
  const path = await ensureModel('separator', e.sender)
  const id = nextJob++
  return new Promise((resolve, reject) => {
    jobs.set(id, { sender: e.sender, resolve, reject })
    getSeparator().postMessage({ id, left, right, modelPath: path })
  })
})

ipcMain.handle('backup-soundfont', async () => {
  try {
    return new Uint8Array(await readFile(backupFontPath()))
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

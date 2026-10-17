import { savePref } from '../state/prefs'
import { getState } from '../state/store'
import type { Theme } from '../view/theme'

export function setTheme(patch: Partial<Theme>): void {
  const theme = { ...getState().theme, ...patch }
  getState().set({ theme })
  savePref('theme', theme)
}

async function decode(data: Uint8Array): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([data as Uint8Array<ArrayBuffer>]))
}

export async function pickBackgroundImage(): Promise<void> {
  const f = await window.keyfall.openFile('image')
  if (!f) return
  try {
    const img = await decode(f.data)
    getState().bgImage?.close()
    getState().set({ bgImage: img })
    setTheme({ background: 'image', imagePath: f.path })
  } catch {
    getState().notify(`Couldn't read ${f.name} as an image.`, 'error')
  }
}

const PRESET = 'preset:'

function loadPreset(file: string): Promise<ImageBitmap> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => void createImageBitmap(img).then(resolve, reject)
    img.onerror = () => reject(new Error(`missing ${file}`))
    img.src = `backgrounds/${file}`
  })
}

/** Uses one of the bundled background photos, faded so the notes stay readable. */
export async function usePresetBackground(file: string): Promise<void> {
  try {
    const img = await loadPreset(file)
    getState().bgImage?.close()
    getState().set({ bgImage: img })
    setTheme({ background: 'image', imagePath: PRESET + file, imageDim: Math.max(0.45, getState().theme.imageDim) })
  } catch {
    getState().notify('That background couldn’t be loaded.', 'error')
  }
}

export function clearBackground(): void {
  setTheme({ background: 'solid' })
}

/** Reloads the background image chosen last session; falls back to a solid colour if it has moved. */
export async function restoreBackground(): Promise<void> {
  const { imagePath, background } = getState().theme
  if (!imagePath) return
  if (imagePath.startsWith(PRESET)) {
    try {
      getState().set({ bgImage: await loadPreset(imagePath.slice(PRESET.length)) })
    } catch {
      if (background === 'image') setTheme({ background: 'solid' })
    }
    return
  }
  const f = await window.keyfall.readFile(imagePath)
  if (f) {
    try {
      getState().set({ bgImage: await decode(f.data) })
      return
    } catch {
      // fall through
    }
  }
  if (background === 'image') setTheme({ background: 'solid' })
  getState().notify(`The background image ${imagePath} couldn't be loaded.`, 'error')
}

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

/** Reloads the background image chosen last session; falls back to a solid colour if it has moved. */
export async function restoreBackground(): Promise<void> {
  const { imagePath, background } = getState().theme
  if (!imagePath) return
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

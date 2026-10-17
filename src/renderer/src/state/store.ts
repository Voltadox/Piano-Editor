import { create } from 'zustand'
import { demoSong, type Snap, type Song } from '../model/song'

export type Tool = 'select' | 'draw'

const HISTORY_LIMIT = 300

export interface EditorState {
  song: Song
  fileName: string
  filePath: string | null
  dirty: boolean
  past: Song[]
  future: Song[]
  /** Song as it was when the current drag started; the drag becomes one undo step. */
  gestureBase: Song | null

  selection: Set<number>
  activeTrackId: number
  tool: Tool
  snap: Snap
  pxPerSec: number
  drawerOpen: boolean
  playing: boolean
  recording: boolean
  volume: number
  sfName: string | null
  sfLoading: boolean
  midiInputs: string[]
  toast: { id: number; text: string; tone: 'info' | 'error' } | null
  busy: { label: string; progress: number; cancel?: () => void } | null

  /** Apply an edit. Outside a gesture, each call is one undo step. */
  apply: (fn: (song: Song) => Song) => void
  beginGesture: () => void
  endGesture: () => void
  undo: () => void
  redo: () => void
  loadSong: (song: Song, fileName: string, filePath: string | null) => void
  markSaved: (fileName: string, filePath: string) => void
  setSelection: (sel: Set<number>) => void
  set: (patch: Partial<EditorState>) => void
  notify: (text: string, tone?: 'info' | 'error') => void
}

let toastId = 0
const initial = demoSong()

export const useStore = create<EditorState>()((set, get) => ({
  song: initial,
  fileName: 'Demo',
  filePath: null,
  dirty: false,
  past: [],
  future: [],
  gestureBase: null,

  selection: new Set(),
  activeTrackId: initial.tracks[1].id,
  tool: 'select',
  snap: '1/16',
  pxPerSec: 200,
  drawerOpen: false,
  playing: false,
  recording: false,
  volume: 0.8,
  sfName: null,
  sfLoading: false,
  midiInputs: [],
  toast: null,
  busy: null,

  apply: (fn) => {
    const s = get()
    const next = fn(s.song)
    if (next === s.song) return
    if (s.gestureBase) set({ song: next, dirty: true })
    else set({ song: next, past: [...s.past.slice(-HISTORY_LIMIT), s.song], future: [], dirty: true })
  },
  beginGesture: () => set({ gestureBase: get().song }),
  endGesture: () => {
    const { gestureBase, song, past } = get()
    if (gestureBase && gestureBase !== song)
      set({ past: [...past.slice(-HISTORY_LIMIT), gestureBase], future: [], gestureBase: null })
    else set({ gestureBase: null })
  },
  undo: () => {
    const { past, song, future } = get()
    if (!past.length) return
    set({ song: past[past.length - 1], past: past.slice(0, -1), future: [song, ...future], dirty: true })
    fixActiveTrack()
  },
  redo: () => {
    const { past, song, future } = get()
    if (!future.length) return
    set({ song: future[0], future: future.slice(1), past: [...past, song], dirty: true })
    fixActiveTrack()
  },
  loadSong: (song, fileName, filePath) => {
    set({
      song,
      fileName,
      filePath,
      dirty: false,
      past: [],
      future: [],
      gestureBase: null,
      selection: new Set(),
      activeTrackId: song.tracks[0]?.id ?? -1
    })
  },
  markSaved: (fileName, filePath) => set({ fileName, filePath, dirty: false }),
  setSelection: (selection) => set({ selection }),
  set: (patch) => set(patch),
  notify: (text, tone = 'info') => set({ toast: { id: ++toastId, text, tone } })
}))

function fixActiveTrack(): void {
  const { song, activeTrackId } = useStore.getState()
  if (!song.tracks.some((t) => t.id === activeTrackId))
    useStore.setState({ activeTrackId: song.tracks[0]?.id ?? -1 })
}

export const getState = useStore.getState

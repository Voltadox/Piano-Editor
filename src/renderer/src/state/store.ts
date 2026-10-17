import { create } from 'zustand'
import { demoSong, type Snap, type Song } from '../model/song'
import { DEFAULT_THEME, type Theme } from '../view/theme'
import { loadPref } from './prefs'

export type Tool = 'select' | 'draw'

export interface SoundfontEntry {
  path: string
  /** display name, editable */
  name: string
}

export interface RecentFile {
  path: string
  name: string
}

/** An autosave found at startup, waiting for the user to restore or discard it. */
export interface Recovery {
  fileName: string
  filePath: string | null
  savedAt: number
  song: Song
}

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
  sfLibrary: SoundfontEntry[]
  /** path of the soundfont currently loaded, if it is in the library */
  sfActive: string | null
  sfLoading: boolean
  midiInputs: string[]
  toast: { id: number; text: string; tone: 'info' | 'error' } | null
  busy: { label: string; progress: number; cancel?: () => void } | null

  metronome: boolean
  /** 0 plays velocities as played .. 1 plays every note at `velLevel` */
  velEven: number
  velLevel: number
  /** live view: what you play rises from the keys, with chord suggestions */
  studio: boolean
  /** pitches of the Studio suggestion to mark on the keyboard */
  studioHint: number[] | null
  /** bars of count-in before recording */
  countIn: number
  /** loop region in ticks */
  loop: { start: number; end: number } | null
  loopOn: boolean
  laneOpen: boolean
  theme: Theme
  bgImage: ImageBitmap | null
  videoOpen: boolean
  recovery: Recovery | null
  recent: RecentFile[]

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
  sfLibrary: loadPref<SoundfontEntry[]>('soundfonts', []),
  sfActive: null,
  sfLoading: false,
  midiInputs: [],
  toast: null,
  busy: null,

  metronome: loadPref('metronome', false),
  velEven: loadPref('velEven', 0),
  velLevel: loadPref('velLevel', 90),
  studio: loadPref('studio', false),
  studioHint: null,
  countIn: loadPref('countIn', 1),
  loop: null,
  loopOn: false,
  laneOpen: loadPref('laneOpen', false),
  theme: loadPref('theme', DEFAULT_THEME),
  bgImage: null,
  videoOpen: false,
  recovery: null,
  recent: loadPref<RecentFile[]>('recent', []),

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
      activeTrackId: song.tracks[0]?.id ?? -1,
      loop: null,
      loopOn: false
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

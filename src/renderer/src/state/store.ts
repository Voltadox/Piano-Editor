import { create } from 'zustand'
import { demoSong, type Snap, type Song } from '../model/song'
import type { GuideVoice } from '../model/audio'
import { DEFAULT_THEME, type Theme } from '../view/theme'
import { loadPref } from './prefs'

export type Tool = 'select' | 'draw'

export interface SoundfontEntry {
  path: string
  /** display name, editable */
  name: string
}

export type DrawerTab = 'reference' | 'tracks' | 'mixer' | 'vocals' | 'beat' | 'sections'

/** A vocal recording in progress, for the UI. */
export interface VocalRecording {
  kind: 'take' | 'harmony'
  trackIds: number[]
  voices?: GuideVoice[]
  /** which pass (harmony voice) is being recorded */
  pass: number
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
  drawerTab: DrawerTab
  /** the audio track the Vocals tab is showing */
  activeAudioId: number
  micId: string
  /** extra recording latency correction, milliseconds */
  latencyMs: number
  guideVolume: number
  vocalRec: VocalRecording | null
  /** the drum pattern the Beat tab is editing */
  beatPattern: number
  playing: boolean
  recording: boolean
  volume: number
  sfName: string | null
  sfLibrary: SoundfontEntry[]
  /** fill instruments the soundfont lacks from the bundled GeneralUser GS */
  backupFont: boolean
  backupLoaded: boolean
  /** presets in the loaded soundfont */
  sfPresets: { name: string; program: number; bank: number; drum: boolean }[]
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
  /** Studio mode names chords and suggests ones that fit */
  studioChords: boolean
  /** pitches of the Studio suggestion to mark on the keyboard */
  studioHint: number[] | null
  /** bars of count-in before recording */
  countIn: number
  /** file each take into Left hand / Right hand tracks */
  splitHands: boolean
  /** loop region in ticks */
  loop: { start: number; end: number } | null
  loopOn: boolean
  laneOpen: boolean
  theme: Theme
  bgImage: ImageBitmap | null
  videoOpen: boolean
  /** bumps when autotuned vocals finish processing, so views redraw */
  vocalVersion: number
  /** right-click menu for the selection, at a window position */
  contextMenu: { x: number; y: number } | null
  /** the menu for changing a chord in the chord lane */
  chordMenu: { x: number; y: number; index: number } | null
  /** playback speed for practice (0.5..1); notes and audio slow down without changing pitch */
  rate: number
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
  drawerTab: 'tracks',
  activeAudioId: -1,
  micId: loadPref('micId', ''),
  latencyMs: loadPref('latencyMs', 0),
  guideVolume: loadPref('guideVolume', 0.3),
  vocalRec: null,
  beatPattern: -1,
  playing: false,
  recording: false,
  volume: 0.8,
  sfName: null,
  sfLibrary: loadPref<SoundfontEntry[]>('soundfonts', []),
  sfActive: null,
  sfPresets: [],
  backupFont: loadPref('backupFont', true),
  backupLoaded: false,
  sfLoading: false,
  midiInputs: [],
  toast: null,
  busy: null,

  metronome: loadPref('metronome', false),
  velEven: loadPref('velEven', 0),
  velLevel: loadPref('velLevel', 90),
  studio: loadPref('studio', false),
  studioChords: loadPref('studioChords', true),
  studioHint: null,
  countIn: loadPref('countIn', 1),
  splitHands: loadPref('splitHands', true),
  loop: null,
  loopOn: false,
  laneOpen: loadPref('laneOpen', false),
  theme: loadPref('theme', DEFAULT_THEME),
  bgImage: null,
  videoOpen: false,
  vocalVersion: 0,
  contextMenu: null,
  chordMenu: null,
  rate: 1,
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

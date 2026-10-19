import { useEffect, useState } from 'react'
import { engine } from './audio/engine'
import { initMidiInput } from './audio/midiInput'
import { startAutosave } from './actions/autosave'
import { watchTakes } from './audio/vocals'
import { applyBackupFont, handleDroppedFiles, newSong, openMidi, openMidiPath, restoreSoundfont, saveSong } from './actions/files'
import { restoreBackground } from './actions/look'
import { goToStart, seekBy, stop, syncTransport, toggleLoop, toggleMetronome, toggleRecord, togglePlay, toggleStudio } from './actions/transport'
import { snapTicks, tempoMap, ticksPerBeat } from './model/song'
import {
  copySelection,
  cutSelection,
  deleteNotes,
  invertSelection,
  nudge,
  paste,
  quantize,
  selectAll,
  selectRange,
  selectSamePitch,
  selectTrack,
  transpose,
  updateTrack
} from './state/edit'
import { savePref } from './state/prefs'
import { getState, useStore } from './state/store'
import { FallView } from './view/FallView'
import { VelocityLane } from './view/VelocityLane'
import { Overview } from './ui/Overview'
import { Banners, Busy, StatusBar, Toast } from './ui/Overlays'
import { Drawer } from './ui/Drawer'
import { Transport } from './ui/Transport'
import { ChordMenu } from './ui/ChordMenu'
import { ContextMenu, VocalNoteMenu } from './ui/ContextMenu'
import { StudioPanel } from './ui/StudioPanel'
import { VideoDialog } from './ui/VideoDialog'
import { HelpDialog } from './ui/HelpDialog'

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  if (tag === 'TEXTAREA' || el.isContentEditable) return true
  if (tag === 'INPUT') return !['range', 'color', 'checkbox'].includes((el as HTMLInputElement).type)
  return tag === 'SELECT'
}

function onKey(e: KeyboardEvent): void {
  if (isTyping(e) || getState().busy) return
  const st = getState()
  const ctrl = e.ctrlKey || e.metaKey
  const k = e.key.toLowerCase()
  const sel = st.selection
  const playheadTick = (): number => {
    const { song, snap } = getState()
    const tick = tempoMap(song).secToTick(engine.time())
    const g = snapTicks(song.ppq, snap)
    return Math.round(tick / g) * g
  }
  const handled = (): void => e.preventDefault()

  // the video dialog only lets playback through, so its preview can be played
  if (st.videoOpen) {
    if (e.key === 'Escape') st.set({ videoOpen: false })
    else if (e.key === ' ') (handled(), void togglePlay())
    return
  }

  if (ctrl) {
    if (k === 'z' && !e.shiftKey) (st.undo(), handled())
    else if (k === 'y' || (k === 'z' && e.shiftKey)) (st.redo(), handled())
    else if (k === 's') (void saveSong(e.shiftKey), handled())
    else if (k === 'o') (void openMidi(), handled())
    else if (k === 'n') (newSong(), handled())
    else if (k === 'e') (st.set({ videoOpen: true }), handled())
    else if (k === 'a' && e.shiftKey) (selectTrack(), handled())
    else if (k === 'p' && e.shiftKey) (selectSamePitch(), handled())
    else if (k === 'i') (invertSelection(), handled())
    else if (k === 'l') (st.loop && selectRange(st.loop.start, st.loop.end), handled())
    else if (k === 'a') (selectAll(), handled())
    else if (k === 'c') (copySelection(), handled())
    else if (k === 'x') (cutSelection(), handled())
    else if (k === 'v') (paste(playheadTick()), handled())
    return
  }

  switch (e.key) {
    case ' ':
      handled()
      void togglePlay()
      return
    case 'Home':
      goToStart()
      return
    case 'End':
      engine.seek(engine.duration)
      return
    case 'Delete':
    case 'Backspace':
      deleteNotes(new Set(sel))
      return
    case 'Escape':
      if (st.pitchEdit) {
        st.set({ pitchEdit: false, vocalNoteMenu: null })
        return
      }
      if (st.playing) stop()
      st.setSelection(new Set())
      return
    case 'ArrowUp':
    case 'ArrowDown':
      if (!sel.size) return
      handled()
      transpose(sel, (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1))
      return
    case 'ArrowLeft':
    case 'ArrowRight': {
      handled()
      const dir = e.key === 'ArrowRight' ? 1 : -1
      if (sel.size) {
        const g = st.snap === 'off' ? st.song.ppq / 4 : snapTicks(st.song.ppq, st.snap)
        nudge(sel, dir * g)
      } else {
        const beat = tempoMap(st.song).tickToSec(ticksPerBeat(st.song))
        seekBy(dir * beat * (e.shiftKey ? 4 : 1))
      }
      return
    }
    case '+':
    case '=':
      st.set({ pxPerSec: Math.min(1200, st.pxPerSec * 1.2) })
      return
    case '-':
      st.set({ pxPerSec: Math.max(30, st.pxPerSec / 1.2) })
      return
  }
  if (k === 'q') quantize(e.shiftKey)
  else if (k === 'v' && e.shiftKey) {
    st.set({ laneOpen: !st.laneOpen })
    savePref('laneOpen', !st.laneOpen)
  } else if (k === 'v') st.set({ tool: 'select' })
  else if (k === 'k') toggleMetronome()
  else if (k === 'l') toggleLoop()
  else if (k === 's') toggleStudio()
  else if (k === 'd') st.set({ tool: 'draw' })
  else if (k === 'r') void toggleRecord()
  else if (k === 't') st.set({ drawerOpen: !st.drawerOpen })
  else if (k === 'm') {
    const t = st.song.tracks.find((x) => x.id === st.activeTrackId)
    if (t) updateTrack(t.id, { muted: !t.muted })
  }
}

export default function App(): React.JSX.Element {
  const [dropping, setDropping] = useState(false)
  const fileName = useStore((s) => s.fileName)
  const dirty = useStore((s) => s.dirty)
  const laneOpen = useStore((s) => s.laneOpen)

  useEffect(() => {
    engine.setSong(getState().song)
    const unsub = useStore.subscribe((s, prev) => {
      if (s.song !== prev.song) engine.setSong(s.song)
      // newly tuned vocals are heard straight away, not from the next time their clip starts
      if (s.vocalVersion !== prev.vocalVersion) engine.refreshClips()
    })
    engine.onEnded = () => {
      if (getState().recording) stop()
      getState().set({ playing: false })
    }
    const unsyncTransport = syncTransport()
    const unwatchTakes = watchTakes()
    let stopAutosave: (() => void) | null = null
    void startAutosave().then((stopFn) => (stopAutosave = stopFn))
    void engine.init().then(() => engine.setVolume(getState().volume))
    void restoreSoundfont()
    void applyBackupFont()
    void restoreBackground()
    void initMidiInput()
    void window.keyfall.startupFile().then((p) => {
      if (p) void openMidiPath(p)
    })
    void window.keyfall.selftest().then((arg) => {
      if (arg) void import('./selftest').then((m) => m.runSelftest(arg))
    })
    window.addEventListener('keydown', onKey)
    return () => {
      unsub()
      unsyncTransport()
      unwatchTakes()
      stopAutosave?.()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  useEffect(() => {
    document.title = `${fileName}${dirty ? ' •' : ''} · Keyfall`
    window.keyfall.setDirty(dirty)
  }, [fileName, dirty])

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropping(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDropping(false)
        void handleDroppedFiles(e.dataTransfer.files)
      }}
    >
      <Transport />
      <Overview />
      <main className={`stage${laneOpen ? ' with-lane' : ''}`}>
        {laneOpen && <VelocityLane />}
        <FallView />
        <StudioPanel />
        <Banners />
        <Drawer />
      </main>
      <StatusBar />
      <Toast />
      <ContextMenu />
      <VocalNoteMenu />
      <ChordMenu />
      <VideoDialog />
      <HelpDialog />
      <Busy />
      {dropping && <div className="drop-hint">Drop a MIDI file to open it, or a soundfont to load it</div>}
    </div>
  )
}

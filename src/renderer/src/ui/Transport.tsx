import { useEffect, useRef, useState } from 'react'
import { engine } from '../audio/engine'
import { exportAudio } from '../actions/export'
import {
  addSoundfonts,
  forgetRecent,
  newSong,
  openMidi,
  openRecent,
  removeSoundfont,
  renameSoundfont,
  saveSong,
  switchSoundfont
} from '../actions/files'
import { SNAPS, tempoMap, ticksPerBar, ticksPerBeat, type Snap } from '../model/song'
import { invertSelection, quantize, selectAll, selectRange, selectSamePitch, selectTrack, setTempo, setTimeSig } from '../state/edit'
import { savePref } from '../state/prefs'
import { useStore, getState } from '../state/store'
import { setCountIn, togglePlay, toggleLoop, toggleMetronome, toggleRecord, goToStart } from '../actions/transport'
import * as I from './icons'

function fmtTime(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`
}

/** Bar.beat and clock readout, updated every frame without re-rendering React. */
function Clock(): React.JSX.Element {
  const barRef = useRef<HTMLSpanElement>(null)
  const timeRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let raf = 0
    const loop = (): void => {
      const { song } = getState()
      const t = engine.time()
      const tick = tempoMap(song).secToTick(t)
      const bar = Math.floor(tick / ticksPerBar(song)) + 1
      const beat = Math.floor((tick % ticksPerBar(song)) / ticksPerBeat(song)) + 1
      if (barRef.current) barRef.current.textContent = `${bar}.${beat}`
      if (timeRef.current) timeRef.current.textContent = `${fmtTime(t)} / ${fmtTime(engine.duration)}`
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div className="clock" title="Bar.beat and time">
      <span ref={barRef} className="clock-bar">1.1</span>
      <span ref={timeRef} className="clock-time">0:00.0</span>
    </div>
  )
}

/** A button that opens a dropdown; `children` gets a wrapper that closes the menu before running an item. */
function Menu(props: {
  trigger: React.ReactNode
  title?: string
  className?: string
  align?: 'left' | 'right'
  children: (run: (fn: () => void) => () => void) => React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const run = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }
  return (
    <div className="menu-wrap" ref={ref}>
      <button className={props.className ?? 'btn'} title={props.title} onClick={() => setOpen(!open)} aria-expanded={open}>
        {props.trigger}
      </button>
      {open && (
        <div className={`menu${props.align === 'left' ? ' left' : ''}`} role="menu">
          {props.children(run)}
        </div>
      )}
    </div>
  )
}

function ExportMenu(): React.JSX.Element {
  return (
    <Menu trigger={<><I.IconExport /> Export</>}>
      {(run) => (
        <>
          <div className="menu-label">Audio</div>
          <button role="menuitem" onClick={run(() => void exportAudio('wav'))}>WAV · lossless</button>
          <button role="menuitem" onClick={run(() => void exportAudio('mp3'))}>MP3 · 256 kbps</button>
          <div className="menu-label">Video</div>
          <button role="menuitem" onClick={run(() => getState().set({ videoOpen: true }))}>
            Video… <span className="kbd">Ctrl+E</span>
          </button>
        </>
      )}
    </Menu>
  )
}

function RecentMenu(): React.JSX.Element {
  const recent = useStore((s) => s.recent)
  return (
    <Menu trigger={<I.IconChevron size={14} />} title="Recent files" className="icon-btn caret" align="left">
      {(run) => (
        <>
          <div className="menu-label">Recent files</div>
          {recent.length === 0 && <div className="menu-empty">Songs you open or save show up here.</div>}
          {recent.map((r) => (
            <button key={r.path} role="menuitem" title={r.path} onClick={run(() => void openRecent(r.path))}>
              {r.name}
              <span className="menu-path">{r.path}</span>
            </button>
          ))}
          {recent.length > 0 && <button role="menuitem" className="muted" onClick={run(() => forgetRecent())}>Clear list</button>}
        </>
      )}
    </Menu>
  )
}

/** Soundfont picker: the library list with rename and remove, plus adding more. */
function SoundfontMenu(): React.JSX.Element {
  const sfName = useStore((s) => s.sfName)
  const sfLoading = useStore((s) => s.sfLoading)
  const library = useStore((s) => s.sfLibrary)
  const active = useStore((s) => s.sfActive)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const commit = (): void => {
    if (editing) renameSoundfont(editing, draft)
    setEditing(null)
  }
  return (
    <Menu
      className={`btn sf${sfName ? '' : ' warn'}`}
      title={sfName ? `Soundfont: ${sfName}` : 'Load a .sf2 / .sf3 soundfont'}
      trigger={
        <>
          <I.IconSoundfont size={16} />
          <span className="sf-name">{sfLoading ? 'Loading…' : (sfName ?? 'Load soundfont')}</span>
          <I.IconChevron size={14} />
        </>
      }
    >
      {(run) => (
        <>
          <div className="menu-label">Soundfonts</div>
          {library.length === 0 && <div className="menu-empty">Add your .sf2 and .sf3 files to switch between them here.</div>}
          <div className="sf-list">
            {library.map((e) => (
              <div key={e.path} className={`sf-row${e.path === active ? ' on' : ''}`}>
                {editing === e.path ? (
                  <input
                    id={`sf-rename-${library.indexOf(e)}`}
                    className="text-in"
                    autoFocus
                    value={draft}
                    aria-label="Soundfont name"
                    onChange={(ev) => setDraft(ev.target.value)}
                    onBlur={commit}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter') commit()
                      else if (ev.key === 'Escape') setEditing(null)
                      ev.stopPropagation()
                    }}
                  />
                ) : (
                  <button className="sf-pick" title={e.path} onClick={run(() => void switchSoundfont(e.path))}>
                    <span className="sf-dot" />
                    {e.name}
                  </button>
                )}
                <button
                  className="icon-btn small"
                  title="Rename"
                  onClick={() => {
                    setDraft(e.name)
                    setEditing(e.path)
                  }}
                >
                  <I.IconPencil size={14} />
                </button>
                <button className="icon-btn small" title="Remove from the list (the file isn't deleted)" onClick={() => removeSoundfont(e.path)}>
                  <I.IconClose size={14} />
                </button>
              </div>
            ))}
          </div>
          <button role="menuitem" onClick={run(() => void addSoundfonts())}>
            <I.IconPlus size={16} /> Add soundfonts…
          </button>
        </>
      )}
    </Menu>
  )
}

function selectLoop(): void {
  const l = getState().loop
  if (l) selectRange(l.start, l.end)
}

function SelectMenu(): React.JSX.Element {
  const hasLoop = useStore((s) => s.loop !== null)
  return (
    <Menu trigger={<>Select <I.IconChevron size={14} /></>} title="Select notes">
      {(run) => (
        <>
          <button role="menuitem" onClick={run(selectAll)}>Everything <span className="kbd">Ctrl+A</span></button>
          <button role="menuitem" onClick={run(() => selectTrack())}>Active track <span className="kbd">Ctrl+Shift+A</span></button>
          <button role="menuitem" onClick={run(selectSamePitch)}>Same pitch as selection <span className="kbd">Ctrl+Shift+P</span></button>
          <button role="menuitem" disabled={!hasLoop} onClick={run(selectLoop)}>Inside the loop <span className="kbd">Ctrl+L</span></button>
          <button role="menuitem" onClick={run(invertSelection)}>Invert selection <span className="kbd">Ctrl+I</span></button>
          <button role="menuitem" onClick={run(() => getState().setSelection(new Set()))}>Nothing <span className="kbd">Esc</span></button>
        </>
      )}
    </Menu>
  )
}

export function Transport(): React.JSX.Element {
  const playing = useStore((s) => s.playing)
  const recording = useStore((s) => s.recording)
  const tool = useStore((s) => s.tool)
  const snap = useStore((s) => s.snap)
  const pxPerSec = useStore((s) => s.pxPerSec)
  const volume = useStore((s) => s.volume)
  const midiInputs = useStore((s) => s.midiInputs)
  const drawerOpen = useStore((s) => s.drawerOpen)
  const laneOpen = useStore((s) => s.laneOpen)
  const metronome = useStore((s) => s.metronome)
  const countIn = useStore((s) => s.countIn)
  const loopOn = useStore((s) => s.loopOn)
  const canUndo = useStore((s) => s.past.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  const bpm = useStore((s) => s.song.tempos[0]?.bpm ?? 120)
  const tempoCount = useStore((s) => s.song.tempos.length)
  const timeSig = useStore((s) => s.song.timeSig)
  const set = useStore((s) => s.set)
  const [bpmText, setBpmText] = useState(String(bpm))
  useEffect(() => setBpmText(String(Math.round(bpm * 100) / 100)), [bpm])

  return (
    <header className="transport">
      <div className="group">
        <span className="brand">Keyfall</span>
        <button className="icon-btn" title="New song (Ctrl+N)" onClick={newSong}><I.IconNew /></button>
        <span className="split">
          <button className="icon-btn" title="Open MIDI file (Ctrl+O)" onClick={() => void openMidi()}><I.IconOpen /></button>
          <RecentMenu />
        </span>
        <button className="icon-btn" title="Save (Ctrl+S) · Save as (Ctrl+Shift+S)" onClick={() => void saveSong()}><I.IconSave /></button>
        <span className="sep" />
        <button className="icon-btn" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => getState().undo()}><I.IconUndo /></button>
        <button className="icon-btn" title="Redo (Ctrl+Y)" disabled={!canRedo} onClick={() => getState().redo()}><I.IconRedo /></button>
      </div>

      <div className="group center">
        <button className="icon-btn" title="Back to start (Home)" onClick={goToStart}><I.IconStart /></button>
        <button className={`play-btn${playing ? ' on' : ''}`} title="Play / pause (Space)" onClick={() => void togglePlay()}>
          {playing ? <I.IconPause size={20} /> : <I.IconPlay size={20} />}
        </button>
        <button
          className={`icon-btn rec${recording ? ' on' : ''}`}
          title={midiInputs.length ? 'Record from MIDI keyboard into the active track (R)' : 'Record (R) · no MIDI keyboard detected'}
          onClick={() => void toggleRecord()}
        >
          <I.IconRecord />
        </button>
        <button
          className={`icon-btn${metronome ? ' active' : ''}`}
          title={`Metronome (K): ${metronome ? 'on' : 'off'}`}
          aria-pressed={metronome}
          onClick={toggleMetronome}
        >
          <I.IconMetronome />
        </button>
        <select
          id="countin"
          className="select"
          title="Count-in before recording starts"
          value={countIn}
          onChange={(e) => setCountIn(Number(e.target.value))}
        >
          <option value={0}>No count-in</option>
          <option value={1}>Count 1 bar</option>
          <option value={2}>Count 2 bars</option>
        </select>
        <button
          className={`icon-btn${loopOn ? ' active' : ''}`}
          title="Loop (L): with notes selected, loops their bars. Shift+drag the overview strip to set the loop."
          aria-pressed={loopOn}
          onClick={toggleLoop}
        >
          <I.IconLoop />
        </button>
        <Clock />
        <label className="field" title={tempoCount > 1 ? 'Starting tempo (this file has tempo changes)' : 'Tempo'}>
          <input
            id="bpm"
            className="num"
            value={bpmText}
            onChange={(e) => setBpmText(e.target.value)}
            onBlur={() => {
              const v = parseFloat(bpmText)
              if (Number.isFinite(v)) setTempo(v)
              else setBpmText(String(bpm))
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <span>BPM{tempoCount > 1 ? '*' : ''}</span>
        </label>
        <select
          id="timesig"
          className="select"
          title="Time signature"
          value={`${timeSig[0]}/${timeSig[1]}`}
          onChange={(e) => {
            const [n, d] = e.target.value.split('/').map(Number)
            setTimeSig(n, d)
          }}
        >
          {['2/4', '3/4', '4/4', '5/4', '6/8', '7/8', '9/8', '12/8'].map((v) => <option key={v}>{v}</option>)}
          {!['2/4', '3/4', '4/4', '5/4', '6/8', '7/8', '9/8', '12/8'].includes(`${timeSig[0]}/${timeSig[1]}`) && (
            <option>{`${timeSig[0]}/${timeSig[1]}`}</option>
          )}
        </select>
      </div>

      <div className="group">
        <div className="seg" role="group" aria-label="Tool">
          <button className={tool === 'select' ? 'on' : ''} title="Select tool (V): drag to box-select, double-click to add" onClick={() => set({ tool: 'select' })}><I.IconSelect size={16} /></button>
          <button className={tool === 'draw' ? 'on' : ''} title="Draw tool (D): click and drag to draw notes" onClick={() => set({ tool: 'draw' })}><I.IconPencil size={16} /></button>
        </div>
        <label className="field" title="Snap grid (hold Alt while dragging to ignore it)">
          <I.IconMagnet size={16} />
          <select id="snap" className="select" value={snap} onChange={(e) => set({ snap: e.target.value as Snap })}>
            {SNAPS.map((s) => <option key={s} value={s}>{s === 'off' ? 'Off' : s}</option>)}
          </select>
        </label>
        <button className="btn" title="Quantize starts (Q) · Shift+click or Shift+Q also quantizes ends" onClick={(e) => quantize(e.shiftKey)}>Quantize</button>
        <SelectMenu />
        <input
          id="zoom"
          className="range"
          type="range"
          min={30}
          max={1200}
          value={pxPerSec}
          title="Zoom (Ctrl+scroll)"
          onChange={(e) => set({ pxPerSec: Number(e.target.value) })}
        />
        <span className="sep" />
        <label className="field" title="Volume">
          <I.IconVolume size={16} />
          <input
            id="volume"
            className="range short"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => {
              const v = Number(e.target.value)
              set({ volume: v })
              engine.setVolume(v)
            }}
          />
        </label>
        <SoundfontMenu />
        <span className={`midi-dot${midiInputs.length ? ' on' : ''}`} title={midiInputs.length ? `MIDI input: ${midiInputs.join(', ')}` : 'No MIDI keyboard connected'}>
          <I.IconMidi size={16} />
        </span>
        <ExportMenu />
        <button
          className={`icon-btn${laneOpen ? ' active' : ''}`}
          title="Velocity lane (Shift+V)"
          aria-pressed={laneOpen}
          onClick={() => {
            set({ laneOpen: !laneOpen })
            savePref('laneOpen', !laneOpen)
          }}
        >
          <I.IconVelocity />
        </button>
        <button className={`icon-btn${drawerOpen ? ' active' : ''}`} title="Tracks (T)" onClick={() => set({ drawerOpen: !drawerOpen })}><I.IconTracks /></button>
      </div>
    </header>
  )
}

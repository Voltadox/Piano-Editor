import { useEffect, useRef } from 'react'
import { deleteNotes, quantize, selectionSustained, selectSamePitch, setSustain, transpose } from '../state/edit'
import { getState, useStore } from '../state/store'
import { setNoteEdit } from '../state/vocalEdit'

/** Right-click menu for the selected notes. */
export function ContextMenu(): React.JSX.Element | null {
  const at = useStore((s) => s.contextMenu)
  const count = useStore((s) => s.selection.size)
  // re-read when the song changes so the tickbox reflects the pedal
  useStore((s) => s.song)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!at) return
    const close = (e: Event): void => {
      if (!ref.current?.contains(e.target as Node)) getState().set({ contextMenu: null })
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') getState().set({ contextMenu: null })
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('wheel', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('wheel', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [at])

  if (!at || !count) return null
  const sustained = selectionSustained()
  const run = (fn: () => void) => () => {
    getState().set({ contextMenu: null })
    fn()
  }
  // keep the menu inside the window
  const left = Math.min(at.x, window.innerWidth - 250)
  const top = Math.min(at.y, window.innerHeight - 260)

  return (
    <div ref={ref} className="menu context" role="menu" style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
      <div className="menu-label">{count.toLocaleString()} note{count === 1 ? '' : 's'} selected</div>
      <label className="menu-check">
        <input id="ctx-sustain" type="checkbox" checked={sustained} onChange={(e) => setSustain(e.target.checked)} />
        Sustain pedal
        <span className="kbd">re-pedals each bar</span>
      </label>
      <button role="menuitem" onClick={run(() => quantize(false))}>Quantize starts <span className="kbd">Q</span></button>
      <button role="menuitem" onClick={run(() => transpose(new Set(getState().selection), 12))}>Up an octave <span className="kbd">Shift+↑</span></button>
      <button role="menuitem" onClick={run(() => transpose(new Set(getState().selection), -12))}>Down an octave <span className="kbd">Shift+↓</span></button>
      <button role="menuitem" onClick={run(selectSamePitch)}>Select same pitch <span className="kbd">Ctrl+Shift+P</span></button>
      <button role="menuitem" className="danger" onClick={run(() => deleteNotes(new Set(getState().selection)))}>Delete <span className="kbd">Del</span></button>
    </div>
  )
}

/** Right-click menu for one sung note while editing pitch. */
export function VocalNoteMenu(): React.JSX.Element | null {
  const at = useStore((s) => s.vocalNoteMenu)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!at) return
    const close = (e: Event): void => {
      if (!ref.current?.contains(e.target as Node)) getState().set({ vocalNoteMenu: null })
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('wheel', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('wheel', close)
    }
  }, [at])

  if (!at) return null
  const { x, y, ...note } = at
  const run = (pitch: number | null | undefined) => () => {
    getState().set({ vocalNoteMenu: null })
    setNoteEdit(note, pitch)
  }
  return (
    <div ref={ref} className="menu context" role="menu" style={{ left: Math.min(x, window.innerWidth - 230), top: Math.min(y, window.innerHeight - 120) }} onContextMenu={(e) => e.preventDefault()}>
      <div className="menu-label">Sung note</div>
      <button role="menuitem" onClick={run(undefined)}>Back to autotune <span className="kbd">double-click</span></button>
      <button role="menuitem" onClick={run(null)}>Leave as sung</button>
    </div>
  )
}

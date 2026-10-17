import { useEffect } from 'react'
import { discardRecovery, restoreRecovery } from '../actions/autosave'
import { useStore } from '../state/store'

export function Toast(): React.JSX.Element | null {
  const toast = useStore((s) => s.toast)
  const set = useStore((s) => s.set)
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => set({ toast: null }), toast.tone === 'error' ? 6000 : 3000)
    return () => clearTimeout(id)
  }, [toast, set])
  if (!toast) return null
  return (
    <div className={`toast ${toast.tone}`} role="status" key={toast.id}>
      {toast.text}
    </div>
  )
}

export function Busy(): React.JSX.Element | null {
  const busy = useStore((s) => s.busy)
  if (!busy) return null
  return (
    <div className="busy-backdrop">
      <div className="busy" role="dialog" aria-label={busy.label}>
        <div className="busy-label">{busy.label}</div>
        <div className="bar"><div style={{ width: `${Math.round(busy.progress * 100)}%` }} /></div>
        <div className="busy-foot">
          <span>{Math.round(busy.progress * 100)}%</span>
          {busy.cancel && <button className="btn" onClick={busy.cancel}>Cancel</button>}
        </div>
      </div>
    </div>
  )
}

export function StatusBar(): React.JSX.Element {
  const selected = useStore((s) => s.selection.size)
  const tool = useStore((s) => s.tool)
  const fileName = useStore((s) => s.fileName)
  const dirty = useStore((s) => s.dirty)
  const active = useStore((s) => s.song.tracks.find((t) => t.id === s.activeTrackId))
  const hint =
    tool === 'draw'
      ? 'Draw: click and drag up to set length · right-click deletes · Alt ignores snap'
      : 'Double-click to add · drag a note to move · drag its top or bottom edge to resize · drag empty space to box-select · right-click deletes, or opens a menu for the selection'
  return (
    <footer className="status">
      <span className="file">{fileName}{dirty ? ' •' : ''}</span>
      {active && (
        <span className="active-track">
          <i style={{ background: active.color }} /> {active.name}
        </span>
      )}
      <span>{selected ? `${selected.toLocaleString()} selected · ↑↓ transpose · Del delete · Q quantize` : hint}</span>
      <span className="grow" />
      <span className="keys">Space play · scroll to scrub · Ctrl+scroll zoom</span>
    </footer>
  )
}

export function Banners(): React.JSX.Element {
  return (
    <div className="banners">
      <RecoveryBanner />
      <SoundfontBanner />
    </div>
  )
}

function RecoveryBanner(): React.JSX.Element | null {
  const recovery = useStore((s) => s.recovery)
  if (!recovery) return null
  const when = new Date(recovery.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <div className="banner recovery" role="alert">
      <span>
        <strong>Keyfall closed with unsaved changes.</strong> A copy of “{recovery.fileName}” was autosaved {when}.
      </span>
      <span className="banner-actions">
        <button className="btn primary" onClick={restoreRecovery}>Restore</button>
        <button className="btn" onClick={discardRecovery}>Discard</button>
      </span>
    </div>
  )
}

function SoundfontBanner(): React.JSX.Element | null {
  const sfName = useStore((s) => s.sfName)
  const sfLoading = useStore((s) => s.sfLoading)
  if (sfName || sfLoading) return null
  return (
    <div className="banner sf-banner">
      <strong>No soundfont loaded.</strong> Drop a <code>.sf2</code> or <code>.sf3</code> file anywhere on the window, or use{' '}
      <em>Load soundfont</em> in the top bar. Keyfall remembers it for next time.
    </div>
  )
}

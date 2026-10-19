import { useEffect, useRef, useState } from 'react'
import { exportAllTracks, exportTrack, type TrackRef } from '../actions/export'
import * as I from './icons'

/** A menu pinned to the window under (or above) a button, so a scrolling panel can't cut it off. */
function useFloatingMenu(): {
  open: { left: number; top: number } | null
  toggle: (e: React.MouseEvent<HTMLButtonElement>, height: number) => void
  close: () => void
  ref: React.RefObject<HTMLDivElement | null>
} {
  const [open, setOpen] = useState<{ left: number; top: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: Event): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('wheel', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('wheel', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  const toggle = (e: React.MouseEvent<HTMLButtonElement>, height: number): void => {
    if (open) return setOpen(null)
    const r = e.currentTarget.getBoundingClientRect()
    const below = r.bottom + 4 + height <= window.innerHeight
    setOpen({ left: Math.max(8, Math.min(r.right - 240, window.innerWidth - 248)), top: below ? r.bottom + 4 : Math.max(8, r.top - 4 - height) })
  }
  return { open, toggle, close: () => setOpen(null), ref }
}

/** The download button on a track: note tracks as MIDI, MP3 or WAV; audio tracks as MP3 or WAV. */
export function TrackExportButton({ track, name }: { track: TrackRef; name: string }): React.JSX.Element {
  const m = useFloatingMenu()
  const run = (fn: () => void) => () => {
    m.close()
    fn()
  }
  const notes = track.kind === 'notes'
  return (
    <div ref={m.ref} className="track-export">
      <button className="icon-btn small" title={`Export ${name} on its own`} aria-expanded={!!m.open} onClick={(e) => m.toggle(e, notes ? 150 : 115)}>
        <I.IconExport size={15} />
      </button>
      {m.open && (
        <div className="menu context" role="menu" style={m.open}>
          <div className="menu-label">Export this track</div>
          {notes && (
            <button role="menuitem" onClick={run(() => void exportTrack(track, 'mid'))}>
              MIDI <span className="kbd">notes</span>
            </button>
          )}
          <button role="menuitem" onClick={run(() => void exportTrack(track, 'mp3'))}>
            MP3 <span className="kbd">256 kbps</span>
          </button>
          <button role="menuitem" onClick={run(() => void exportTrack(track, 'wav'))}>
            WAV <span className="kbd">lossless</span>
          </button>
        </div>
      )}
    </div>
  )
}

/** Every track at once, into a folder. */
export function ExportAllTracksButton(): React.JSX.Element {
  const m = useFloatingMenu()
  const run = (fn: () => void) => () => {
    m.close()
    fn()
  }
  return (
    <div ref={m.ref} className="track-export all">
      <button className="btn" title="Save every track as its own file, into a folder you choose" aria-expanded={!!m.open} onClick={(e) => m.toggle(e, 150)}>
        <I.IconExport size={16} /> Export all tracks…
      </button>
      {m.open && (
        <div className="menu context" role="menu" style={m.open}>
          <div className="menu-label">Every track into a folder</div>
          <button role="menuitem" onClick={run(() => void exportAllTracks('midi+mp3'))}>
            Note tracks as MIDI, audio as MP3
          </button>
          <button role="menuitem" onClick={run(() => void exportAllTracks('mp3'))}>
            All as MP3 stems
          </button>
          <button role="menuitem" onClick={run(() => void exportAllTracks('wav'))}>
            All as WAV stems <span className="kbd">lossless</span>
          </button>
        </div>
      )}
    </div>
  )
}

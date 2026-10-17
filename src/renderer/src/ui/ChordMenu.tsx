import { useEffect, useRef } from 'react'
import { engine } from '../audio/engine'
import { chordLabel, setChordAt } from '../actions/reference'
import { songKey } from '../model/guide'
import { getState, useStore } from '../state/store'

const SCALE = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] }
const MAJOR_Q = [false, true, true, false, false, true, true]
const MINOR_Q = [true, true, false, true, true, false, false]

function hear(c: { root: number; minor: boolean }): void {
  if (c.root < 0) return
  const root = 48 + c.root
  for (const p of [root - 12, root, root + (c.minor ? 3 : 4), root + 7]) engine.previewNote(0, p, 80, 0.8)
}

/** Changes one chord in the chord lane: the key's chords first, then any major or minor chord. */
export function ChordMenu(): React.JSX.Element | null {
  const at = useStore((s) => s.chordMenu)
  const song = useStore((s) => s.song)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!at) return
    const close = (e: Event): void => {
      if (!ref.current?.contains(e.target as Node)) getState().set({ chordMenu: null })
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') getState().set({ chordMenu: null })
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

  const current = at ? song.chords[at.index] : undefined
  if (!at || !current) return null
  const key = songKey(song)
  const scale = key ? (key.minor ? SCALE.minor : SCALE.major).map((s) => (s + key.tonic) % 12) : []
  const qual = key ? (key.minor ? MINOR_Q : MAJOR_Q) : []
  const inKey = scale.map((root, i) => ({ root, minor: qual[i] }))
  const pick = (c: { root: number; minor: boolean } | null) => () => {
    getState().set({ chordMenu: null })
    setChordAt(at.index, c)
    if (c) hear(c)
  }
  const left = Math.min(at.x, window.innerWidth - 300)
  const top = Math.min(at.y, window.innerHeight - 330)
  const same = (c: { root: number; minor: boolean }): boolean => c.root === current.root && c.minor === current.minor

  return (
    <div ref={ref} className="menu context chord-menu" role="menu" style={{ left, top }}>
      <div className="menu-label">Chord: {chordLabel(current)}</div>
      {inKey.length > 0 && (
        <>
          <div className="menu-label">In the key</div>
          <div className="chord-grid">
            {inKey.map((c) => (
              <button key={`${c.root}${c.minor}`} className={same(c) ? 'on' : ''} onMouseEnter={() => hear(c)} onClick={pick(c)}>
                {chordLabel(c)}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="menu-label">Any chord</div>
      <div className="chord-grid wide">
        {[false, true].flatMap((minor) =>
          [...Array(12).keys()].map((root) => (
            <button key={`${root}${minor}`} className={same({ root, minor }) ? 'on' : ''} onClick={pick({ root, minor })}>
              {chordLabel({ root, minor })}
            </button>
          ))
        )}
      </div>
      <button role="menuitem" onClick={pick({ root: -1, minor: false })}>No chord here</button>
      <button role="menuitem" className="danger" onClick={pick(null)}>Remove this change (keep the previous chord)</button>
    </div>
  )
}

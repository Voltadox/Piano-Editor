import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { importChoices, saveImportChoices, type ImportChoices } from '../actions/reference'
import * as I from './icons'

/** The song waiting to be brought in, and who's waiting for the answer. */
const useAsk = create<{ name: string | null; resolve: ((c: ImportChoices | null) => void) | null }>()(() => ({ name: null, resolve: null }))

/** Asks what to bring in from a song: resolves with the choices, or null if cancelled. */
export function askImportChoices(name: string): Promise<ImportChoices | null> {
  useAsk.getState().resolve?.(null)
  return new Promise((resolve) => useAsk.setState({ name, resolve }))
}

type Key = keyof ImportChoices

const GROUPS: { title: string; hint: string; items: { key: Key; label: string; hint: string; needs?: Key }[] }[] = [
  {
    title: 'From listening',
    hint: 'A few seconds.',
    items: [
      { key: 'key', label: 'Key', hint: 'sets the song’s key' },
      { key: 'chords', label: 'Chord names', hint: 'on the left of the stage, for chord suggestions and harmonies' },
      { key: 'chordPad', label: 'Chords pad track', hint: 'plays those chords (muted to start)', needs: 'chords' },
      { key: 'sections', label: 'Sections', hint: 'Intro, Verse, Chorus… markers' }
    ]
  },
  {
    title: 'From the vocals',
    hint: 'Separates the vocals first: about a minute, 67 MB to download the first time.',
    items: [
      { key: 'melody', label: 'Melody to sing', hint: 'the lead vocal as notes' },
      { key: 'harmonies', label: 'Harmonies to sing', hint: 'lines sung above and below the lead' },
      { key: 'lyrics', label: 'Lyrics', hint: 'shown over the stage (80 MB the first time)' }
    ]
  },
  {
    title: 'Backing track as MIDI',
    hint: 'Recreated with the closest sounds in your soundfonts: a minute or two, 60 MB the first time.',
    items: [
      { key: 'drums', label: 'Drums', hint: 'kick, snare, hats, toms and cymbals' },
      { key: 'bass', label: 'Bass', hint: 'the bass line' },
      { key: 'keys', label: 'Keys', hint: 'the chords and lines on top' }
    ]
  }
]

/** Before a song comes in: tick what to bring into the song, and nothing else is added. */
export function ImportDialog(): React.JSX.Element | null {
  const { name, resolve } = useAsk()
  const [c, setC] = useState<ImportChoices>(importChoices)
  useEffect(() => {
    if (name) setC(importChoices())
  }, [name])

  const finish = (choices: ImportChoices | null): void => {
    if (choices) saveImportChoices(choices)
    resolve?.(choices)
    useAsk.setState({ name: null, resolve: null })
  }

  useEffect(() => {
    if (!name) return
    // the dialog has the keyboard: nothing reaches the stage's shortcuts underneath
    const onKey = (e: KeyboardEvent): void => {
      e.stopImmediatePropagation()
      if (e.key === 'Escape') finish(null)
      else if (e.key === 'Enter') {
        e.preventDefault()
        finish(c)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  if (!name) return null
  const set = (key: Key, on: boolean): void => setC((prev) => ({ ...prev, [key]: on, ...(key === 'chords' && !on ? { chordPad: false } : {}) }))
  const all = (on: boolean): void => setC((prev) => Object.fromEntries(Object.keys(prev).map((k) => [k, on])) as unknown as ImportChoices)
  return (
    <div className="busy-backdrop" onMouseDown={(e) => e.target === e.currentTarget && finish(null)}>
      <div className="vdialog import" role="dialog" aria-label="Bring in a song">
        <div className="vhead">
          <h2>What do you want from {name.replace(/\.[^.]+$/, '')}?</h2>
          <button className="icon-btn" title="Cancel (Esc)" onClick={() => finish(null)}><I.IconClose size={16} /></button>
        </div>
        <div className="import-body">
          <p className="drawer-hint tight">
            The song itself always comes in, with its tempo and bar lines, so whatever you pick lines up with it. Mute it any time. Nothing you leave unticked is
            added.
          </p>
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3>{g.title} <span className="meta">{g.hint}</span></h3>
              {g.items.map((it) => {
                const off = it.needs ? !c[it.needs] : false
                return (
                  <label key={it.key} className={`check import-item${off ? ' off' : ''}`}>
                    <input id={`import-${it.key}`} type="checkbox" checked={c[it.key]} disabled={off} onChange={(e) => set(it.key, e.target.checked)} />
                    <span>{it.label}</span> <span className="meta">{off ? 'needs chord names' : it.hint}</span>
                  </label>
                )
              })}
            </section>
          ))}
        </div>
        <div className="whats-new-foot">
          <button className="btn" onClick={() => all(false)}>None</button>
          <button className="btn" onClick={() => all(true)}>All</button>
          <span className="grow" />
          <button className="btn" onClick={() => finish(null)}>Cancel</button>
          <button id="import-go" className="btn primary" onClick={() => finish(c)}>Bring it in</button>
        </div>
      </div>
    </div>
  )
}

import { engine } from '../audio/engine'
import { tempoMap, ticksPerBar } from '../model/song'
import { addSection, deleteSection, duplicateSection, moveSection, removeSectionMarker, renameSection, sectionRange } from '../state/arrange'
import { getState, useStore } from '../state/store'
import * as I from './icons'

const NAMES = ['Intro', 'Verse', 'Pre-chorus', 'Chorus', 'Bridge', 'Outro']

/** The Sections tab: name parts of the song, then duplicate, delete or reorder them. */
export function SectionsPanel(): React.JSX.Element {
  const song = useStore((s) => s.song)
  const sections = [...song.sections].sort((a, b) => a.bar - b.bar)
  const here = (): number => Math.floor(tempoMap(getState().song).secToTick(engine.time()) / ticksPerBar(getState().song))

  return (
    <>
      <p className="drawer-hint">
        Mark where each part starts. A section runs to the next marker. Duplicating, deleting or moving one moves everything in it: notes, pedal, drums and vocals.
      </p>
      <div className="vtrack-chips pad">
        {NAMES.map((n) => (
          <button key={n} className="vchip add" title={`Start a ${n} at the playhead's bar`} onClick={() => addSection(here(), n)}>
            <I.IconPlus size={14} /> {n}
          </button>
        ))}
      </div>
      {sections.length === 0 && <p className="drawer-hint">No sections yet. Move the playhead to where a part starts and add one.</p>}
      <ul className="section-list">
        {sections.map((s, i) => {
          const { from, to } = sectionRange(song, s)
          return (
            <li key={s.id} className="section-row">
              <input id={`sec-${s.id}`} className="track-name" value={s.name} aria-label="Section name" onChange={(e) => renameSection(s.id, e.target.value)} />
              <button className="clip-go" title="Jump here" onClick={() => engine.seek(tempoMap(song).tickToSec(from * ticksPerBar(song)))}>
                Bars {from + 1}–{to}
              </button>
              <span className="section-actions">
                <button className="icon-btn small" title="Move earlier" disabled={i === 0} onClick={() => moveSection(s.id, -1)}>↑</button>
                <button className="icon-btn small" title="Move later" disabled={i === sections.length - 1} onClick={() => moveSection(s.id, 1)}>↓</button>
                <button className="icon-btn small" title="Duplicate: play it twice" onClick={() => duplicateSection(s.id)}><I.IconPlus size={14} /></button>
                <button className="icon-btn small" title="Delete the section and its bars" onClick={() => deleteSection(s.id)}><I.IconTrash size={14} /></button>
                <button className="icon-btn small" title="Remove the marker only" onClick={() => removeSectionMarker(s.id)}><I.IconClose size={14} /></button>
              </span>
            </li>
          )
        })}
      </ul>
    </>
  )
}

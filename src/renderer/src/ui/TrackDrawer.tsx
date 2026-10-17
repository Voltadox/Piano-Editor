import { engine } from '../audio/engine'
import { GM_NAMES } from '../model/gm'
import { DRUM_CHANNEL, PALETTE } from '../model/song'
import { addTrack, removeTrack, setDrums, updateTrack } from '../state/edit'
import { useStore } from '../state/store'
import * as I from './icons'

export function TrackDrawer(): React.JSX.Element {
  const tracks = useStore((s) => s.song.tracks)
  const activeTrackId = useStore((s) => s.activeTrackId)
  const open = useStore((s) => s.drawerOpen)
  const set = useStore((s) => s.set)

  return (
    <aside className={`drawer${open ? ' open' : ''}`} aria-hidden={!open}>
      <div className="drawer-head">
        <h2>Tracks</h2>
        <button className="icon-btn" title="Close (T)" onClick={() => set({ drawerOpen: false })}><I.IconClose size={16} /></button>
      </div>
      <p className="drawer-hint">New notes go into the highlighted track. Clicking a note also selects its track.</p>
      <ul className="track-list">
        {tracks.map((t) => {
          const drums = t.channel === DRUM_CHANNEL
          return (
            <li
              key={t.id}
              className={`track${t.id === activeTrackId ? ' active' : ''}`}
              onMouseDown={() => set({ activeTrackId: t.id })}
            >
              <div className="track-row">
                <label className="swatch" style={{ background: t.color }} title="Track colour">
                  <input
                    id={`color-${t.id}`}
                    type="color"
                    value={t.color}
                    onChange={(e) => updateTrack(t.id, { color: e.target.value })}
                  />
                </label>
                <input
                  id={`name-${t.id}`}
                  className="track-name"
                  value={t.name}
                  onChange={(e) => updateTrack(t.id, { name: e.target.value })}
                  aria-label="Track name"
                />
                <button className={`ms${t.muted ? ' on mute' : ''}`} title="Mute" onClick={() => updateTrack(t.id, { muted: !t.muted })}>M</button>
                <button className={`ms${t.solo ? ' on solo' : ''}`} title="Solo" onClick={() => updateTrack(t.id, { solo: !t.solo })}>S</button>
              </div>
              <div className="track-row sub">
                <select
                  id={`program-${t.id}`}
                  className="select grow"
                  value={drums ? 'drums' : String(t.program)}
                  onChange={(e) => {
                    if (e.target.value === 'drums') setDrums(t.id, true)
                    else {
                      if (drums) setDrums(t.id, false)
                      updateTrack(t.id, { program: Number(e.target.value) })
                      engine.previewNote(t.channel, 60, 90, 0.4)
                    }
                  }}
                  aria-label="Instrument"
                >
                  <option value="drums">Drum kit (channel 10)</option>
                  {GM_NAMES.map((n, i) => (
                    <option key={i} value={i}>{`${i + 1}. ${n}`}</option>
                  ))}
                </select>
                <span className="meta" title="MIDI channel">ch {t.channel + 1}</span>
                <span className="meta" title="Notes">{t.notes.length.toLocaleString()}</span>
                <button className="icon-btn small" title="Delete track (undo with Ctrl+Z)" onClick={() => removeTrack(t.id)}><I.IconTrash size={15} /></button>
              </div>
              <div className="palette">
                {PALETTE.map((c) => (
                  <button key={c} style={{ background: c }} title={c} className={c === t.color ? 'on' : ''} onClick={() => updateTrack(t.id, { color: c })} />
                ))}
              </div>
            </li>
          )
        })}
      </ul>
      <button className="btn add-track" onClick={addTrack}><I.IconPlus size={16} /> Add track</button>
    </aside>
  )
}

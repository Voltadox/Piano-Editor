import { GM_NAMES } from '../model/gm'
import { DRUM_CHANNEL, PALETTE } from '../model/song'
import { addTrack, choosePreset, removeTrack, selectTrack, setDrums, updateTrack } from '../state/edit'
import { useStore } from '../state/store'
import * as I from './icons'
import { TrackExportButton } from './TrackExport'
import { FontChoice, FontPresets } from './SoundPicker'

/** The Tracks tab: instruments, colours, mute and solo for the note tracks. */
export function TracksPanel(): React.JSX.Element {
  const tracks = useStore((s) => s.song.tracks)
  const activeTrackId = useStore((s) => s.activeTrackId)
  const set = useStore((s) => s.set)
  const presets = useStore((s) => s.sfPresets)
  const sfName = useStore((s) => s.sfName)

  return (
    <>
      <p className="drawer-hint">Click a track to select all its notes, ready to move, transpose or delete together (Ctrl+click adds another track). New notes go into the highlighted track.</p>
      <ul className="track-list">
        {tracks.map((t) => {
          const drums = t.channel === DRUM_CHANNEL
          return (
            <li
              key={t.id}
              className={`track${t.id === activeTrackId ? ' active' : ''}`}
              onMouseDown={(e) => {
                set({ activeTrackId: t.id })
                // the track's own controls just do their job; anywhere else picks up all its notes
                if (!(e.target as Element).closest('input, select, button, label')) selectTrack(t.id, e.ctrlKey || e.shiftKey, '')
              }}
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
                <FontChoice track={t} />
              </div>
              <div className="track-row sub">
                {t.font ? (
                  <FontPresets track={{ ...t, font: t.font }} />
                ) : presets.length ? (
                  <select
                    id={`program-${t.id}`}
                    className="select grow"
                    value={`${drums ? 'd' : 'p'}:${t.bank}:${t.program}`}
                    title={`Presets in ${sfName ?? 'the soundfont'}`}
                    onChange={(e) => {
                      const [kind, bank, program] = e.target.value.split(':')
                      choosePreset(t.id, kind === 'd', Number(bank), Number(program))
                    }}
                    aria-label="Instrument"
                  >
                    {!presets.some((p) => p.drum === drums && p.bank === t.bank && p.program === t.program) && (
                      <option value={`${drums ? 'd' : 'p'}:${t.bank}:${t.program}`}>{`${GM_NAMES[t.program] ?? 'Program'} (not in this soundfont)`}</option>
                    )}
                    <optgroup label="Instruments">
                      {presets.filter((p) => !p.drum).map((p) => (
                        <option key={`p${p.bank}:${p.program}`} value={`p:${p.bank}:${p.program}`}>{`${p.name}  ·  ${p.bank}:${p.program + 1}`}</option>
                      ))}
                    </optgroup>
                    {presets.some((p) => p.drum) && (
                      <optgroup label="Drum kits">
                        {presets.filter((p) => p.drum).map((p) => (
                          <option key={`d${p.bank}:${p.program}`} value={`d:${p.bank}:${p.program}`}>{p.name}</option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                ) : (
                  <select
                    id={`program-${t.id}`}
                    className="select grow"
                    value={drums ? 'drums' : String(t.program)}
                    onChange={(e) => {
                      if (e.target.value === 'drums') setDrums(t.id, true)
                      else choosePreset(t.id, false, 0, Number(e.target.value))
                    }}
                    aria-label="Instrument"
                  >
                    <option value="drums">Drum kit (channel 10)</option>
                    {GM_NAMES.map((n, i) => (
                      <option key={i} value={i}>{`${i + 1}. ${n}`}</option>
                    ))}
                  </select>
                )}
                <span className="meta" title="MIDI channel">ch {t.channel + 1}</span>
                <span className="meta" title="Notes">{t.notes.length.toLocaleString()}</span>
                <TrackExportButton track={{ kind: 'notes', id: t.id }} name={t.name} />
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
    </>
  )
}

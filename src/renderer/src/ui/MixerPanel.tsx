import { engine } from '../audio/engine'
import { setTrackMix } from '../state/edit'
import { getState, useStore } from '../state/store'
import { updateAudioTrack } from '../state/vocalEdit'
import { Slider } from './controls'
import { ExportAllTracksButton, TrackExportButton } from './TrackExport'
import type { TrackRef } from '../actions/export'

interface Row {
  key: string
  /** which track, for exporting it */
  track: TrackRef
  name: string
  color: string
  kind: 'notes' | 'vocal' | 'song' | 'stem'
  volume: number
  pan: number
  /** reverb send for note tracks, effect amount for vocals */
  fx: number
  muted: boolean
  solo: boolean
  set: (patch: { volume?: number; pan?: number; fx?: number; muted?: boolean; solo?: boolean }) => void
}

function ChannelRow({ r }: { r: Row }): React.JSX.Element {
  return (
    <li className="mix-row">
      <div className="mix-name">
        <i style={{ background: r.color }} />
        <span title={r.name}>{r.name}</span>
        <span className="meta">{r.kind}</span>
        <button className={`ms${r.muted ? ' on mute' : ''}`} title="Mute" onClick={() => r.set({ muted: !r.muted })}>M</button>
        <button className={`ms${r.solo ? ' on solo' : ''}`} title="Solo" onClick={() => r.set({ solo: !r.solo })}>S</button>
        <TrackExportButton track={r.track} name={r.name} />
      </div>
      <label className="mix-ctl">
        <span>Level</span>
        <Slider id={`mix-vol-${r.key}`} value={r.volume} min={0} max={1} onChange={(volume) => r.set({ volume })} />
        <span className="meta num-out">{Math.round(r.volume * 100)}</span>
      </label>
      <label className="mix-ctl">
        <span>Pan</span>
        <Slider id={`mix-pan-${r.key}`} value={r.pan} min={-1} max={1} onChange={(pan) => r.set({ pan })} />
        <span className="meta num-out">{r.pan === 0 ? 'C' : `${r.pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(r.pan) * 100)}`}</span>
      </label>
      <label className="mix-ctl" title={r.kind === 'notes' ? 'Reverb send' : 'How much of the vocal preset (reverb, delay, doubles)'}>
        <span>{r.kind === 'notes' ? 'Reverb' : 'Effect'}</span>
        <Slider id={`mix-fx-${r.key}`} value={r.fx} min={0} max={1} onChange={(fx) => r.set({ fx })} />
        <span className="meta num-out">{Math.round(r.fx * 100)}</span>
      </label>
    </li>
  )
}

/** The Mixer tab: level, pan and reverb/effect for every note and vocal track, plus the master. */
export function MixerPanel(): React.JSX.Element {
  const tracks = useStore((s) => s.song.tracks)
  const audio = useStore((s) => s.song.audioTracks)
  const volume = useStore((s) => s.volume)
  const rows: Row[] = [
    ...tracks.map(
      (t): Row => ({
        key: `n${t.id}`,
        track: { kind: 'notes', id: t.id },
        name: t.name,
        color: t.color,
        kind: 'notes',
        volume: t.volume,
        pan: t.pan,
        fx: t.reverb,
        muted: t.muted,
        solo: t.solo,
        set: (p) => setTrackMix(t.id, stripUndefined({ volume: p.volume, pan: p.pan, reverb: p.fx, muted: p.muted, solo: p.solo }))
      })
    ),
    ...audio.map(
      (t): Row => ({
        key: `a${t.id}`,
        track: { kind: 'audio', id: t.id },
        name: t.name,
        color: t.color,
        kind: t.kind === 'reference' ? 'song' : t.kind === 'stem' || t.kind === 'beatbox' ? 'stem' : 'vocal',
        volume: t.volume,
        pan: t.pan,
        fx: t.amount,
        muted: t.muted,
        solo: t.solo,
        set: (p) => updateAudioTrack(t.id, stripUndefined({ volume: p.volume, pan: p.pan, amount: p.fx, muted: p.muted, solo: p.solo }))
      })
    )
  ]
  return (
    <>
      <p className="drawer-hint">Balance the parts. Note tracks that shared a MIDI channel get their own when you mix them apart.</p>
      <ul className="mix-list">
        {rows.map((r) => (
          <ChannelRow key={r.key} r={r} />
        ))}
        <li className="mix-row master">
          <div className="mix-name">
            <span>Master</span>
            <span className="meta">limiter on</span>
          </div>
          <label className="mix-ctl">
            <span>Level</span>
            <input
              id="mix-master"
              className="range"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => {
                const v = Number(e.target.value)
                getState().set({ volume: v })
                engine.setVolume(v)
              }}
            />
            <span className="meta num-out">{Math.round(volume * 100)}</span>
          </label>
        </li>
      </ul>
      <div className="export-all-row">
        <ExportAllTracksButton />
        <span className="meta">Each track as its own file (stems line up from the start of the song). The download button on a track exports just that one.</span>
      </div>
    </>
  )
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

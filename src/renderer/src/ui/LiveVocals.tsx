import { useEffect, useRef } from 'react'
import { liveReading, setLive, startLive, stopLive } from '../audio/liveVocal'
import { micLevel } from '../audio/vocalRecorder'
import { PRESET_TUNING, VOCAL_PRESETS } from '../model/audio'
import { noteName } from '../model/song'
import { getState, useStore } from '../state/store'
import { Choice, Field, Slider } from './controls'

/** "E4", "E4 +12¢" */
function pitchText(m: number): string {
  const r = Math.round(m)
  const c = Math.round((m - r) * 100)
  return c ? `${noteName(r)} ${c > 0 ? '+' : ''}${c}¢` : noteName(r)
}

/**
 * Live autotune in Studio mode: the mic is tuned as you sing and mixed with the piano, for
 * singing along live or on a stream.
 */
export function LiveVocals(): React.JSX.Element {
  const on = useStore((s) => s.liveTune)
  const s = useStore((s) => s.live)
  const hasMelody = useStore((st) => st.song.tracks.some((t) => t.role === 'melody'))
  const meter = useRef<HTMLDivElement>(null)
  const readout = useRef<HTMLSpanElement>(null)

  // the mic runs while this is ticked and Studio mode is open
  useEffect(() => {
    if (!on) return
    startLive().catch((err) => {
      getState().set({ liveTune: false })
      getState().notify(`Couldn't start live autotune. ${err instanceof Error ? err.message : ''} Check a microphone is plugged in and allowed in Windows privacy settings.`, 'error')
    })
    return () => stopLive()
  }, [on])

  // level meter and what's being sung, without re-rendering React
  useEffect(() => {
    if (!on) return
    let raf = 0
    const loop = (): void => {
      if (meter.current) meter.current.style.width = `${Math.min(100, Math.sqrt(micLevel()) * 100)}%`
      const r = liveReading()
      if (readout.current) readout.current.textContent = r ? `${pitchText(r.sung)} → ${Number.isNaN(r.target) ? '—' : noteName(r.target)}` : 'Sing to see your pitch'
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [on])

  return (
    <div className="live-vocals">
      <label className="check" title="Tunes your microphone as you sing and mixes it with the piano. Use headphones, or the speakers feed back into the mic.">
        <input id="live-tune" type="checkbox" checked={on} onChange={(e) => getState().set({ liveTune: e.target.checked })} /> Autotune my mic live
      </label>
      {on && (
        <>
          <div className="live-meter" title="Mic level">
            <div ref={meter} />
          </div>
          <span ref={readout} className="live-readout meta" />
          <Field label="Tune to">
            <Choice
              label="Tune to"
              value={s.snap}
              onChange={(snap) => setLive({ snap })}
              options={[
                { value: 'key', label: 'Key', title: 'The key Studio hears you playing (or the song’s key)' },
                { value: 'chords', label: 'My chords', title: 'The notes you’re holding on the keyboard; the last chord while you’re not' },
                { value: 'song', label: 'Song', title: hasMelody ? 'The reference song’s melody at the playhead, while it plays' : 'Separate a reference song’s vocals first', disabled: !hasMelody }
              ]}
            />
          </Field>
          <Field label="Retune">
            <Slider id="live-speed" value={s.speed} min={0} max={1} title="Natural keeps your vibrato and slides; Hard snaps flat to the note" onChange={(speed) => setLive({ speed })} />
          </Field>
          <Field label="Pitch">
            <Slider id="live-pitch" value={s.transpose} min={-12} max={12} step={1} onChange={(transpose) => setLive({ transpose })} />
            <span className="meta num-out">{s.transpose > 0 ? '+' : ''}{s.transpose} st</span>
          </Field>
          <Field label="Tone">
            <Slider id="live-tone" value={s.formant} min={-4} max={4} step={0.25} title="Deeper ↔ airier, without changing the pitch" onChange={(formant) => setLive({ formant })} />
          </Field>
          <Field label="Effect">
            <select
              id="live-preset"
              className="select grow"
              value={s.preset}
              onChange={(e) => {
                // the sounds that bring their own tuning set it live too
                const preset = e.target.value as typeof s.preset
                setLive({ preset, ...PRESET_TUNING[preset] })
              }}
            >
              {VOCAL_PRESETS.map((p) => (
                <option key={p.id} value={p.id} title={p.hint}>{p.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Amount">
            <Slider id="live-amount" value={s.amount} min={0} max={1} onChange={(amount) => setLive({ amount })} />
          </Field>
          <Field label="Level">
            <Slider id="live-volume" value={s.volume} min={0} max={1.5} title="Your voice against the piano" onChange={(volume) => setLive({ volume })} />
          </Field>
          <p className="live-tip">Use headphones. On a stream, add Keyfall as an Application Audio Capture source in OBS: the piano and your tuned voice come through together.</p>
        </>
      )}
    </div>
  )
}

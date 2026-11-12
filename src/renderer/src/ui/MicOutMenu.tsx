import { useEffect, useRef, useState } from 'react'
import { setLive } from '../audio/liveVocal'
import { listMicOutDevices, micOutLevel, setMicOut } from '../audio/micOut'
import { PRESET_TUNING, VOCAL_PRESETS } from '../model/audio'
import type { LiveSettings } from '../model/live'
import { isCableOut } from '../model/micOut'
import { useStore } from '../state/store'
import { Menu } from './Menu'
import * as I from './icons'

/** "CABLE Input (VB-Audio Virtual Cable)" → "CABLE Input" */
const short = (label: string): string => label.replace(/\s*\([^()]*\)\s*$/, '') || label

/**
 * The Keyfall mic: your voice and Keyfall's piano sent to a virtual cable, so other apps (Discord,
 * OBS, games) can use them together as one microphone.
 */
export function MicOutMenu(): React.JSX.Element {
  const s = useStore((st) => st.micOut)
  const status = useStore((st) => st.micOutStatus)
  const live = useStore((st) => st.liveTune)
  const title =
    status.state === 'on'
      ? `Keyfall mic: on, sending your voice and the piano to ${short(status.sink)}`
      : status.state === 'no-cable' || status.state === 'error'
        ? 'Keyfall mic: needs attention'
        : 'Keyfall mic: send your voice and the piano to other apps as one microphone'
  const cls = status.state === 'on' ? (s.muted ? ' on muted' : ' on') : status.state === 'no-cable' || status.state === 'error' ? ' warn' : ''
  return (
    <Menu trigger={<I.IconMic size={16} />} title={title} className={`icon-btn mic-out${cls}`}>
      {() => (
        <>
          <label className="menu-check">
            <input id="mic-out-on" type="checkbox" checked={s.on} onChange={(e) => setMicOut({ on: e.target.checked })} />
            Keyfall mic
            <span className="kbd">voice + piano</span>
          </label>
          <Status />
          {s.on && <Settings live={live} />}
        </>
      )}
    </Menu>
  )
}

function Status(): React.JSX.Element | null {
  const s = useStore((st) => st.micOut)
  const status = useStore((st) => st.micOutStatus)
  if (!s.on) {
    return <div className="menu-empty mic-out-note">Sends your microphone and everything Keyfall plays (not the metronome) into a virtual cable. Other apps pick the cable as their mic and hear both, while Keyfall is open.</div>
  }
  switch (status.state) {
    case 'starting':
      return <div className="menu-empty">Starting…</div>
    case 'on':
      return (
        <div className="menu-empty mic-out-note">
          Sending to <b>{short(status.sink)}</b>. In Discord, OBS and so on, pick its other end as your microphone{/CABLE/i.test(status.sink) ? ' (CABLE Output, or whatever you renamed it to)' : ''}.
        </div>
      )
    case 'no-cable':
      return (
        <div className="menu-empty mic-out-note warn">
          No virtual cable found. Install VB-CABLE (free, from vb-audio.com), then restart your PC. Keyfall picks it up by itself. Or pick an output below.
        </div>
      )
    case 'error':
      return <div className="menu-empty mic-out-note warn">{status.message}</div>
    default:
      return null
  }
}

function Settings({ live }: { live: boolean }): React.JSX.Element {
  const s = useStore((st) => st.micOut)
  const liveMonitor = useStore((st) => st.live.monitor)
  const [devices, setDevices] = useState<{ outputs: MediaDeviceInfo[]; mics: MediaDeviceInfo[] }>({ outputs: [], mics: [] })
  const meter = useRef<HTMLDivElement>(null)

  // the device lists, kept up to date while the menu is open
  useEffect(() => {
    const load = (): void => void listMicOutDevices().then(setDevices)
    load()
    navigator.mediaDevices.addEventListener('devicechange', load)
    return () => navigator.mediaDevices.removeEventListener('devicechange', load)
  }, [])

  useEffect(() => {
    let raf = 0
    const loop = (): void => {
      if (meter.current) meter.current.style.width = `${Math.min(100, Math.sqrt(micOutLevel()) * 100)}%`
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const cables = devices.outputs.filter((d) => isCableOut(d.label))
  const others = devices.outputs.filter((d) => !isCableOut(d.label))
  return (
    <>
      <div className="menu-label">Your microphone</div>
      <div className="menu-field">
        <select id="mic-out-mic" className="select grow" value={s.micId} onChange={(e) => setMicOut({ micId: e.target.value })}>
          <option value="">Windows default</option>
          {devices.mics.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microphone'}</option>
          ))}
        </select>
      </div>
      <div className="live-meter mic-out-meter" title="What the other app hears: your voice and the piano">
        <div ref={meter} />
      </div>
      <label className="menu-slider" title="Your voice, levelled so talking and singing come through strong">
        Voice
        <input id="mic-out-voice" className="range" type="range" min={0} max={2} step={0.01} value={s.voice} onChange={(e) => setMicOut({ voice: Number(e.target.value) })} />
      </label>
      <label className="menu-slider" title="Everything Keyfall plays: what you play on the keyboard and the song (the volume slider doesn't change this)">
        Piano
        <input id="mic-out-piano" className="range" type="range" min={0} max={2} step={0.01} value={s.piano} onChange={(e) => setMicOut({ piano: Number(e.target.value) })} />
      </label>
      <label className="menu-check">
        <input id="mic-out-mute" type="checkbox" checked={s.muted} onChange={(e) => setMicOut({ muted: e.target.checked })} />
        Mute my voice
        <span className="kbd">piano keeps going</span>
      </label>
      <label className="menu-check" title="Plays your voice on your own speakers or headphones, as the other app hears it (tuned, if autotune is on). It comes back a moment after you sing; untick it if that throws you off. Use headphones, or it feeds back into the mic.">
        <input
          id="mic-out-hear-voice"
          type="checkbox"
          checked={live ? liveMonitor : s.hearVoice}
          onChange={(e) => (live ? setLive({ monitor: e.target.checked }) : setMicOut({ hearVoice: e.target.checked }))}
        />
        Hear my voice
        {live && <span className="kbd">Studio</span>}
      </label>
      <label className="menu-check" title="Plays what Keyfall plays on your own speakers or headphones. Untick it and only the other app hears it.">
        <input id="mic-out-hear-piano" type="checkbox" checked={s.hearPiano} onChange={(e) => setMicOut({ hearPiano: e.target.checked })} />
        Hear the piano
      </label>
      <label className="menu-check" title="Chromium's noise suppression: takes out fans and hiss, can make singing sound thinner">
        <input id="mic-out-clean" type="checkbox" checked={s.clean} onChange={(e) => setMicOut({ clean: e.target.checked })} />
        Reduce background noise
      </label>
      <label className="menu-check" title={live ? 'Live autotune is on in Studio mode, so your voice goes out tuned' : 'Tunes your voice on its way out, with the same settings as live autotune in Studio mode'}>
        <input id="mic-out-tune" type="checkbox" checked={s.tune || live} disabled={live} onChange={(e) => setMicOut({ tune: e.target.checked })} />
        Autotune my voice
        {live && <span className="kbd">on in Studio</span>}
      </label>
      {(s.tune || live) && <TuneSettings />}
      <div className="menu-label">Send to</div>
      <div className="menu-field">
        <select id="mic-out-sink" className="select grow" value={s.sinkId} onChange={(e) => setMicOut({ sinkId: e.target.value })}>
          <option value="">{cables.length ? `Virtual cable (${short(cables[0].label)})` : 'Virtual cable (none found)'}</option>
          {cables.length > 1 && cables.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
          {others.length > 0 && (
            <optgroup label="Other outputs">
              {others.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
    </>
  )
}

/** Live autotune's settings, shared with Studio mode: changing them here changes them there too. */
function TuneSettings(): React.JSX.Element {
  const l = useStore((st) => st.live)
  const hasMelody = useStore((st) => st.song.tracks.some((t) => t.role === 'melody'))
  return (
    <>
      <div className="menu-field">
        <select id="mic-out-snap" className="select grow" title="What your voice is tuned to" value={l.snap} onChange={(e) => setLive({ snap: e.target.value as LiveSettings['snap'] })}>
          <option value="key">Tune to the key</option>
          <option value="chords">Tune to the chords I hold</option>
          <option value="song" disabled={!hasMelody}>Tune to the song’s melody</option>
        </select>
      </div>
      <label className="menu-slider" title="Natural keeps your vibrato and slides; Hard snaps flat to the note">
        Retune
        <input id="mic-out-speed" className="range" type="range" min={0} max={1} step={0.01} value={l.speed} onChange={(e) => setLive({ speed: Number(e.target.value) })} />
      </label>
      <label className="menu-slider" title="Moves your voice up or down, in semitones">
        Pitch
        <input id="mic-out-pitch" className="range" type="range" min={-12} max={12} step={1} value={l.transpose} onChange={(e) => setLive({ transpose: Number(e.target.value) })} />
        <span className="meta num-out">{l.transpose > 0 ? '+' : ''}{l.transpose} st</span>
      </label>
      <label className="menu-slider" title="Formant: deeper ↔ airier, without changing the pitch">
        Tone
        <input id="mic-out-tone" className="range" type="range" min={-4} max={4} step={0.25} value={l.formant} onChange={(e) => setLive({ formant: Number(e.target.value) })} />
      </label>
      <div className="menu-field">
        <select
          id="mic-out-preset"
          className="select grow"
          title="The vocal effect"
          value={l.preset}
          onChange={(e) => {
            // the sounds that bring their own tuning set it too
            const preset = e.target.value as LiveSettings['preset']
            setLive({ preset, ...PRESET_TUNING[preset] })
          }}
        >
          {VOCAL_PRESETS.map((p) => (
            <option key={p.id} value={p.id} title={p.hint}>{p.name}</option>
          ))}
        </select>
      </div>
      <label className="menu-slider" title="How much of the effect">
        Amount
        <input id="mic-out-amount" className="range" type="range" min={0} max={1} step={0.01} value={l.amount} onChange={(e) => setLive({ amount: Number(e.target.value) })} />
      </label>
    </>
  )
}

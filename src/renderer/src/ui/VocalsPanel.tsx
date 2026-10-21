import { useEffect, useRef, useState } from 'react'
import { engine } from '../audio/engine'
import { listMics, micLevel, openMic, setShowPitch } from '../audio/vocalRecorder'
import { tuningCount } from '../audio/vocals'
import { recordVocals } from '../actions/transport'
import { isSongLine, PRESET_TUNING, tuneMode, VOCAL_PRESETS, type AudioTrack, type GuideVoice, type VocalPreset } from '../model/audio'
import { songKey } from '../model/guide'
import { keyName } from '../model/harmony'
import { tempoMap, ticksPerBar, ticksPerBeat, type Song } from '../model/song'
import { setSongKey } from '../state/edit'
import { savePref } from '../state/prefs'
import { getState, useStore } from '../state/store'
import { addAudioTrack, clearNoteEdits, deleteClip, harmonyTracks, nudgeClip, removeAudioTrack, splitClipAt, updateAudioTrack, updateClip, voiceName } from '../state/vocalEdit'
import { Choice, Field, Slider } from './controls'
import * as I from './icons'
import { TrackExportButton } from './TrackExport'

const NOTE = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

/** Lines a voice can follow: the song's own melody and harmonies when a reference has them, then chord tones. */
function availableVoices(song: Song): GuideVoice[] {
  const has = (role: string): boolean => song.tracks.some((t) => t.role === role)
  return [
    ...(has('melody') ? ['melody' as const] : []),
    ...(has('harmony-above') ? ['above' as const] : []),
    ...(has('harmony-below') ? ['below' as const] : []),
    'root',
    'third',
    'fifth',
    'octave'
  ]
}
const REGISTERS = [
  { value: 50, label: 'Low' },
  { value: 57, label: 'Mid' },
  { value: 65, label: 'High' }
]

function MicSection(): React.JSX.Element {
  const micId = useStore((s) => s.micId)
  const latencyMs = useStore((s) => s.latencyMs)
  const showPitch = useStore((s) => s.showPitch)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [open, setOpen] = useState(false)
  const meter = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void listMics().then(setMics).catch(() => setMics([]))
  }, [open])
  useEffect(() => {
    if (!open) return
    let raf = 0
    const loop = (): void => {
      if (meter.current) meter.current.style.width = `${Math.min(100, Math.sqrt(micLevel()) * 100)}%`
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [open])

  const check = async (id = micId): Promise<void> => {
    try {
      await openMic(id)
      setOpen(true)
    } catch (err) {
      getState().notify(`Couldn't open the microphone. ${err instanceof Error ? err.message : ''}`, 'error')
    }
  }
  return (
    <section className="psection">
      <div className="ptitle">Microphone</div>
      <Field label="Input">
        <select
          id="mic-select"
          className="select grow"
          value={micId}
          onChange={(e) => {
            getState().set({ micId: e.target.value })
            savePref('micId', e.target.value)
            void check(e.target.value)
          }}
        >
          <option value="">Default microphone</option>
          {mics.filter((m) => m.deviceId && m.deviceId !== 'default').map((m) => (
            <option key={m.deviceId} value={m.deviceId}>{m.label || 'Microphone'}</option>
          ))}
        </select>
      </Field>
      <Field label="Level">
        {open ? (
          <div className="meter" title="Aim for the bar to reach about two thirds when you sing">
            <div ref={meter} />
          </div>
        ) : (
          <button className="btn" onClick={() => void check()}>Check level</button>
        )}
      </Field>
      <label className="check">
        <input id="show-pitch" type="checkbox" checked={showPitch} onChange={(e) => void setShowPitch(e.target.checked)} /> Show my pitch on the keys
      </label>
      <Field label="Timing">
        <Slider id="latency" value={latencyMs} min={-100} max={200} step={1} title="Shifts recorded takes earlier if they land late (raise it) or later if early (lower it)" onChange={(v) => {
          getState().set({ latencyMs: v })
          savePref('latencyMs', v)
        }} />
        <span className="meta num-out">{latencyMs > 0 ? '+' : ''}{latencyMs} ms</span>
      </Field>
    </section>
  )
}

function bar(tick: number): string {
  const song = getState().song
  const b = ticksPerBar(song)
  return `${Math.floor(tick / b) + 1}.${Math.floor((tick % b) / ticksPerBeat(song)) + 1}`
}

function TrackEditor({ t }: { t: AudioTrack }): React.JSX.Element {
  const recording = useStore((s) => s.vocalRec)
  const song = useStore((s) => s.song)
  const key = songKey(song)
  const setKey = song.key
  const [guideTone, setGuideTone] = useState(true)
  const set = (patch: Partial<AudioTrack>): void => updateAudioTrack(t.id, patch)
  const tune = (patch: Partial<AudioTrack['tune']>): void => set({ tune: { ...t.tune, ...patch } })
  // some sounds are as much the tuning as the effect, and bring their own (switching tuning on)
  const choosePreset = (preset: VocalPreset): void => {
    const own = PRESET_TUNING[preset]
    if (!own) return set({ preset })
    set({ preset, amount: own.amount, tune: { ...t.tune, speed: own.speed, mode: t.tune.mode === 'off' ? 'key' : t.tune.mode } })
  }
  const recThis = recording?.kind === 'take' && recording.trackIds[0] === t.id
  const mode = tuneMode(t.tune)
  const songLines = availableVoices(song).filter(isSongLine)
  const chordVoices = availableVoices(song).filter((v) => !isSongLine(v))
  const setMode = (m: AudioTrack['tune']['mode']): void => {
    if (m === 'reference') tune({ mode: m, voice: isSongLine(t.tune.voice) ? t.tune.voice : 'melody' })
    else if (m === 'guide') tune({ mode: m, voice: isSongLine(t.tune.voice) ? 'root' : t.tune.voice })
    else tune({ mode: m })
  }
  const pitchEdit = useStore((s) => s.pitchEdit)
  const handEdits = t.clips.some((c) => c.edits && Object.keys(c.edits).length)

  return (
    <>
      <section className="psection">
        <div className="vtrack-head">
          <i style={{ background: t.color }} />
          <input id={`vname-${t.id}`} className="track-name" value={t.name} aria-label="Vocal track name" onChange={(e) => set({ name: e.target.value })} />
          <button className={`ms${t.muted ? ' on mute' : ''}`} title="Mute" onClick={() => set({ muted: !t.muted })}>M</button>
          <button className={`ms${t.solo ? ' on solo' : ''}`} title="Solo" onClick={() => set({ solo: !t.solo })}>S</button>
          <TrackExportButton track={{ kind: 'audio', id: t.id }} name={t.name} />
          <button className="icon-btn small" title="Delete this vocal track (undo with Ctrl+Z)" onClick={() => removeAudioTrack(t.id)}><I.IconTrash size={15} /></button>
        </div>
        <button
          className={`btn rec-take${recThis ? ' on' : ''}`}
          disabled={!!recording && !recThis}
          onClick={() =>
            void recordVocals({
              kind: 'take',
              trackIds: [t.id],
              guide: (mode === 'guide' || mode === 'reference') && guideTone ? { voice: t.tune.voice, centre: t.tune.centre } : undefined
            })
          }
        >
          <span className="dot" /> {recThis ? 'Stop recording' : 'Record a take'}
        </button>
        <p className="drawer-hint tight">
          Counts in, then records until you stop (Space). With a loop on, each pass becomes another take.
        </p>
      </section>

      <section className="psection">
        <div className="ptitle">Autotune</div>
        <Field label="Mode">
          <Choice
            label="Autotune mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'key', label: 'Key', title: 'Snaps each note to the nearest note in the song’s key' },
              { value: 'guide', label: 'Chords', title: 'Aims each note at one note of the chord playing (root, third, fifth or octave)' },
              {
                value: 'reference',
                label: 'Song',
                title: songLines.length ? 'Aims each note at what the singer of the reference song sang' : 'Open a song in the Reference tab and separate its vocals first',
                disabled: !songLines.length
              }
            ]}
          />
        </Field>
        <p className="drawer-hint tight mode-hint">
          {mode === 'off' && 'Your voice as you sang it (hand edits still apply).'}
          {mode === 'key' && 'Each note you sing goes to the nearest note of the song’s key.'}
          {mode === 'guide' && 'Each note you sing goes to a note of the chord playing under it.'}
          {mode === 'reference' && 'Each note you sing goes to the note the song’s singer sang there, from the separated vocals (fix any wrong ones in the Melody (to sing) track).'}
        </p>
        {mode === 'key' && (
          <Field label="Key">
            <select
              id="song-key"
              className="select grow"
              value={setKey ? `${setKey.tonic}${setKey.minor ? 'm' : ''}` : 'auto'}
              onChange={(e) => {
                const v = e.target.value
                setSongKey(v === 'auto' ? null : { tonic: parseInt(v, 10), minor: v.endsWith('m') })
              }}
            >
              <option value="auto">{`Detect from the notes${!setKey && key ? ` (${keyName(key)})` : ''}`}</option>
              {NOTE.flatMap((n, i) => [
                <option key={`${i}`} value={`${i}`}>{`${n} major`}</option>,
                <option key={`${i}m`} value={`${i}m`}>{`${n} minor`}</option>
              ])}
            </select>
          </Field>
        )}
        {mode === 'reference' && songLines.length > 1 && (
          <Field label="Follow">
            <Choice
              label="Song line"
              value={t.tune.voice}
              onChange={(voice: GuideVoice) => tune({ voice })}
              options={songLines.map((v) => ({ value: v, label: v === 'melody' ? 'Melody' : v === 'above' ? 'Harmony above' : 'Harmony below' }))}
            />
          </Field>
        )}
        {mode === 'guide' && (
          <>
            <Field label="Sing the">
              <Choice
                label="Chord note"
                value={t.tune.voice}
                onChange={(voice: GuideVoice) => tune({ voice })}
                options={chordVoices.map((v) => ({
                  value: v,
                  label: voiceName(v)
                }))}
              />
            </Field>
            <Field label="Register">
              <Choice label="Register" value={t.tune.centre} onChange={(centre) => tune({ centre })} options={REGISTERS} />
            </Field>
          </>
        )}
        {(mode === 'guide' || mode === 'reference') && (
          <>
            <Field label="Guide tone">
              <label className="check">
                <input id={`guide-${t.id}`} type="checkbox" checked={guideTone} onChange={(e) => setGuideTone(e.target.checked)} /> Play the note while recording (headphones)
              </label>
            </Field>
          </>
        )}
        {mode !== 'off' && (
          <Field label="Retune">
            <span className="meta">Natural</span>
            <Slider id={`speed-${t.id}`} value={t.tune.speed} min={0} max={1} title="Natural centres each note and keeps your vibrato and slides; Hard snaps straight to the note and holds it flat" onChange={(speed) => tune({ speed })} />
            <span className="meta">Hard</span>
          </Field>
        )}
        <div className="pitch-edit-row">
          <button
            className={`btn${pitchEdit ? ' on' : ''}`}
            disabled={!t.clips.length}
            title="Shows each sung note as a bar over the keys: drag one sideways to move it (Alt bends it freely), double-click to put it back"
            onClick={() => getState().set({ pitchEdit: !pitchEdit, activeAudioId: t.id })}
          >
            {pitchEdit ? 'Done editing pitch' : 'Edit pitch on the stage'}
          </button>
          {handEdits && (
            <button className="btn small-btn" title="Hand every note of this track back to autotune" onClick={() => clearNoteEdits(t.id)}>
              Reset hand edits
            </button>
          )}
        </div>
      </section>

      <section className="psection">
        <div className="ptitle">Voice character</div>
        <Field label="Tone">
          <span className="meta">Deeper</span>
          <Slider id={`formant-${t.id}`} value={t.formant} min={-4} max={4} step={0.25} title="Moves the voice’s tone without changing its pitch" onChange={(formant) => set({ formant })} />
          <span className="meta">Airier</span>
        </Field>
        <Field label="Pitch">
          <Slider id={`transpose-${t.id}`} value={t.transpose} min={-12} max={12} step={1} onChange={(transpose) => set({ transpose })} />
          <span className="meta num-out">{t.transpose > 0 ? '+' : ''}{t.transpose} st</span>
        </Field>
        <Field label="Detune">
          <Slider id={`detune-${t.id}`} value={t.detune} min={-25} max={25} step={1} title="A few cents off keeps stacked voices from sounding pasted" onChange={(detune) => set({ detune })} />
          <span className="meta num-out">{t.detune > 0 ? '+' : ''}{t.detune} ¢</span>
        </Field>
      </section>

      <section className="psection">
        <div className="ptitle">Effect</div>
        <div className="preset-grid">
          {VOCAL_PRESETS.map((p) => (
            <button key={p.id} className={`preset${t.preset === p.id ? ' on' : ''}`} title={p.hint} onClick={() => choosePreset(p.id)}>
              {p.name}
            </button>
          ))}
        </div>
        <Field label="Amount">
          <Slider id={`amount-${t.id}`} value={t.amount} min={0} max={1} onChange={(amount) => set({ amount })} />
          <span className="meta num-out">{Math.round(t.amount * 100)}</span>
        </Field>
      </section>

      <section className="psection">
        <div className="ptitle">
          Clips
          <button
            className="btn small-btn"
            title="Cut the clip under the playhead in two, so each half can use a different take"
            onClick={() => {
              const song = getState().song
              const tick = Math.round(tempoMap(song).secToTick(engine.time()))
              const c = t.clips.find((x) => {
                const s = tempoMap(song).tickToSec(x.tick)
                return engine.time() > s && engine.time() < s + x.duration
              })
              if (!c || !splitClipAt(t.id, c.id, tick)) getState().notify('Put the playhead inside a clip to split it.')
            }}
          >
            Split at playhead
          </button>
        </div>
        {t.clips.length === 0 && <p className="drawer-hint tight">Nothing recorded on this track yet.</p>}
        <ul className="clip-list">
          {t.clips.map((c) => (
            <li key={c.id} className="clip">
              <button className="clip-go" title="Jump to this clip" onClick={() => engine.seek(tempoMap(getState().song).tickToSec(c.tick))}>
                Bar {bar(c.tick)}
              </button>
              <span className="meta">{c.duration.toFixed(1)} s</span>
              <span className="nudge" title="Move this clip a little earlier or later, to line it up by ear">
                <button className="icon-btn small" onClick={() => nudgeClip(t.id, c.id, -10)}>−10 ms</button>
                <button className="icon-btn small" onClick={() => nudgeClip(t.id, c.id, 10)}>+10 ms</button>
              </span>
              <span className="takes" title="Which take plays">
                <button className="icon-btn small" disabled={c.active === 0} onClick={() => updateClip(t.id, c.id, { active: c.active - 1 })}>‹</button>
                <span className="meta">Take {c.active + 1}/{c.takes.length}</span>
                <button className="icon-btn small" disabled={c.active >= c.takes.length - 1} onClick={() => updateClip(t.id, c.id, { active: c.active + 1 })}>›</button>
              </span>
              <button className="icon-btn small" title="Delete clip" onClick={() => deleteClip(t.id, c.id)}><I.IconClose size={14} /></button>
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}

function HarmonySection(): React.JSX.Element {
  const recording = useStore((s) => s.vocalRec)
  const guideVolume = useStore((s) => s.guideVolume)
  const [voices, setVoices] = useState<GuideVoice[]>(['root', 'third', 'fifth'])
  const [centre, setCentre] = useState(57)
  const toggle = (v: GuideVoice): void => setVoices((vs) => (vs.includes(v) ? vs.filter((x) => x !== v) : [...vs, v]))
  const song = useStore((s) => s.song)
  const order = availableVoices(song).filter((v) => v !== 'melody')
  const busy = recording?.kind === 'harmony'
  return (
    <section className="psection harmony">
      <div className="ptitle">Harmony stack</div>
      <p className="drawer-hint tight">
        Records one voice per loop pass, each on its own track. A soft guide tone plays that voice’s note from the piano’s chords, so you can hum on key. Use headphones.
      </p>
      <Field label="Voices">
        <div className="checks">
          {order.map((v) => (
            <label key={v} className="check">
              <input id={`hv-${v}`} type="checkbox" checked={voices.includes(v)} onChange={() => toggle(v)} /> {voiceName(v)}
            </label>
          ))}
        </div>
      </Field>
      <Field label="Register">
        <Choice label="Harmony register" value={centre} onChange={setCentre} options={REGISTERS} />
      </Field>
      <Field label="Guide">
        <Slider id="guide-vol" value={guideVolume} min={0} max={1} title="Guide tone volume" onChange={(v) => {
          getState().set({ guideVolume: v })
          savePref('guideVolume', v)
        }} />
      </Field>
      {busy && recording.voices && (
        <div className="harmony-now">
          Recording <strong>{voiceName(recording.voices[recording.pass])}</strong> · voice {recording.pass + 1} of {recording.voices.length}
        </div>
      )}
      <button
        className={`btn rec-take${busy ? ' on' : ''}`}
        disabled={(!busy && (!voices.length || !!recording))}
        onClick={() => {
          if (busy) return void recordVocals({ kind: 'harmony', trackIds: [] })
          const chosen = order.filter((v) => voices.includes(v))
          const ids = harmonyTracks(chosen, centre)
          void recordVocals({ kind: 'harmony', trackIds: ids, voices: chosen, centre })
        }}
      >
        <span className="dot" /> {busy ? 'Stop' : `Record ${voices.length} harmon${voices.length === 1 ? 'y' : 'ies'}`}
      </button>
    </section>
  )
}

/** The Vocals tab: microphone, vocal tracks, autotune, voice, effects, takes and harmony stacks. */
export function VocalsPanel(): React.JSX.Element {
  const tracks = useStore((s) => s.song.audioTracks)
  const activeId = useStore((s) => s.activeAudioId)
  useStore((s) => s.vocalVersion)
  const active = tracks.find((t) => t.id === activeId) ?? tracks[0]
  const tuning = tuningCount()
  return (
    <>
      <MicSection />
      <section className="psection">
        <div className="ptitle">
          Vocal tracks
          {tuning > 0 && <span className="meta">tuning {tuning}…</span>}
        </div>
        <div className="vtrack-chips">
          {tracks.map((t) => (
            <button key={t.id} className={`vchip${t.id === active?.id ? ' on' : ''}`} onClick={() => getState().set({ activeAudioId: t.id })}>
              <i style={{ background: t.color }} /> {t.name}
            </button>
          ))}
          <button className="vchip add" onClick={() => addAudioTrack(tracks.length ? `Vocals ${tracks.length + 1}` : 'Vocals')}>
            <I.IconPlus size={14} /> New
          </button>
        </div>
      </section>
      {active ? <TrackEditor key={active.id} t={active} /> : <p className="drawer-hint">Add a vocal track to start recording.</p>}
      <HarmonySection />
    </>
  )
}

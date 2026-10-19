import { useState } from 'react'
import { beatboxAudio, beatboxDrums, beatboxSnap, convertBeatbox, recordBeatbox, type BeatboxSnap } from '../actions/beatbox'
import { DRUM_LANES, emptyPattern, stepsPerBar, type Beat, type Pattern } from '../model/beat'
import { starterPattern, STYLES } from '../model/beatgen'
import { newId } from '../model/song'
import { beatTrackId, generateDrums, setBeat } from '../state/arrange'
import { setTempo } from '../state/edit'
import { getState, useStore } from '../state/store'
import { Choice, Field, Slider } from './controls'
import * as I from './icons'
import { KitChoice } from './SoundPicker'

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

const SNAPS: { value: BeatboxSnap; label: string; title: string }[] = [
  { value: '1/8', label: '1/8', title: 'Every hit moves to the nearest eighth note' },
  { value: '1/16', label: '1/16', title: 'Every hit moves to the nearest sixteenth note' },
  { value: '1/16T', label: '1/16T', title: 'Sixteenth-note triplets, for a swung or triplet feel' },
  { value: 'off', label: 'Off', title: 'Every hit stays exactly where you made it' }
]

/** Beatboxing a beat into the mic over the song, turned into a drum track. */
function BeatboxSection(): React.JSX.Element {
  const song = useStore((s) => s.song)
  const rec = useStore((s) => s.vocalRec)
  const [snap, setSnap] = useState(beatboxSnap)
  const recording = rec?.kind === 'beatbox'
  const take = beatboxAudio(song)
  const drums = beatboxDrums(song)
  return (
    <section className="psection">
      <div className="ptitle">Beatbox a beat</div>
      <p className="drawer-hint tight">
        Beatbox along to the song into the mic and it becomes a drum track: low sounds (“b”, “boom”) play the kick, “pf”, “k” or “psh” the snare, and “ts”/“t” the hi-hat (hold a “tsss” for an open hat). Use headphones, so the mic hears only you. With a loop on, each pass is another take.
      </p>
      <button className={`btn rec-take${recording ? ' on' : ''}`} disabled={!!rec && !recording} onClick={recordBeatbox}>
        <span className="dot" /> {recording ? 'Stop and make the drums' : take?.clips.length ? 'Record another beatbox' : 'Record a beatbox'}
      </button>
      <Field label="Snap to">
        <Choice
          label="Snap beatbox hits to"
          value={snap}
          options={SNAPS}
          onChange={(v) => {
            setSnap(v)
            if (take?.clips.length) void convertBeatbox(v)
          }}
        />
      </Field>
      {drums && (
        <Field label="Kit">
          <KitChoice track={drums} />
        </Field>
      )}
      {take?.clips.length ? (
        <>
          <p className="drawer-hint tight">
            Recording again or changing the snap rebuilds the <em>Beatbox drums</em> track from the take playing in each clip. Picked another take in the Vocals tab? Rebuild it.
          </p>
          <div className="prow-buttons">
            <button className="btn" onClick={() => void convertBeatbox(snap)}>Rebuild the drums</button>
          </div>
        </>
      ) : null}
    </section>
  )
}

/** The Beat tab: generate a drum part in a style, then edit its patterns and which bar plays which. */
export function BeatPanel(): React.JSX.Element {
  const song = useStore((s) => s.song)
  const track = song.tracks.find((t) => t.beat)
  const beat = track?.beat
  const selected = useStore((s) => s.beatPattern)
  const bpm = Math.round(song.tempos[0]?.bpm ?? 120)
  const [styleId, setStyleId] = useState(beat?.style ?? 'lofi')
  const [tempo, setTempoText] = useState(String(bpm))
  const pattern = beat?.patterns.find((p) => p.id === selected) ?? beat?.patterns[0]
  const steps = stepsPerBar(song)

  const update = (fn: (b: Beat) => Beat): void => {
    const id = track?.id ?? beatTrackId()
    const cur = getState().song.tracks.find((t) => t.id === id)?.beat ?? { patterns: [], bars: [], swing: 0 }
    setBeat(id, fn(cur))
  }

  const generate = (): void => {
    const v = parseFloat(tempo)
    if (Number.isFinite(v) && Math.round(v) !== bpm) setTempo(v)
    generateDrums(styleId, Math.floor(Math.random() * 1e9))
    getState().notify(`Generated a ${STYLES.find((s) => s.id === styleId)?.name.toLowerCase()} beat that follows your music. Try another for a new variation.`)
  }

  const toggleStep = (p: Pattern, pitch: number, s: number, soft: boolean): void =>
    update((b) => ({
      ...b,
      patterns: b.patterns.map((x) => {
        if (x.id !== p.id) return x
        const row = [...(x.hits[pitch] ?? new Array(steps).fill(0))]
        row[s] = row[s] ? 0 : soft ? 55 : 100
        return { ...x, hits: { ...x.hits, [pitch]: row } }
      })
    }))

  const addPattern = (make: () => Pattern): void => {
    const p = make()
    update((b) => ({ ...b, patterns: [...b.patterns, p], bars: b.bars.length ? b.bars : new Array(4).fill(p.id) }))
    getState().set({ beatPattern: p.id })
  }

  return (
    <>
      <BeatboxSection />
      <section className="psection">
        <div className="ptitle">Generate a beat</div>
        <p className="drawer-hint tight">Writes an original drum part that fits what you’ve played: kicks follow your bass notes, hats follow how busy the piano is, with fills every four bars.</p>
        <Field label="Style">
          <select
            id="beat-style"
            className="select grow"
            value={styleId}
            onChange={(e) => {
              setStyleId(e.target.value)
              const st = STYLES.find((s) => s.id === e.target.value)
              // suggest the style's usual tempo only for an empty song
              if (st && !song.tracks.some((t) => !t.beat && t.notes.length)) setTempoText(String(st.bpm))
            }}
          >
            {STYLES.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Tempo">
          <input id="beat-bpm" className="num" value={tempo} onChange={(e) => setTempoText(e.target.value)} />
          <span className="meta">BPM · song is {bpm}</span>
        </Field>
        <div className="prow-buttons">
          <button className="btn primary" onClick={generate}>{beat?.patterns.length ? 'Try another' : 'Generate'}</button>
        </div>
      </section>

      {beat && (
        <>
          <section className="psection">
            <div className="ptitle">Feel</div>
            <Field label="Swing">
              <Slider id="beat-swing" value={beat.swing} min={0} max={0.6} onChange={(swing) => update((b) => ({ ...b, swing }))} />
              <span className="meta num-out">{Math.round(beat.swing * 100)}%</span>
            </Field>
          </section>

          <section className="psection">
            <div className="ptitle">Patterns</div>
            <div className="vtrack-chips">
              {beat.patterns.map((p, i) => (
                <button key={p.id} className={`vchip${p.id === pattern?.id ? ' on' : ''}`} title={p.name} onClick={() => getState().set({ beatPattern: p.id })}>
                  <b>{LETTERS[i] ?? i + 1}</b> {p.name}
                </button>
              ))}
              <button className="vchip add" onClick={() => addPattern(() => emptyPattern(song, `Pattern ${beat.patterns.length + 1}`))}>
                <I.IconPlus size={14} /> Empty
              </button>
              {pattern && (
                <button className="vchip add" onClick={() => addPattern(() => ({ ...pattern, id: newId(), name: `${pattern.name} copy`, hits: structuredClone(pattern.hits) }))}>
                  Duplicate
                </button>
              )}
            </div>
            <Field label="Starter">
              <select
                id="beat-starter"
                className="select grow"
                value=""
                onChange={(e) => e.target.value && addPattern(() => starterPattern(song, e.target.value, Math.floor(Math.random() * 1e9)))}
              >
                <option value="">Add a starter pattern…</option>
                {STYLES.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </Field>
            {pattern && (
              <div className="grid" style={{ ['--steps' as string]: steps }}>
                {DRUM_LANES.map((l) => (
                  <div key={l.pitch} className="grid-row">
                    <span className="grid-label">{l.name}</span>
                    {Array.from({ length: steps }, (_, s) => {
                      const v = pattern.hits[l.pitch]?.[s] ?? 0
                      return (
                        <button
                          key={s}
                          className={`cell${v ? ' on' : ''}${s % 4 === 0 ? ' beat' : ''}`}
                          style={v ? { opacity: 0.35 + (0.65 * v) / 127 } : undefined}
                          title={`${l.name}, step ${s + 1}${v ? ` · velocity ${v}` : ''}. Shift+click adds a soft hit.`}
                          onClick={(e) => toggleStep(pattern, l.pitch, s, e.shiftKey)}
                        />
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="psection">
            <div className="ptitle">
              Bars
              <button className="btn small-btn" onClick={() => update((b) => ({ ...b, bars: [...b.bars, ...new Array(4).fill(pattern?.id ?? null)] }))}>+4 bars</button>
            </div>
            <p className="drawer-hint tight">Click a bar to give it the selected pattern; right-click to silence it.</p>
            <div className="bars">
              {beat.bars.map((pid, b) => {
                const i = beat.patterns.findIndex((p) => p.id === pid)
                return (
                  <button
                    key={b}
                    className={`barcell${pid === pattern?.id ? ' on' : ''}${pid === null ? ' empty' : ''}`}
                    title={`Bar ${b + 1}: ${i >= 0 ? beat.patterns[i].name : 'silent'}`}
                    onClick={() => pattern && update((x) => ({ ...x, bars: x.bars.map((v, k) => (k === b ? pattern.id : v)) }))}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      update((x) => ({ ...x, bars: x.bars.map((v, k) => (k === b ? null : v)) }))
                    }}
                  >
                    {i >= 0 ? (LETTERS[i] ?? i + 1) : '·'}
                  </button>
                )
              })}
            </div>
          </section>
        </>
      )}
    </>
  )
}

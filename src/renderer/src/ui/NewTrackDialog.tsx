import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { BUILTIN_FONT, fontName, type FontPreset } from '../audio/fontSlots'
import { COMPLEXITY, GEN_GENRES, GEN_PARTS, guessGenre, songSpan, type GenGenre, type GenPart, type PartInfo } from '../model/trackgen'
import { addTrack } from '../state/edit'
import { addGeneratedTrack, newSeed } from '../state/generate'
import { getState, useStore } from '../state/store'
import { Choice, Field } from './controls'
import * as I from './icons'
import { designFonts, presetsOf } from './SoundPicker'

/**
 * Adding a track: an empty one to fill yourself, or a part Keyfall writes to fit the song's chords,
 * with its sound, part, genre and how adventurous it is picked first.
 */

const useNewTrack = create<{ open: boolean }>()(() => ({ open: false }))

export function openNewTrack(): void {
  useNewTrack.setState({ open: true })
}

const close = (): void => useNewTrack.setState({ open: false })

/** The preset a part should start on: its General MIDI instrument, else one named like it, else the first instrument. */
function suggest(list: FontPreset[], part: PartInfo): FontPreset | undefined {
  const tunes = list.filter((p) => !p.drum)
  return tunes.find((p) => p.bank === 0 && p.program === part.program) ?? tunes.find((p) => part.match.test(p.name)) ?? tunes[0]
}

const presetKey = (p: { bank: number; program: number }): string => `${p.bank}:${p.program}`

export function NewTrackDialog(): React.JSX.Element | null {
  const open = useNewTrack((s) => s.open)
  const library = useStore((s) => s.sfLibrary)
  const sfName = useStore((s) => s.sfName)
  const mainPresets = useStore((s) => s.sfPresets)
  const loop = useStore((s) => s.loop)
  const [step, setStep] = useState<'choose' | 'generate'>('choose')
  const [part, setPart] = useState<GenPart>('strings')
  const [genre, setGenre] = useState<GenGenre>('trap')
  const [complexity, setComplexity] = useState(2)
  const [font, setFont] = useState('')
  const [preset, setPreset] = useState('')
  const [where, setWhere] = useState<'song' | 'loop'>('song')
  const [pedal, setPedal] = useState(false)
  const [design, setDesign] = useState<string[]>([])
  const [other, setOther] = useState<FontPreset[] | null>(null)

  useEffect(() => {
    if (!open) return
    setStep('choose')
    setGenre(guessGenre(getState().song))
    setWhere('song')
    void designFonts().then(setDesign)
  }, [open])

  // the presets of the soundfont picked: the main one's are already known
  useEffect(() => {
    if (!font) return setOther(null)
    let live = true
    setOther(null)
    void presetsOf(font).then((l) => live && setOther(l))
    return () => {
      live = false
    }
  }, [font])
  const list: FontPreset[] | null = font ? other : mainPresets
  const info = GEN_PARTS.find((p) => p.id === part)!
  // each part starts with the pedal as suits it: down for parts of short notes
  useEffect(() => setPedal(info.pedal), [part])
  // a new part or soundfont starts on the instrument that suits the part
  useEffect(() => {
    if (!list) return
    const s = suggest(list, info)
    setPreset(s ? presetKey(s) : `0:${info.program}`)
  }, [part, list])

  const create = (): void => {
    const span = where === 'loop' && loop ? { from: loop.start, to: loop.end } : songSpan(getState().song)
    const [bank, program] = preset.split(':').map(Number)
    const gen = { part, genre, complexity, seed: newSeed(), ...span, pedal: pedal && part !== 'risers' }
    if (addGeneratedTrack(gen, { bank, program, font: font || undefined })) close()
  }

  useEffect(() => {
    if (!open) return
    // the dialog has the keyboard: nothing reaches the stage's shortcuts underneath
    const onKey = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement | null)?.tagName === 'SELECT') return
      e.stopImmediatePropagation()
      if (e.key === 'Escape') close()
      else if (e.key === 'Enter' && step === 'generate') {
        e.preventDefault()
        create()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  if (!open) return null
  const fonts = [...new Set([...design, ...library.map((e) => e.path), BUILTIN_FONT])].filter((p) => !/\.dls$/i.test(p))
  const tunes = (list ?? []).filter((p) => !p.drum)
  return (
    <div className="busy-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="vdialog import new-track" role="dialog" aria-label="Add a track">
        <div className="vhead">
          <h2>{step === 'choose' ? 'Add a track' : 'Generate a part'}</h2>
          <button className="icon-btn" title="Cancel (Esc)" onClick={close}><I.IconClose size={16} /></button>
        </div>
        {step === 'choose' ? (
          <div className="import-body new-track-choose">
            <button
              id="new-track-empty"
              className="new-track-card"
              onClick={() => {
                addTrack()
                close()
              }}
            >
              <strong>Empty track</strong>
              <span className="meta">Draw, record or paste your own notes.</span>
            </button>
            <button id="new-track-generate" className="new-track-card" onClick={() => setStep('generate')}>
              <strong>Generated part</strong>
              <span className="meta">Keyfall writes a part that fits your song’s chords: strings, a violin line, bells, risers and more.</span>
            </button>
          </div>
        ) : (
          <div className="import-body">
            <h3>Part</h3>
            <div className="preset-grid gen-parts">
              {GEN_PARTS.map((p) => (
                <button key={p.id} id={`gen-part-${p.id}`} className={`preset${part === p.id ? ' on' : ''}`} title={p.hint} onClick={() => setPart(p.id)}>
                  {p.name}
                </button>
              ))}
            </div>
            <p className="drawer-hint tight">{info.hint}.</p>
            <h3>Feel</h3>
            <Field label="Genre">
              <select id="gen-genre" className="select grow" value={genre} onChange={(e) => setGenre(e.target.value as GenGenre)}>
                {GEN_GENRES.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Complexity">
              <Choice label="Complexity" value={complexity} onChange={setComplexity} options={COMPLEXITY.map((c, i) => ({ value: i + 1, label: c.label, title: c.hint }))} />
            </Field>
            <p className="drawer-hint tight">{COMPLEXITY[complexity - 1].hint}.</p>
            {part !== 'risers' && (
              <Field label="Pedal">
                <label className="check" title="Holds the sustain pedal under each chord, changing it with the chords, so notes ring into each other instead of stopping dead">
                  <input id="gen-pedal" type="checkbox" checked={pedal} onChange={(e) => setPedal(e.target.checked)} /> Sustain pedal
                </label>
              </Field>
            )}
            <h3>Sound</h3>
            <Field label="Soundfont">
              <select id="gen-font" className="select grow" value={font} onChange={(e) => setFont(e.target.value)}>
                <option value="">{`Main soundfont${sfName ? ` (${sfName})` : ''}`}</option>
                {fonts.map((p) => (
                  <option key={p} value={p}>{fontName(p)}</option>
                ))}
              </select>
            </Field>
            <Field label="Instrument">
              <select id="gen-preset" className="select grow" value={preset} onChange={(e) => setPreset(e.target.value)} disabled={!list}>
                {!tunes.some((p) => presetKey(p) === preset) && <option value={preset}>{list ? `Program ${info.program + 1}` : 'Loading…'}</option>}
                {tunes.map((p) => (
                  <option key={presetKey(p)} value={presetKey(p)}>{p.name}</option>
                ))}
              </select>
            </Field>
            {loop && (
              <Field label="Where">
                <Choice
                  label="Where"
                  value={where}
                  onChange={setWhere}
                  options={[
                    { value: 'song', label: 'Whole song' },
                    { value: 'loop', label: 'The loop' }
                  ]}
                />
              </Field>
            )}
          </div>
        )}
        <div className="whats-new-foot">
          {step === 'generate' && <button className="btn" onClick={() => setStep('choose')}>Back</button>}
          <span className="grow" />
          <button className="btn" onClick={close}>Cancel</button>
          {step === 'generate' && (
            <button id="gen-create" className="btn primary" onClick={create}>Create</button>
          )}
        </div>
      </div>
    </div>
  )
}

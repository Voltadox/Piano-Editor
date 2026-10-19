import { useState } from 'react'
import { engine } from '../audio/engine'
import { addChordAt, importReference, keyLabel, referenceTrack, scaleTempo } from '../actions/reference'
import { setPlaybackRate } from '../actions/transport'
import { STYLES } from '../model/beatgen'
import { tempoMap } from '../model/song'
import { copyReferenceGroove, generateDrums } from '../state/arrange'
import { setSongKey, updateTrack } from '../state/edit'
import { getState, useStore } from '../state/store'
import { updateAudioTrack } from '../state/vocalEdit'
import { Choice, Field, Slider } from './controls'
import { findLyrics, listenTo, listening, separateReference, setLyric, type Listen } from '../actions/separate'
import { setShowPitch } from '../audio/vocalRecorder'
import { recordVocals } from '../actions/transport'
import type { GuideVoice } from '../model/audio'
import { harmonyTracks } from '../state/vocalEdit'
import { chooseSound, describe, remakeBacking } from '../actions/remake'
import { loadPref, savePref } from '../state/prefs'
import type { RemakePart, SoundChoice } from '../model/song'

const NOTE = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const SPEEDS = [1, 0.9, 0.8, 0.75, 0.7, 0.6, 0.5]

/** How near a sound came to the song's, in words. */
const closeness = (c: SoundChoice): string => (c.distance < 0.45 ? 'close' : c.distance < 0.75 ? 'fair' : 'rough')

/** Whether opening a song goes on to recreate its backing track. */
function RemakeOnOpen(): React.JSX.Element {
  const [on, setOn] = useState(() => loadPref('remakeOnOpen', false))
  return (
    <label className="check">
      <input
        id="ref-remake-on-open"
        type="checkbox"
        checked={on}
        onChange={(e) => {
          setOn(e.target.checked)
          savePref('remakeOnOpen', e.target.checked)
        }}
      />{' '}
      Recreate the backing track whenever I open a song
    </label>
  )
}

/** The Reference tab: bring in a finished song and build on what Keyfall hears in it. */
export function ReferencePanel(): React.JSX.Element {
  const song = useStore((s) => s.song)
  const rate = useStore((s) => s.rate)
  const ref = song.reference
  const track = referenceTrack(song)
  const pad = song.tracks.find((t) => t.role === 'chords')
  const melody = song.tracks.find((t) => t.role === 'melody')
  const harmonies = song.tracks.filter((t) => t.role === 'harmony-above' || t.role === 'harmony-below')
  const showPitch = useStore((s) => s.showPitch)
  const [style, setStyle] = useState('lofi')
  const bpm = song.tempos[0]?.bpm ?? 120
  const chordCount = song.chords.filter((c) => c.root >= 0).length
  const remade = song.tracks.filter((t) => t.remake)

  if (!ref || !track) {
    return (
      <section className="psection">
        <div className="ptitle">Bring in a song</div>
        <p className="drawer-hint tight">
          Open one of your demos (MP3, WAV, M4A…). Keyfall listens for its tempo, bar lines, key, chords, sections and drums, then lines the song up with it: chords
          appear on the left of the stage, and the beat, harmony guides and chord suggestions all follow it.
        </p>
        <button className="btn primary" onClick={() => void importReference()}>Open a song…</button>
        <RemakeOnOpen />
        <p className="drawer-hint tight">Steady songs work best. Takes a few seconds; chords and sections are suggestions you can change.</p>
      </section>
    )
  }

  return (
    <>
      <section className="psection">
        <div className="ptitle" title={ref.file}>{ref.file}</div>
        <Field label="Level">
          <Slider id="ref-vol" value={track.volume} min={0} max={1} onChange={(volume) => updateAudioTrack(track.id, { volume })} />
          <button className={`ms${track.muted ? ' on mute' : ''}`} title="Mute the reference" onClick={() => updateAudioTrack(track.id, { muted: !track.muted })}>M</button>
        </Field>
        <Field label="Tempo">
          <span className="num-out strong">{bpm.toFixed(1)} BPM{song.tempos.length > 1 ? '*' : ''}</span>
          <button className="btn small-btn" title="If bars are twice as long as they should be" onClick={() => scaleTempo(2)}>×2</button>
          <button className="btn small-btn" title="If bars are half as long as they should be" onClick={() => scaleTempo(0.5)}>÷2</button>
        </Field>
        {song.tempos.length > 1 && <p className="drawer-hint tight">* The song drifts a little, so the bar lines follow it bar by bar.</p>}
        <Field label="Key">
          <select
            id="ref-key"
            className="select grow"
            value={song.key ? `${song.key.tonic}${song.key.minor ? 'm' : ''}` : ''}
            onChange={(e) => {
              const v = e.target.value
              setSongKey({ tonic: parseInt(v, 10), minor: v.endsWith('m') })
            }}
          >
            {!song.key && <option value="">Unclear</option>}
            {NOTE.flatMap((_n, i) => [
              <option key={`${i}`} value={`${i}`}>{keyLabel(i, false)}</option>,
              <option key={`${i}m`} value={`${i}m`}>{keyLabel(i, true)}</option>
            ])}
          </select>
        </Field>
        <Field label="Practice">
          <select id="ref-speed" className="select grow" value={rate} onChange={(e) => void setPlaybackRate(Number(e.target.value))}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>{s === 1 ? 'Full speed' : `${Math.round(s * 100)}% speed (same pitch)`}</option>
            ))}
          </select>
        </Field>
      </section>

      <section className="psection">
        <div className="ptitle">Vocals</div>
        {!ref.stems ? (
          <>
            <p className="drawer-hint tight">
              Split the song into its vocals and instrumental. The sung notes then fall on the keys like the piano does, the instrumental can play on its own as a
              backing track, and you can see your pitch next to the song’s. The first time downloads the separator (67 MB); a three-minute song takes about a minute.
            </p>
            <div className="prow-buttons">
              <button className="btn primary" onClick={() => void separateReference()}>Separate the vocals</button>
            </div>
          </>
        ) : (
          <>
            <Field label="Listen to">
              <Choice
                label="Listen to"
                value={listening(song)}
                onChange={(v: Listen) => listenTo(v)}
                options={[
                  { value: 'song', label: 'Song' },
                  { value: 'instrumental', label: 'Instrumental' },
                  { value: 'vocals', label: 'Vocals' },
                  ...(remade.length ? [{ value: 'remake' as const, label: 'Remake' }] : [])
                ]}
              />
            </Field>
            {melody && (
              <label className="check">
                <input id="ref-show-melody" type="checkbox" checked={!melody.muted} onChange={(e) => updateTrack(melody.id, { muted: !e.target.checked })} /> Show the notes to sing ({melody.notes.length})
              </label>
            )}
            {harmonies.map((h) => (
              <label key={h.id} className="check">
                <input id={`ref-show-${h.role}`} type="checkbox" checked={!h.muted} onChange={(e) => updateTrack(h.id, { muted: !e.target.checked })} /> Show the {h.role === 'harmony-above' ? 'harmony above' : 'harmony below'} ({h.notes.length})
              </label>
            ))}
            <label className="check">
              <input id="ref-show-pitch" type="checkbox" checked={showPitch} onChange={(e) => void setShowPitch(e.target.checked)} /> Show my pitch on the keys
            </label>
            {harmonies.length > 0 ? (
              <div className="prow-buttons">
                <button
                  className="btn"
                  title="One loop pass per harmony line, with a guide tone playing each line's notes"
                  onClick={() => {
                    const voices = harmonies.map((h) => (h.role === 'harmony-above' ? 'above' : 'below') as GuideVoice)
                    void recordVocals({ kind: 'harmony', trackIds: harmonyTracks(voices, 57), voices, centre: 57 })
                  }}
                >
                  Record over the song’s harmonies
                </button>
              </div>
            ) : (
              <p className="drawer-hint tight">No harmonies were heard in this song. The harmony stack in the Vocals tab can build some from the chords.</p>
            )}
            <p className="drawer-hint tight">To have autotune follow the song’s melody, set a vocal track’s autotune to Follow chords → Melody.</p>
            <div className="prow-buttons">
              <button className="btn" onClick={() => void separateReference()}>Separate again</button>
            </div>
          </>
        )}
      </section>

      <section className="psection">
        <div className="ptitle">Backing track</div>
        {!remade.length ? (
          <>
            <p className="drawer-hint tight">
              Recreate the song’s backing as MIDI you can edit: its drums, bass line, and the chords and lines on top, each on its own track. Every sound in your
              soundfonts (the design folder, your soundfont list and the built-in GeneralUser GS) is tried on each part, and the closest one plays it.
            </p>
            <p className="drawer-hint tight">
              The first time downloads the drum and bass separators (60 MB){ref.stems ? '' : ' after separating the vocals'}. A three-minute song takes a minute or two.
            </p>
            <div className="prow-buttons">
              <button className="btn primary" onClick={() => void remakeBacking()}>Recreate the backing track</button>
            </div>
          </>
        ) : (
          <>
            {(['drums', 'bass', 'keys'] as RemakePart[]).map((part) => {
              const t = remade.find((x) => x.remake === part)
              const options = ref.remake?.[part] ?? []
              if (!t) return null
              const current = options.findIndex((o) => o.font === t.font && o.bank === t.bank && o.program === t.program)
              return (
                <Field key={part} label={part === 'drums' ? 'Drums' : part === 'bass' ? 'Bass' : 'Keys'}>
                  <select
                    id={`remake-${part}`}
                    className="select grow"
                    value={current}
                    title="The closest sounds found, best first"
                    onChange={(e) => {
                      const c = options[Number(e.target.value)]
                      if (c) chooseSound(part, c)
                    }}
                  >
                    {current < 0 && <option value={-1}>Your own choice</option>}
                    {options.map((o, i) => (
                      <option key={i} value={i}>
                        {describe(o)} · {closeness(o)}
                      </option>
                    ))}
                  </select>
                  <button className={`ms${t.muted ? ' on mute' : ''}`} title="Mute this part" onClick={() => updateTrack(t.id, { muted: !t.muted })}>M</button>
                </Field>
              )
            })}
            <p className="drawer-hint tight">
              Each part is a track: edit its notes on the stage, or pick another sound for it here or in the Tracks tab. To tidy a part’s timing, click it in the
              Tracks tab to select its notes and press Q.
            </p>
            <div className="prow-buttons">
              <button className="btn" title="Replaces the remade tracks, edits included" onClick={() => void remakeBacking()}>Recreate again</button>
            </div>
          </>
        )}
        <RemakeOnOpen />
      </section>

      {ref.stems && (
        <section className="psection">
          <div className="ptitle">
            Lyrics {song.lyrics.length > 0 && <span className="meta">{song.lyrics.length} lines</span>}
          </div>
          {song.lyrics.length === 0 ? (
            <>
              <p className="drawer-hint tight">
                Read the words from the separated vocals and show them over the stage while they’re sung. The first time downloads the lyrics model (about 80 MB).
                Mumbled or heavily effected vocals come out patchy.
              </p>
              <div className="prow-buttons">
                <button className="btn primary" onClick={() => void findLyrics()}>Find the lyrics</button>
              </div>
            </>
          ) : (
            <>
              <ul className="lyric-list">
                {song.lyrics.map((l, i) => (
                  <li key={i}>
                    <button className="clip-go" title="Jump to this line" onClick={() => engine.seek(tempoMap(song).tickToSec(l.tick))}>
                      {Math.floor(tempoMap(song).tickToSec(l.tick) / 60)}:{String(Math.floor(tempoMap(song).tickToSec(l.tick) % 60)).padStart(2, '0')}
                    </button>
                    <input id={`lyric-${i}`} className="text-in" value={l.text} aria-label={`Lyric line ${i + 1}`} onChange={(e) => setLyric(i, e.target.value)} />
                  </li>
                ))}
              </ul>
              <div className="prow-buttons">
                <button className="btn" onClick={() => void findLyrics()}>Read them again</button>
              </div>
            </>
          )}
        </section>
      )}

      <section className="psection">
        <div className="ptitle">Chords <span className="meta">{chordCount} changes</span></div>
        <p className="drawer-hint tight">Chord names sit on the left of the stage where each chord starts. Click one to change it.</p>
        <div className="prow-buttons">
          <button className="btn" onClick={() => addChordAt(tempoMap(getState().song).secToTick(engine.time()))}>Add a change at the playhead</button>
          {pad && (
            <button className="btn" title="A soft pad playing the chord lane" onClick={() => updateTrack(pad.id, { muted: !pad.muted })}>
              {pad.muted ? 'Hear the chords' : 'Mute the chords'}
            </button>
          )}
        </div>
      </section>

      <section className="psection">
        <div className="ptitle">Beat</div>
        <Field label="Style">
          <select id="ref-style" className="select grow" value={style} onChange={(e) => setStyle(e.target.value)}>
            {STYLES.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
        <div className="prow-buttons">
          <button
            className="btn primary"
            title="An original beat at the song's tempo: kicks where the song's kicks land, busier where it's busier, quiet where it drops out"
            onClick={() => {
              generateDrums(style, Math.floor(Math.random() * 1e9))
              getState().notify('Generated a beat that follows the song. Edit it in the Beat tab.')
            }}
          >
            Generate a matching beat
          </button>
          <button
            className="btn"
            title="The song's own kick, snare and hi-hat pattern, as editable steps"
            onClick={() => getState().notify(copyReferenceGroove() ? 'Copied the song’s groove into the drum track.' : 'No clear drum hits were found in this song.')}
          >
            Copy its groove
          </button>
        </div>
      </section>

      <section className="psection">
        <div className="ptitle">Sections <span className="meta">{song.sections.length} found</span></div>
        <p className="drawer-hint tight">
          {song.sections.map((s) => `${s.name} (bar ${s.bar + 1})`).join(' · ') || 'None found.'} Rename or rearrange them in the Sections tab.
        </p>
        <div className="prow-buttons">
          <button className="btn" onClick={() => getState().set({ drawerTab: 'sections' })}>Open Sections</button>
        </div>
      </section>

      <section className="psection">
        <button className="btn" onClick={() => void importReference()}>Replace with another song…</button>
      </section>
    </>
  )
}

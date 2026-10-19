import { useEffect, useRef, useState } from 'react'
import { engine } from '../audio/engine'
import { studioInput } from '../audio/midiInput'
import { detectKey, keyName, recognizeChord, suggestChords, type Chord, type Key, type Suggestion } from '../model/harmony'
import { tempoMap, ticksPerBar, ticksPerBeat, trackTimes } from '../model/song'
import { addRecorded } from '../state/edit'
import { savePref } from '../state/prefs'
import { getState, useStore } from '../state/store'
import { setHeardKey } from '../audio/liveVocal'
import { LiveVocals } from './LiveVocals'

const UPDATE_MS = 150
/** How quickly older notes stop counting toward the key, in seconds. */
const KEY_MEMORY = 15

interface Reading {
  key: Key | null
  chord: Chord | null
  /** the chord shown is the last one played, not one held now */
  chordIsLast: boolean
  suggestions: Suggestion[]
}

/** Pitch-class weights from recent playing (longer, newer notes count more), plus the song around the playhead. */
function histogram(): { weights: number[]; register: number } {
  const { held, recent, now } = studioInput()
  const weights = new Array(12).fill(0)
  let sum = 0
  let count = 0
  for (const n of recent) {
    const dur = Math.min(2, Math.max(0.1, n.end - n.start))
    weights[n.pitch % 12] += dur * Math.exp(-(now - n.end) / KEY_MEMORY)
    sum += n.pitch
    count++
  }
  for (const p of held) weights[p % 12] += 0.5
  const { song, playing } = getState()
  if (playing) {
    const t = engine.time()
    const map = tempoMap(song)
    for (const track of song.tracks) {
      const times = trackTimes(track, map)
      track.notes.forEach((n, i) => {
        if (times.end[i] > t - 6 && times.start[i] < t + 1) weights[n.pitch % 12] += 0.4 * Math.min(2, times.end[i] - times.start[i])
      })
    }
  }
  return { weights, register: count ? sum / count : 60 }
}

/** Studio mode: names the key and chord being played and suggests chords that fit. */
export function StudioPanel(): React.JSX.Element | null {
  const studio = useStore((s) => s.studio)
  const chords = useStore((s) => s.studioChords)
  const [reading, setReading] = useState<Reading>({ key: null, chord: null, chordIsLast: false, suggestions: [] })
  const hovered = useRef<number[] | null>(null)
  const memory = useRef<{ key: Key | null; candidate: string; streak: number; lastChord: Chord | null }>({
    key: null,
    candidate: '',
    streak: 0,
    lastChord: null
  })

  useEffect(() => {
    if (!studio || !chords) {
      if (getState().studioHint) getState().set({ studioHint: null })
      return
    }
    const update = (): void => {
      const m = memory.current
      const { weights, register } = histogram()
      // only change key after the same new key is heard a few updates in a row
      const found = detectKey(weights)
      const id = found ? keyName(found) : ''
      if (!m.key || !found) m.key = found ?? m.key
      else if (id !== keyName(m.key)) {
        m.streak = id === m.candidate ? m.streak + 1 : 1
        m.candidate = id
        if (m.streak >= 3) m.key = found
      } else {
        m.streak = 0
        m.key = found
      }
      setHeardKey(m.key)
      const { held } = studioInput()
      const now = recognizeChord(held)
      if (now) m.lastChord = now
      const chord = now ?? (held.length ? null : m.lastChord)
      const suggestions = suggestChords(m.key, held, chord, register)
      setReading((r) => {
        const same =
          r.key?.tonic === m.key?.tonic &&
          r.key?.minor === m.key?.minor &&
          r.chord?.name === chord?.name &&
          r.chordIsLast === !now &&
          r.suggestions.map((s) => s.chord.name + s.pitches.join()).join() === suggestions.map((s) => s.chord.name + s.pitches.join()).join()
        return same ? r : { key: m.key, chord, chordIsLast: !now, suggestions }
      })
      const hint = hovered.current ?? suggestions[0]?.pitches ?? null
      if (getState().studioHint?.join() !== hint?.join()) getState().set({ studioHint: hint })
    }
    update()
    const id = window.setInterval(update, UPDATE_MS)
    return () => window.clearInterval(id)
  }, [studio, chords])

  if (!studio) return null

  const audition = (s: Suggestion): void => {
    const { song, activeTrackId } = getState()
    const ch = song.tracks.find((t) => t.id === activeTrackId)?.channel ?? 0
    for (const p of s.pitches) engine.previewNote(ch, p, 80, 1.2)
  }

  /** Adds the chord at the beat nearest the playhead, one bar long, to the active track. */
  const insert = (s: Suggestion): void => {
    const { song, activeTrackId } = getState()
    const map = tempoMap(song)
    const beat = ticksPerBeat(song)
    const tick = Math.round(map.secToTick(engine.time()) / beat) * beat
    addRecorded(activeTrackId, s.pitches.map((pitch) => ({ pitch, tick, dur: ticksPerBar(song), vel: 80 })))
    getState().notify(`Added ${s.chord.name} at the playhead`)
  }

  const toggle = (on: boolean): void => {
    getState().set({ studioChords: on })
    savePref('studioChords', on)
  }
  const checkbox = (
    <label className="check studio-toggle">
      <input id="studio-chords" type="checkbox" checked={chords} onChange={(e) => toggle(e.target.checked)} /> Suggest chords
    </label>
  )
  if (!chords) {
    return (
      <div className="studio compact">
        <div className="studio-head">
          <span className="studio-tag">Studio</span>
          {checkbox}
        </div>
        <LiveVocals />
      </div>
    )
  }

  const { key, chord, chordIsLast, suggestions } = reading
  return (
    <div className="studio" aria-live="polite">
      <div className="studio-head">
        <span className="studio-tag">Studio</span>
        {checkbox}
      </div>
      <div className="studio-head">
        {key ? (
          <span className="studio-key">
            Key <strong>{keyName(key)}</strong>
          </span>
        ) : (
          <span className="studio-key muted">Play a few notes to find the key</span>
        )}
        {chord && (
          <span className="studio-chord">
            {chordIsLast ? 'Last chord' : 'Chord'} <strong>{chord.name}</strong>
          </span>
        )}
      </div>
      {suggestions.length > 0 && (
        <>
          <div className="studio-label">{chord ? 'Try next' : 'Chords that fit'}</div>
          <div className="studio-chips">
            {suggestions.map((s) => (
              <button
                key={s.chord.name}
                className="chip"
                title={`${s.why}. Click to hear it, Shift+click to add it at the playhead.`}
                onMouseEnter={() => {
                  hovered.current = s.pitches
                  getState().set({ studioHint: s.pitches })
                }}
                onMouseLeave={() => (hovered.current = null)}
                onClick={(e) => (e.shiftKey ? insert(s) : audition(s))}
              >
                <strong>{s.chord.name}</strong>
                <span>{s.numeral}</span>
              </button>
            ))}
          </div>
          <div className="studio-foot">Click to hear · Shift+click adds it at the playhead</div>
        </>
      )}
      <LiveVocals />
    </div>
  )
}

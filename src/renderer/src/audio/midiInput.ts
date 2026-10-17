import { tempoMap, type Note } from '../model/song'
import { addRecorded } from '../state/edit'
import { getState, useStore } from '../state/store'
import { engine } from './engine'

interface Held {
  start: number
  vel: number
  ch: number
}

const held = new Map<number, Held>()
let take: { pitch: number; start: number; end: number; vel: number }[] = []

function activeTrack() {
  const { song, activeTrackId } = getState()
  return song.tracks.find((t) => t.id === activeTrackId) ?? song.tracks[0]
}

function onMessage(e: MIDIMessageEvent): void {
  const d = e.data
  if (!d || d.length < 2) return
  const status = d[0] & 0xf0
  const pitch = d[1]
  const vel = d[2] ?? 0
  const track = activeTrack()
  const ch = track?.channel ?? 0
  if (status === 0x90 && vel > 0) {
    engine.noteOn(ch, pitch, vel)
    engine.liveKeys.set(pitch, vel)
    held.set(pitch, { start: engine.time(), vel, ch })
  } else if (status === 0x80 || (status === 0x90 && vel === 0)) {
    const h = held.get(pitch)
    engine.noteOff(h?.ch ?? ch, pitch)
    engine.liveKeys.delete(pitch)
    held.delete(pitch)
    const { recording, playing } = getState()
    if (h && recording && playing) take.push({ pitch, start: h.start, end: engine.time(), vel: h.vel })
  } else if (status === 0xb0) {
    engine.controller(ch, pitch, vel)
  }
}

/** Starts listening to every connected MIDI input and keeps the device list in the store. */
export async function initMidiInput(): Promise<void> {
  if (!navigator.requestMIDIAccess) return
  try {
    const access = await navigator.requestMIDIAccess()
    const bind = (): void => {
      const names: string[] = []
      access.inputs.forEach((input) => {
        input.onmidimessage = onMessage
        names.push(input.name ?? 'MIDI input')
      })
      useStore.setState({ midiInputs: names })
    }
    access.onstatechange = bind
    bind()
  } catch {
    useStore.setState({ midiInputs: [] })
  }
}

/** The take so far in seconds, with held keys running up to now. Drawn while recording. */
export function liveTake(): { pitch: number; start: number; end: number; vel: number }[] {
  const now = engine.time()
  const out = [...take]
  for (const [pitch, h] of held) out.push({ pitch, start: h.start, end: now, vel: h.vel })
  return out
}

export function beginTake(): void {
  take = []
}

/** Writes the notes played since `beginTake` into the active track as one undo step. */
export function commitTake(): number {
  const now = engine.time()
  const { song } = getState()
  const map = tempoMap(song)
  for (const [pitch, h] of held) take.push({ pitch, start: h.start, end: now, vel: h.vel })
  const notes: Omit<Note, 'id'>[] = take
    .filter((n) => n.end > n.start)
    .map((n) => {
      const tick = Math.round(map.secToTick(n.start))
      return { pitch: n.pitch, tick, dur: Math.max(1, Math.round(map.secToTick(n.end)) - tick), vel: n.vel }
    })
  const track = activeTrack()
  if (track) addRecorded(track.id, notes)
  take = []
  return notes.length
}

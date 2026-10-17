import { tempoMap, type CC, type Note } from '../model/song'
import { addRecorded } from '../state/edit'
import { getState, useStore } from '../state/store'
import { engine } from './engine'

interface Held {
  start: number
  vel: number
  ch: number
}

/** Controllers saved with a take: mod wheel, sustain, sostenuto and soft pedal. */
const RECORDED_CCS = new Set([1, 64, 66, 67])

const held = new Map<number, Held>()
let take: { pitch: number; start: number; end: number; vel: number }[] = []
let takeCCs: { time: number; num: number; val: number }[] = []

function activeTrack() {
  const { song, activeTrackId } = getState()
  return song.tracks.find((t) => t.id === activeTrackId) ?? song.tracks[0]
}

const capturing = (): boolean => {
  const { recording, playing } = getState()
  return recording && playing
}

/** Adds a played note to the take; one held across a loop jump is split at the loop boundary. */
function pushNote(pitch: number, start: number, end: number, vel: number): void {
  const loop = engine.loopRegion
  if (end < start && loop) {
    take.push({ pitch, start, end: loop.end, vel })
    take.push({ pitch, start: loop.start, end, vel })
  } else take.push({ pitch, start, end, vel })
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
    if (h && capturing()) pushNote(pitch, h.start, engine.time(), h.vel)
  } else if (status === 0xb0) {
    engine.controller(ch, pitch, vel)
    if (RECORDED_CCS.has(pitch) && capturing()) takeCCs.push({ time: engine.time(), num: pitch, val: vel })
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
  takeCCs = []
}

/** Writes the notes and pedal moves played since `beginTake` into the active track as one undo step. */
export function commitTake(): number {
  const now = engine.time()
  const { song } = getState()
  const map = tempoMap(song)
  for (const [pitch, h] of held) pushNote(pitch, h.start, now, h.vel)
  const toTick = (sec: number): number => Math.max(0, Math.round(map.secToTick(sec)))
  // anything played during the count-in starts at the top of the song
  const notes: Omit<Note, 'id'>[] = take
    .filter((n) => n.end > n.start && n.end > 0)
    .map((n) => {
      const tick = toTick(n.start)
      return { pitch: n.pitch, tick, dur: Math.max(1, toTick(n.end) - tick), vel: n.vel }
    })
  const ccs: CC[] = takeCCs.map((c) => ({ tick: toTick(c.time), num: c.num, val: c.val }))
  // a pedal still down when recording stops would otherwise hold forever on playback
  const down = new Map<number, number>()
  for (const c of takeCCs) down.set(c.num, c.val)
  for (const num of [64, 66, 67]) if ((down.get(num) ?? 0) >= 64) ccs.push({ tick: toTick(now), num, val: 0 })
  const track = activeTrack()
  if (track) addRecorded(track.id, notes, ccs)
  take = []
  takeCCs = []
  return notes.length
}

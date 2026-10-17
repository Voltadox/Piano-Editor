import { tempoMap, type CC, type Note } from '../model/song'
import { addRecorded } from '../state/edit'
import { getState, useStore } from '../state/store'
import { engine } from './engine'

interface Held {
  /** song time */
  start: number
  /** wall-clock time, for the Studio trail */
  wall: number
  vel: number
  ch: number
}

export interface LiveNote {
  pitch: number
  start: number
  end: number
  vel: number
}

/** Controllers saved with a take: mod wheel, sustain, sostenuto and soft pedal. */
const RECORDED_CCS = new Set([1, 64, 66, 67])
/** Seconds of played notes kept for Studio mode's trail and key detection. */
const TRAIL_SECONDS = 30

const held = new Map<number, Held>()
let take: LiveNote[] = []
let takeCCs: { time: number; num: number; val: number }[] = []
/** Recently played notes in wall-clock seconds. */
let trail: LiveNote[] = []

export const wallNow = (): number => performance.now() / 1000

function activeTrack() {
  const { song, activeTrackId } = getState()
  return song.tracks.find((t) => t.id === activeTrackId) ?? song.tracks[0]
}

const capturing = (): boolean => {
  const { recording, playing } = getState()
  return recording && playing
}

/** Pulls a played velocity toward the chosen level by the evening amount. */
export function shapeVelocity(vel: number): number {
  const { velEven, velLevel } = getState()
  return Math.round(Math.min(127, Math.max(1, velLevel + (vel - velLevel) * (1 - velEven))))
}

/** Adds a played note to the take; one held across a loop jump is split at the loop boundary. */
function pushNote(pitch: number, start: number, end: number, vel: number): void {
  const loop = engine.loopRegion
  if (end < start && loop) {
    take.push({ pitch, start, end: loop.end, vel })
    take.push({ pitch, start: loop.start, end, vel })
  } else take.push({ pitch, start, end, vel })
}

/** A key went down, on a MIDI keyboard or the on-screen piano. */
export function pressKey(pitch: number, rawVel: number): void {
  const vel = shapeVelocity(rawVel)
  const ch = activeTrack()?.channel ?? 0
  if (held.has(pitch)) releaseKey(pitch)
  engine.noteOn(ch, pitch, vel)
  engine.liveKeys.set(pitch, vel)
  held.set(pitch, { start: engine.time(), wall: wallNow(), vel, ch })
}

export function releaseKey(pitch: number): void {
  const h = held.get(pitch)
  engine.noteOff(h?.ch ?? activeTrack()?.channel ?? 0, pitch)
  engine.liveKeys.delete(pitch)
  held.delete(pitch)
  if (!h) return
  if (capturing()) pushNote(pitch, h.start, engine.time(), h.vel)
  const now = wallNow()
  trail.push({ pitch, start: h.wall, end: now, vel: h.vel })
  if (trail.length > 400 || trail[0].end < now - TRAIL_SECONDS) trail = trail.filter((n) => n.end > now - TRAIL_SECONDS).slice(-400)
}

function onMessage(e: MIDIMessageEvent): void {
  const d = e.data
  if (!d || d.length < 2) return
  const status = d[0] & 0xf0
  const pitch = d[1]
  const vel = d[2] ?? 0
  if (status === 0x90 && vel > 0) pressKey(pitch, vel)
  else if (status === 0x80 || (status === 0x90 && vel === 0)) releaseKey(pitch)
  else if (status === 0xb0) {
    engine.controller(activeTrack()?.channel ?? 0, pitch, vel)
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
export function liveTake(): LiveNote[] {
  const now = engine.time()
  const out = [...take]
  for (const [pitch, h] of held) out.push({ pitch, start: h.start, end: now, vel: h.vel })
  return out
}

/** Recently played notes (held ones running up to now), shifted onto a view whose clock reads `t` now. */
export function liveTrail(t: number): LiveNote[] {
  const now = wallNow()
  const shift = t - now
  const out = trail.map((n) => ({ ...n, start: n.start + shift, end: n.end + shift }))
  for (const [pitch, h] of held) out.push({ pitch, start: h.wall + shift, end: t, vel: h.vel })
  return out
}

/** What Studio mode listens to: the keys held now, and recent notes in wall-clock seconds. */
export function studioInput(): { held: number[]; recent: LiveNote[]; now: number } {
  const now = wallNow()
  const recent = [...trail]
  for (const [pitch, h] of held) recent.push({ pitch, start: h.wall, end: now, vel: h.vel })
  return { held: [...held.keys()], recent, now }
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

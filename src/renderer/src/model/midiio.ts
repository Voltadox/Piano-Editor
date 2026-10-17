import { Midi } from '@tonejs/midi'
import { writeMidi, type MidiEvent } from 'midi-file'
import { GM_NAMES } from './gm'
import { mixerCCs } from '../audio/events'
import { DRUM_CHANNEL, PALETTE, newId, sortNotes, type Song, type Track } from './song'

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** The first value a controller is set to, or a default. */
const firstCC = (ccs: { num: number; val: number }[], num: number, fallback: number): number => ccs.find((c) => c.num === num)?.val ?? fallback

export function parseMidiFile(bytes: Uint8Array): Song {
  const midi = new Midi(bytes)
  const ppq = midi.header.ppq || 480
  const tempos = midi.header.tempos.map((t) => ({ tick: t.ticks, bpm: Math.round(t.bpm * 1000) / 1000 }))
  if (!tempos.length) tempos.push({ tick: 0, bpm: 120 })
  const ts = midi.header.timeSignatures[0]?.timeSignature
  const timeSig: [number, number] = ts && ts.length >= 2 ? [ts[0], ts[1]] : [4, 4]

  const tracks: Track[] = []
  midi.tracks.forEach((t) => {
    const ccs = Object.values(t.controlChanges)
      .flat()
      .map((c) => ({ tick: c.ticks, num: c.number, val: clamp(Math.round(c.value * 127), 0, 127) }))
      .sort((a, b) => a.tick - b.tick)
    if (!t.notes.length && !ccs.length) return
    const drum = t.channel === DRUM_CHANNEL
    const fallbackName = drum ? 'Drums' : GM_NAMES[t.instrument.number] ?? `Track ${tracks.length + 1}`
    tracks.push({
      id: newId(),
      name: t.name.trim() || fallbackName,
      channel: clamp(t.channel, 0, 15),
      program: drum ? 0 : t.instrument.number,
      bank: firstCC(ccs, 0, 0),
      color: PALETTE[tracks.length % PALETTE.length],
      muted: false,
      solo: false,
      notes: sortNotes(
        t.notes.map((n) => ({
          id: newId(),
          pitch: n.midi,
          tick: n.ticks,
          dur: Math.max(1, n.durationTicks),
          vel: clamp(Math.round(n.velocity * 127), 1, 127)
        }))
      ),
      ccs,
      volume: firstCC(ccs, 7, 0.8 * 127) / 127,
      pan: (firstCC(ccs, 10, 64) - 64) / 63,
      reverb: firstCC(ccs, 91, 0.3 * 127) / 127,
      bends: t.pitchBends
        .map((p) => ({ tick: p.ticks, val: clamp(Math.round(p.value * 8192 + 8192), 0, 16383) }))
        .sort((a, b) => a.tick - b.tick)
    })
  })
  return { ppq, tempos, timeSig, tracks, audioTracks: [], sections: [], key: null, chords: [] }
}

type WithoutDelta<T> = T extends unknown ? Omit<T, 'deltaTime'> : never

interface AbsEvent {
  tick: number
  order: number
  ev: WithoutDelta<MidiEvent>
}

function toTrack(events: AbsEvent[]): MidiEvent[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order)
  let last = 0
  const out = events.map((e) => {
    const deltaTime = Math.max(0, Math.round(e.tick) - last)
    last += deltaTime
    return { ...e.ev, deltaTime } as MidiEvent
  })
  out.push({ deltaTime: 0, meta: true, type: 'endOfTrack' })
  return out
}

export function writeMidiFile(song: Song, title: string): Uint8Array {
  const conductor: AbsEvent[] = [
    { tick: 0, order: 0, ev: { meta: true, type: 'trackName', text: title } },
    {
      tick: 0,
      order: 1,
      ev: {
        meta: true,
        type: 'timeSignature',
        numerator: song.timeSig[0],
        denominator: song.timeSig[1],
        metronome: 24,
        thirtyseconds: 8
      }
    },
    ...song.tempos.map((t) => ({
      tick: t.tick,
      order: 2,
      ev: { meta: true as const, type: 'setTempo' as const, microsecondsPerBeat: Math.round(60_000_000 / t.bpm) }
    }))
  ]

  const tracks = song.tracks.map((t) => {
    const ch = t.channel
    const evs: AbsEvent[] = [
      { tick: 0, order: 0, ev: { meta: true, type: 'trackName', text: t.name } },
      { tick: 0, order: 0, ev: { type: 'controller', channel: ch, controllerType: 0, value: t.bank } },
      { tick: 0, order: 1, ev: { type: 'programChange', channel: ch, programNumber: t.program } },
      ...mixerCCs(t).map(([num, val]) => ({ tick: 0, order: 2, ev: { type: 'controller' as const, channel: ch, controllerType: num, value: val } }))
    ]
    for (const c of t.ccs)
      if (c.num !== 7 && c.num !== 10 && c.num !== 0) evs.push({ tick: c.tick, order: 2, ev: { type: 'controller', channel: ch, controllerType: c.num, value: c.val } })
    for (const b of t.bends)
      evs.push({ tick: b.tick, order: 3, ev: { type: 'pitchBend', channel: ch, value: b.val - 8192 } })
    for (const n of t.notes) {
      // note-offs sort before note-ons on the same tick so repeated pitches retrigger cleanly
      evs.push({ tick: n.tick + n.dur, order: 1, ev: { type: 'noteOff', channel: ch, noteNumber: n.pitch, velocity: 0 } })
      evs.push({ tick: n.tick, order: 4, ev: { type: 'noteOn', channel: ch, noteNumber: n.pitch, velocity: n.vel } })
    }
    return toTrack(evs)
  })

  const bytes = writeMidi({
    header: { format: 1, numTracks: tracks.length + 1, ticksPerBeat: song.ppq },
    tracks: [toTrack(conductor), ...tracks]
  })
  return new Uint8Array(bytes)
}

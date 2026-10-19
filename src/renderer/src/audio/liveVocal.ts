import { melodyPitchAt, scaleOf, songKey } from '../model/guide'
import type { LiveSettings } from '../model/live'
import type { Key } from '../model/harmony'
import { tempoMap } from '../model/song'
import { savePref } from '../state/prefs'
import { getState, useStore } from '../state/store'
import { engine } from './engine'
import { studioInput } from './midiInput'
import { buildChain, type Chain } from './vocalChain'
import { micStream, openMic } from './vocalRecorder'

/**
 * Live autotune for the microphone in Studio mode: the mic runs through the live-tune worklet
 * (pitch found and moved as you sing), then a vocal effect and a level, into the mix with the
 * piano, so a stream or recording of Keyfall's sound has the tuned voice in it.
 */

interface Live {
  source: MediaStreamAudioSourceNode
  node: AudioWorkletNode
  chain: Chain
  vol: GainNode
  preset: LiveSettings['preset']
  amount: number
  timer: number
  sent: string
}

let live: Live | null = null
let moduleReady: Promise<void> | null = null
/** what the worklet last reported: the pitch sung and the note it's aimed at (MIDI) */
let reading: { sung: number; target: number; at: number } | null = null
/** the key Studio mode hears in what's being played, which Key snapping prefers */
let heardKey: Key | null = null
/** the last chord held on the keyboard, kept while no keys are down */
let lastHeld: number[] = []

export const setHeardKey = (k: Key | null): void => {
  heardKey = k
}

/** The pitch being sung live and the note it's being tuned to, while live autotune is on. */
export function liveReading(): { sung: number; target: number } | null {
  return reading && performance.now() - reading.at < 250 && !Number.isNaN(reading.sung) ? reading : null
}

const beatOf = (): number => 60 / tempoMap(getState().song).bpmAt(0)

/** What the worklet should aim at right now, by the snap setting. */
function aim(s: LiveSettings): { classes: number[]; target: number | null } {
  const { song, playing } = getState()
  const keyClasses = scaleOf(heardKey ?? songKey(song))
  if (s.snap === 'chords') {
    const held = studioInput().held
    if (held.length) lastHeld = [...new Set(held.map((p) => p % 12))]
    return { classes: lastHeld.length ? lastHeld : keyClasses, target: null }
  }
  if (s.snap === 'song' && playing) {
    const m = melodyPitchAt(song, engine.heardTime())
    if (m !== null) return { classes: keyClasses, target: m }
  }
  return { classes: keyClasses, target: null }
}

function send(s: LiveSettings): void {
  if (!live) return
  const a = aim(s)
  const msg = { ...a, speed: s.speed, transpose: s.transpose, formant: s.formant }
  const id = JSON.stringify(msg)
  if (id === live.sent) return
  live.sent = id
  live.node.port.postMessage(msg)
}

/** Turns live autotune on: opens the mic and puts the tuned voice into the mix. */
export async function startLive(): Promise<void> {
  if (live) return
  await openMic(getState().micId)
  const ctx = engine.ctx!
  moduleReady ??= ctx.audioWorklet.addModule(new URL('live-tune.worklet.js', document.baseURI).href).catch((err) => {
    moduleReady = null
    throw err
  })
  await moduleReady
  const stream = micStream()
  if (!stream || live) return
  const s = getState().live
  const source = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'keyfall-live-tune', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
  node.port.onmessage = (e: MessageEvent<{ sung: number; target: number }>) => {
    reading = { ...e.data, at: performance.now() }
  }
  const chain = buildChain(ctx, s.preset, s.amount, beatOf())
  const vol = ctx.createGain()
  vol.gain.value = s.volume
  source.connect(node).connect(chain.input)
  chain.output.connect(vol)
  engine.connectLive(vol)
  await ctx.resume()
  live = { source, node, chain, vol, preset: s.preset, amount: s.amount, timer: 0, sent: '' }
  // keep the aim up to date with the keys held, the key and the playhead
  live.timer = window.setInterval(() => send(getState().live), 30)
  send(s)
}

export function stopLive(): void {
  if (!live) return
  clearInterval(live.timer)
  live.source.disconnect()
  live.node.disconnect()
  live.chain.output.disconnect()
  live.vol.disconnect()
  live = null
  reading = null
}

/** Changes a live setting (saved for next time), applying it straight away. */
export function setLive(patch: Partial<LiveSettings>): void {
  const s = { ...getState().live, ...patch }
  useStore.setState({ live: s })
  savePref('live', s)
  if (!live || !engine.ctx) return
  live.vol.gain.setTargetAtTime(s.volume, engine.ctx.currentTime, 0.02)
  if (s.preset !== live.preset || Math.abs(s.amount - live.amount) > 0.001) {
    // swap the effect between the tuner and the level
    live.node.disconnect()
    live.chain.output.disconnect()
    live.chain = buildChain(engine.ctx, s.preset, s.amount, beatOf())
    live.node.connect(live.chain.input)
    live.chain.output.connect(live.vol)
    live.preset = s.preset
    live.amount = s.amount
  }
  send(s)
}

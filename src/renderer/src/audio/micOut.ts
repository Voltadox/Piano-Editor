import type { LiveSettings } from '../model/live'
import { isCableIn, isCableOut, type MicOutSettings, type MicOutStatus } from '../model/micOut'
import { tempoMap } from '../model/song'
import { savePref } from '../state/prefs'
import { getState, useStore } from '../state/store'
import { engine } from './engine'
import { liveTuneUrl, tuneMessage } from './liveVocal'
import { buildChain, type Chain } from './vocalChain'

/**
 * The Keyfall mic: your real microphone and everything Keyfall plays (not the metronome), mixed and
 * played into a virtual cable (VB-CABLE). Other apps pick the cable's other end as their
 * microphone and hear both together, for as long as Keyfall is open.
 *
 * The mix runs in its own AudioContext, playing on the cable. The voice goes straight into it,
 * through its own live-tune worklet and vocal effect when autotune is on (here, or live autotune in
 * Studio mode); Keyfall's sound comes across from the main context as a stream. Both are levelled
 * and brought up before the limiter: a raw mic with no auto gain and the synth at unity are far
 * quieter than other apps expect from a microphone.
 */

interface Tuner {
  node: AudioWorkletNode
  chain: Chain
  preset: LiveSettings['preset']
  amount: number
  timer: number
  sent: string
}

interface Running {
  ctx: AudioContext
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  /** the voice's leveller, where the raw or tuned voice goes in */
  voiceIn: AudioNode
  tuner: Tuner | null
  voice: GainNode
  piano: GainNode
  meter: AnalyserNode
  tap: MediaStreamAudioDestinationNode
  /** which devices and settings this was started with */
  key: string
}

let run: Running | null = null
/** bumped on every start and stop, so a start that finishes after a newer one gives way */
let generation = 0
let watching = false
const meterBuf = new Float32Array(1024)

const setStatus = (micOutStatus: MicOutStatus): void => useStore.setState({ micOutStatus })
const keyOf = (s: MicOutSettings): string => `${s.micId}|${s.sinkId}|${s.clean}`
const real = (d: MediaDeviceInfo): boolean => d.deviceId !== 'default' && d.deviceId !== 'communications'

/** The outputs and mics to choose from (the cable itself is never offered as a mic). */
export async function listMicOutDevices(): Promise<{ outputs: MediaDeviceInfo[]; mics: MediaDeviceInfo[] }> {
  const all = await navigator.mediaDevices.enumerateDevices()
  return {
    outputs: all.filter((d) => d.kind === 'audiooutput' && real(d)),
    mics: all.filter((d) => d.kind === 'audioinput' && real(d) && !isCableIn(d.label))
  }
}

/** The output the mix goes to: the chosen one if it is plugged in, otherwise the first virtual cable. */
async function findSink(s: MicOutSettings): Promise<MediaDeviceInfo | null> {
  const { outputs } = await listMicOutDevices()
  return (s.sinkId && outputs.find((d) => d.deviceId === s.sinkId)) || outputs.find((d) => isCableOut(d.label)) || null
}

const voiceLevel = (s: MicOutSettings): number => (s.muted ? 0 : s.voice)
/** The voice goes out tuned when asked for here, or while live autotune is on in Studio mode. */
const wantsTune = (): boolean => getState().micOut.tune || getState().liveTune
const beatOf = (): number => 60 / tempoMap(getState().song).bpmAt(0)

/** A compressor; Chromium adds its own make-up gain, so the deeper it squeezes the louder it comes out. */
function compressor(ctx: BaseAudioContext, threshold: number, ratio: number, knee: number, attack: number, release: number): DynamicsCompressorNode {
  const c = ctx.createDynamicsCompressor()
  c.threshold.value = threshold
  c.ratio.value = ratio
  c.knee.value = knee
  c.attack.value = attack
  c.release.value = release
  return c
}

function sendTune(t: Tuner): void {
  const msg = tuneMessage(getState().live)
  const id = JSON.stringify(msg)
  if (id === t.sent) return
  t.sent = id
  t.node.port.postMessage(msg)
}

/** Puts the tuner and vocal effect between the mic and the leveller, or takes them out, to match the settings. */
function applyTune(r: Running): void {
  const want = wantsTune()
  const s = getState().live
  if (!want) {
    if (!r.tuner) return
    clearInterval(r.tuner.timer)
    r.source.disconnect()
    r.tuner.node.disconnect()
    r.tuner.chain.output.disconnect()
    r.tuner = null
    r.source.connect(r.voiceIn)
    return
  }
  if (!r.tuner) {
    const node = new AudioWorkletNode(r.ctx, 'keyfall-live-tune', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    const chain = buildChain(r.ctx, s.preset, s.amount, beatOf())
    r.source.disconnect()
    r.source.connect(node).connect(chain.input)
    chain.output.connect(r.voiceIn)
    const t: Tuner = { node, chain, preset: s.preset, amount: s.amount, timer: 0, sent: '' }
    // keep the aim up to date with the keys held, the key and the playhead
    t.timer = window.setInterval(() => sendTune(t), 30)
    r.tuner = t
    sendTune(t)
    return
  }
  const t = r.tuner
  if (s.preset !== t.preset || Math.abs(s.amount - t.amount) > 0.001) {
    // swap the effect between the tuner and the leveller
    t.node.disconnect()
    t.chain.output.disconnect()
    t.chain = buildChain(r.ctx, s.preset, s.amount, beatOf())
    t.node.connect(t.chain.input)
    t.chain.output.connect(r.voiceIn)
    t.preset = s.preset
    t.amount = s.amount
  }
  sendTune(t)
}

async function start(): Promise<void> {
  const gen = ++generation
  teardown()
  const s = getState().micOut
  setStatus({ state: 'starting' })
  try {
    await engine.init()
    const sink = await findSink(s)
    if (gen !== generation) return
    if (!sink) {
      setStatus({ state: 'no-cable' })
      return
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: s.micId ? { exact: s.micId } : undefined,
        echoCancellation: false,
        noiseSuppression: s.clean,
        autoGainControl: false,
        channelCount: 1
      }
    })
    if (gen !== generation) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    const ctx = new AudioContext({ latencyHint: 'interactive', sinkId: sink.deviceId } as AudioContextOptions)
    try {
      await ctx.audioWorklet.addModule(liveTuneUrl())
      if (gen !== generation) throw new Error('superseded')
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close()
      if (gen !== generation) return
      throw err
    }
    const meter = ctx.createAnalyser()
    meter.fftSize = meterBuf.length
    // the voice: rumble out, then levelled so talking and singing come out at a steady, strong level
    const rumble = ctx.createBiquadFilter()
    rumble.type = 'highpass'
    rumble.frequency.value = 80
    const voiceComp = compressor(ctx, -32, 4, 10, 0.005, 0.25)
    const voice = ctx.createGain()
    voice.gain.value = voiceLevel(s)
    rumble.connect(voiceComp).connect(voice)
    // Keyfall's own sound, across from the main context, evened out and brought up the same way
    const tap = engine.ctx!.createMediaStreamDestination()
    engine.tapMix(tap)
    const pianoComp = compressor(ctx, -22, 2.5, 10, 0.01, 0.25)
    const piano = ctx.createGain()
    piano.gain.value = s.piano
    ctx.createMediaStreamSource(tap.stream).connect(pianoComp).connect(piano)
    // keeps a loud chord plus a shout from clipping in the other app
    const limiter = compressor(ctx, -2, 20, 0, 0.002, 0.1)
    voice.connect(limiter)
    piano.connect(limiter)
    limiter.connect(ctx.destination)
    limiter.connect(meter)
    const source = ctx.createMediaStreamSource(stream)
    source.connect(rumble)
    await ctx.resume()
    if (gen !== generation) {
      // a newer start (or a stop) came in while this one was finishing
      engine.untapMix(tap)
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close()
      return
    }
    run = { ctx, stream, source, voiceIn: rumble, tuner: null, voice, piano, meter, tap, key: keyOf(s) }
    applyTune(run)
    const track = stream.getAudioTracks()[0]
    // the mic was unplugged: try again (another mic, or report it)
    track.onended = () => {
      if (run?.stream === stream) void start()
    }
    const micName = track.label || 'Default microphone'
    setStatus({ state: 'on', sink: sink.label, mic: micName })
  } catch (err) {
    if (gen !== generation) return
    teardown()
    const name = err instanceof Error ? err.name : ''
    const message =
      name === 'NotAllowedError'
        ? 'Microphone access is blocked. Allow desktop apps to use the microphone in Windows Settings › Privacy & security › Microphone.'
        : name === 'NotFoundError' || name === 'OverconstrainedError'
          ? 'That microphone isn’t plugged in. Pick another below.'
          : `Couldn’t start. ${err instanceof Error ? err.message : String(err)}`
    setStatus({ state: 'error', message })
  }
}

function teardown(): void {
  if (!run) return
  const r = run
  run = null
  if (r.tuner) clearInterval(r.tuner.timer)
  engine.untapMix(r.tap)
  r.stream.getTracks().forEach((t) => {
    t.onended = null
    t.stop()
  })
  void r.ctx.close()
}

function stop(): void {
  generation++
  teardown()
  setStatus({ state: 'off' })
}

/** Starts the Keyfall mic if it was left on. Called once at startup. */
export function initMicOut(): void {
  if (!watching) {
    watching = true
    // a cable or mic plugged in or out: start if waiting for one, restart if ours went away
    navigator.mediaDevices.addEventListener('devicechange', () => {
      const { micOut, micOutStatus } = getState()
      if (!micOut.on) return
      if (micOutStatus.state !== 'on' && micOutStatus.state !== 'starting') void start()
      else if (run) {
        void findSink(micOut).then((sink) => {
          // the cable went away (sent elsewhere by Windows), or the chosen output came back
          if (run && (!sink || (run.ctx as AudioContext & { sinkId: string }).sinkId !== sink.deviceId)) void start()
        })
      }
    })
    // autotune turned on or off in Studio mode, or its settings changed
    useStore.subscribe((st, prev) => {
      if (run && (st.liveTune !== prev.liveTune || st.live !== prev.live)) applyTune(run)
    })
  }
  if (getState().micOut.on) void start()
}

/** Changes a Keyfall mic setting (saved for next time) and applies it straight away. */
export function setMicOut(patch: Partial<MicOutSettings>): void {
  const s = { ...getState().micOut, ...patch }
  useStore.setState({ micOut: s })
  savePref('micOut', s)
  if (!s.on) {
    if (run || getState().micOutStatus.state !== 'off') stop()
    return
  }
  if (!run || run.key !== keyOf(s)) {
    void start()
    return
  }
  const t = run.ctx.currentTime
  run.voice.gain.setTargetAtTime(voiceLevel(s), t, 0.02)
  run.piano.gain.setTargetAtTime(s.piano, t, 0.02)
  applyTune(run)
}

/** The peak of what's going out of the Keyfall mic right now (voice and piano), 0..1, for the meter. */
export function micOutLevel(): number {
  if (!run) return 0
  run.meter.getFloatTimeDomainData(meterBuf)
  let peak = 0
  for (const v of meterBuf) peak = Math.max(peak, Math.abs(v))
  return peak
}

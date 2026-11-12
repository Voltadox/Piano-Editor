import type { LiveSettings } from '../model/live'
import { isCableIn, isCableOut, type MicOutSettings, type MicOutStatus } from '../model/micOut'
import { tempoMap } from '../model/song'
import { savePref } from '../state/prefs'
import { getState, useStore } from '../state/store'
import { engine, LOW_LATENCY, makeLimiter } from './engine'
import { liveTuneUrl, loadLiveTune, tuneMessage } from './liveVocal'
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
 *
 * Hear my voice plays the voice on your own speakers as well, from Keyfall's main context (the
 * shortest way there), tuned the same way; Hear the piano off keeps Keyfall's sound for the cable only.
 */

interface Tuner {
  node: AudioWorkletNode
  chain: Chain
  preset: LiveSettings['preset']
  amount: number
  timer: number
  sent: string
}

/** A voice on its way somewhere: the mic, where it goes in, and the tuner between them when autotune is on. */
interface VoicePath {
  ctx: AudioContext
  source: MediaStreamAudioSourceNode
  into: AudioNode
  tuner: Tuner | null
}

interface Running {
  ctx: AudioContext
  stream: MediaStream
  /** the voice to the cable, into its leveller */
  cable: VoicePath
  /** the voice to your own speakers, in Keyfall's main context, while Hear my voice is on */
  monitor: (VoicePath & { gain: GainNode }) | null
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

/** Puts the tuner and vocal effect between the mic and where it goes, or takes them out, to match the settings. */
function applyTune(r: VoicePath): void {
  const want = wantsTune()
  const s = getState().live
  if (!want) {
    if (!r.tuner) return
    clearInterval(r.tuner.timer)
    r.source.disconnect()
    r.tuner.node.disconnect()
    r.tuner.chain.output.disconnect()
    r.tuner = null
    r.source.connect(r.into)
    return
  }
  if (!r.tuner) {
    const node = new AudioWorkletNode(r.ctx, 'keyfall-live-tune', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    const chain = buildChain(r.ctx, s.preset, s.amount, beatOf())
    r.source.disconnect()
    r.source.connect(node).connect(chain.input)
    chain.output.connect(r.into)
    const t: Tuner = { node, chain, preset: s.preset, amount: s.amount, timer: 0, sent: '' }
    // keep the aim up to date with the keys held, the key and the playhead
    t.timer = window.setInterval(() => sendTune(t), 30)
    r.tuner = t
    sendTune(t)
    return
  }
  const t = r.tuner
  if (s.preset !== t.preset || Math.abs(s.amount - t.amount) > 0.001) {
    // swap the effect between the tuner and where it goes
    t.node.disconnect()
    t.chain.output.disconnect()
    t.chain = buildChain(r.ctx, s.preset, s.amount, beatOf())
    t.node.connect(t.chain.input)
    t.chain.output.connect(r.into)
    t.preset = s.preset
    t.amount = s.amount
  }
  sendTune(t)
}

function dropMonitor(r: Running): void {
  const m = r.monitor
  if (!m) return
  r.monitor = null
  if (m.tuner) clearInterval(m.tuner.timer)
  m.source.disconnect()
  m.tuner?.node.disconnect()
  m.tuner?.chain.output.disconnect()
  m.into.disconnect()
  m.gain.disconnect()
}

/**
 * What you hear on your own speakers: the piano (or not), and your voice as it's sent (or not).
 * Live autotune in Studio mode plays the voice itself, so this stays out of its way.
 */
function applyHear(r: Running): void {
  const s = getState().micOut
  engine.setHeard(s.hearPiano)
  const ctx = engine.ctx!
  if (!s.hearVoice || getState().liveTune) {
    dropMonitor(r)
    return
  }
  if (!r.monitor) {
    const source = ctx.createMediaStreamSource(r.stream)
    const rumble = ctx.createBiquadFilter()
    rumble.type = 'highpass'
    rumble.frequency.value = 80
    const gain = ctx.createGain()
    gain.gain.value = 0
    source.connect(rumble).connect(gain)
    engine.connectLive(gain)
    void ctx.resume()
    r.monitor = { ctx, source, into: rumble, tuner: null, gain }
  }
  applyTune(r.monitor)
  // no leveller on this side (it would add delay): the tuner brings the voice up itself, a raw mic needs a lift
  r.monitor.gain.gain.setTargetAtTime(voiceLevel(s) * (r.monitor.tuner ? 1 : 2.5), ctx.currentTime, 0.02)
}

/** Everything that follows the settings without a restart. */
function applyAll(r: Running): void {
  applyTune(r.cable)
  applyHear(r)
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
        channelCount: 1,
        latency: { ideal: 0 }
      } as MediaTrackConstraints
    })
    if (gen !== generation) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    const ctx = new AudioContext({ latencyHint: LOW_LATENCY, sinkId: sink.deviceId } as AudioContextOptions)
    let limiter: { input: AudioNode; output: AudioNode }
    try {
      await ctx.audioWorklet.addModule(liveTuneUrl())
      // for hearing the voice on your own speakers
      await loadLiveTune()
      limiter = await makeLimiter(ctx)
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
    // the limiter keeps a loud chord plus a shout from clipping in the other app
    voice.connect(limiter.input)
    piano.connect(limiter.input)
    limiter.output.connect(ctx.destination)
    limiter.output.connect(meter)
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
    run = { ctx, stream, cable: { ctx, source, into: rumble, tuner: null }, monitor: null, voice, piano, meter, tap, key: keyOf(s) }
    applyAll(run)
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
  if (r.cable.tuner) clearInterval(r.cable.tuner.timer)
  dropMonitor(r)
  engine.setHeard(true)
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
      if (run && (st.liveTune !== prev.liveTune || st.live !== prev.live)) applyAll(run)
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
  applyAll(run)
}

/** The peak of what's going out of the Keyfall mic right now (voice and piano), 0..1, for the meter. */
export function micOutLevel(): number {
  if (!run) return 0
  run.meter.getFloatTimeDomainData(meterBuf)
  let peak = 0
  for (const v of meterBuf) peak = Math.max(peak, Math.abs(v))
  return peak
}

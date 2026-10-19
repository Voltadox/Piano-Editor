import type { GuideVoice } from '../model/audio'
import { guidePitchAt } from '../model/guide'
import { tempoMap } from '../model/song'
import { getState } from '../state/store'
import { addRecordedPasses } from '../state/vocalEdit'
import { engine } from './engine'
import { detectPitch, hzToMidi } from './pitch'
import { addTake } from './takes'

/**
 * Microphone capture for vocal takes. Audio is captured continuously while recording; the engine
 * reports the audio time of every start and loop jump, and the capture is cut at those points
 * (shifted by the round-trip latency) so each pass lands exactly where it was sung.
 */

interface Mic {
  stream: MediaStream
  node: AudioWorkletNode
  deviceId: string
  inputLatency: number
}

export interface VocalSession {
  kind: 'take' | 'harmony'
  /** take: [track]; harmony: one track per voice, recorded on successive loop passes */
  trackIds: number[]
  voices?: GuideVoice[]
  centre?: number
  /** play a guide tone of this voice during a plain take */
  guide?: { voice: GuideVoice; centre: number }
}

let mic: Mic | null = null
let workletReady: Promise<void> | null = null
let chunks: { frame: number; data: Float32Array }[] = []
let capturing = false
let anchors: { ctx: number; song: number }[] = []
let session: VocalSession | null = null
let recordFrom = 0
let level = 0
let tone: { osc: OscillatorNode; gain: GainNode } | null = null
/** the last ~85 ms of mic input */
const recent = new Float32Array(4096)
let pitchCache = { at: 0, midi: null as number | null }

/**
 * The pitch being sung right now (MIDI, fractional), or null when silent or unpitched. Worked out
 * from the latest mic input at most 20 times a second.
 */
export function livePitch(): number | null {
  if (!mic || !engine.ctx) return null
  const now = performance.now()
  if (now - pitchCache.at < 50) return pitchCache.midi
  const f0 = detectPitch(recent, engine.ctx.sampleRate)
  const voiced = [...f0].filter((f) => f > 0)
  pitchCache = { at: now, midi: voiced.length >= 2 ? hzToMidi(voiced[voiced.length >> 1]) : null }
  return pitchCache.midi
}

/**
 * How long ago the singing that livePitch() reports happened: the mic's own delay plus half of
 * the stretch of input it is worked out from.
 */
export const livePitchDelay = (): number => (mic?.inputLatency ?? 0.01) + recent.length / 2 / (engine.ctx?.sampleRate ?? 48000)

/**
 * Loads the capture worklet. It ships as a plain file next to the page (public/), because the
 * page's security policy blocks scripts from data: URLs, which is what a bundled tiny file becomes.
 */
export async function loadRecorderWorklet(): Promise<void> {
  await engine.init()
  workletReady ??= engine.ctx!.audioWorklet.addModule(new URL('recorder.worklet.js', document.baseURI).href).catch((err) => {
    workletReady = null
    throw err
  })
  await workletReady
}

/** Opens the microphone (or switches device). Throws if access is refused or no mic exists. */
export async function openMic(deviceId = ''): Promise<void> {
  await engine.init()
  const ctx = engine.ctx!
  if (mic && mic.deviceId === deviceId) return
  closeMic()
  await loadRecorderWorklet()
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
  })
  const source = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'keyfall-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
  // the worklet has to be pulled by the graph to run; it outputs silence
  const sink = ctx.createGain()
  sink.gain.value = 0
  source.connect(node).connect(sink).connect(ctx.destination)
  node.port.onmessage = (e: MessageEvent<{ frame: number; data: Float32Array }>) => {
    let peak = 0
    for (const v of e.data.data) peak = Math.max(peak, Math.abs(v))
    level = Math.max(peak, level * 0.97)
    if (capturing) chunks.push(e.data)
    // keep the latest stretch of input for the live pitch display
    const d = e.data.data
    recent.copyWithin(0, d.length)
    recent.set(d, recent.length - d.length)
  }
  const settings = stream.getAudioTracks()[0]?.getSettings() as MediaTrackSettings & { latency?: number }
  mic = { stream, node, deviceId, inputLatency: settings?.latency ?? 0.01 }
}

export function closeMic(): void {
  if (!mic) return
  mic.stream.getTracks().forEach((t) => t.stop())
  mic.node.disconnect()
  mic = null
}

/** Recent input peak, 0..1, for the level meter. */
export const micLevel = (): number => (level *= 0.995)

export async function listMics(): Promise<MediaDeviceInfo[]> {
  const all = await navigator.mediaDevices.enumerateDevices()
  return all.filter((d) => d.kind === 'audioinput')
}

/** Starts capturing. The transport is started by the caller; `from` is the song time takes begin at. */
export async function beginVocalCapture(s: VocalSession, from: number): Promise<void> {
  await openMic(getState().micId)
  session = s
  recordFrom = from
  chunks = []
  anchors = []
  capturing = true
  engine.onAnchor = (ctxTime, songTime) => {
    anchors.push({ ctx: ctxTime, song: songTime })
    const wraps = anchors.length - 1
    const rec = getState().vocalRec
    if (session?.kind === 'harmony' && rec) {
      const voices = session.voices?.length ?? 0
      // switch the banner to the next voice when the jump is actually reached
      const wait = Math.max(0, (ctxTime - engine.ctx!.currentTime) * 1000)
      setTimeout(() => {
        if (getState().vocalRec) getState().set({ vocalRec: { ...rec, pass: Math.min(wraps, voices - 1) } })
        // every voice has had its pass: stop at the end of the last one
        if (wraps >= voices) void import('../actions/transport').then((m) => m.stop())
      }, wait + 30)
    }
  }
  const guided = s.kind === 'harmony' || s.guide
  if (guided) startTone()
  engine.onTick = guided ? (t) => steerTone(t) : null
}

function currentVoice(): { voice: GuideVoice; centre: number } | null {
  if (!session) return null
  if (session.kind === 'take') return session.guide ?? null
  const pass = getState().vocalRec?.pass ?? 0
  const voice = session.voices?.[pass]
  return voice ? { voice, centre: session.centre ?? 57 } : null
}

function startTone(): void {
  const ctx = engine.ctx!
  const osc = ctx.createOscillator()
  osc.type = 'triangle'
  const soft = ctx.createBiquadFilter()
  soft.type = 'lowpass'
  soft.frequency.value = 1200
  const gain = ctx.createGain()
  gain.gain.value = 0
  osc.connect(soft).connect(gain).connect(ctx.destination)
  osc.start()
  tone = { osc, gain }
}

/** Keeps the guide tone on the current voice's note, a moment ahead; during the count-in it plays the first note. */
function steerTone(songTime: number): void {
  if (!tone || !engine.ctx) return
  const v = currentVoice()
  const t = Math.max(songTime + 0.03, recordFrom)
  const pitch = v ? guidePitchAt(getState().song, t, v.voice, v.centre) : null
  const now = engine.ctx.currentTime
  if (pitch === null) {
    tone.gain.gain.setTargetAtTime(0, now, 0.03)
    return
  }
  tone.osc.frequency.setTargetAtTime(440 * Math.pow(2, (pitch - 69) / 12), now, 0.012)
  tone.gain.gain.setTargetAtTime(getState().guideVolume * 0.4, now, 0.03)
}

function stopTone(): void {
  if (!tone) return
  tone.osc.stop()
  tone.gain.disconnect()
  tone = null
}

/** Stops capturing and files each pass into its track. Returns how many passes were kept. */
export function finishVocalCapture(): number {
  capturing = false
  engine.onAnchor = null
  engine.onTick = null
  stopTone()
  const s = session
  session = null
  const ctx = engine.ctx
  if (!s || !ctx || !chunks.length || !anchors.length) return 0
  const rate = ctx.sampleRate
  const first = chunks[0].frame
  const lastChunk = chunks[chunks.length - 1]
  const all = new Float32Array(lastChunk.frame + lastChunk.data.length - first)
  for (const c of chunks) all.set(c.data, c.frame - first)
  chunks = []

  // round trip: what was heard left the speakers late, and the voice reached the recorder late
  const latency = (ctx.outputLatency || 0) + ctx.baseLatency + (mic?.inputLatency ?? 0.01) + getState().latencyMs / 1000
  const passes: { song: number; pcm: Float32Array }[] = []
  anchors.sort((a, b) => a.ctx - b.ctx)
  anchors.forEach((a, i) => {
    let f0 = Math.round((a.ctx + latency) * rate) - first
    const f1 = Math.min(all.length, i + 1 < anchors.length ? Math.round((anchors[i + 1].ctx + latency) * rate) - first : all.length)
    let song = a.song
    if (f0 < 0) {
      song -= f0 / rate
      f0 = 0
    }
    // leave out the count-in
    if (song < recordFrom) {
      f0 += Math.round((recordFrom - song) * rate)
      song = recordFrom
    }
    if (f1 - f0 > rate * 0.3) passes.push({ song, pcm: all.slice(f0, f1) })
  })

  const map = tempoMap(getState().song)
  passes.forEach((p, i) => {
    const trackId = s.kind === 'harmony' ? s.trackIds[i] : s.trackIds[0]
    if (trackId === undefined) return
    const takeId = addTake(p.pcm, rate)
    addRecordedPasses(trackId, [{ tick: Math.round(map.secToTick(p.song)), duration: p.pcm.length / rate, takeId }])
  })
  return s.kind === 'harmony' ? Math.min(passes.length, s.trackIds.length) : passes.length
}

/** Turns the live pitch display on (opening the microphone) or off. */
export async function setShowPitch(on: boolean): Promise<void> {
  if (on) {
    try {
      await openMic(getState().micId)
    } catch (err) {
      getState().notify(`Couldn't open the microphone. ${err instanceof Error ? err.message : ''}`, 'error')
      return
    }
  }
  getState().set({ showPitch: on })
}

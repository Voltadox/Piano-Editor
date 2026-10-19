import type { VocalPreset } from '../model/audio'

/**
 * Effect chains for vocal presets, built from standard Web Audio nodes so the same chain runs
 * live and in an OfflineAudioContext for export.
 */

export interface Chain {
  input: AudioNode
  output: AudioNode
}

const impulses = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>()

/** A synthetic reverb tail: stereo noise fading out, getting darker as it decays. */
function impulse(ctx: BaseAudioContext, seconds: number, damping: number): AudioBuffer {
  let perCtx = impulses.get(ctx)
  if (!perCtx) impulses.set(ctx, (perCtx = new Map()))
  const id = `${seconds}:${damping}`
  const hit = perCtx.get(id)
  if (hit) return hit
  const rate = ctx.sampleRate
  const len = Math.floor(rate * seconds)
  const buf = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate: rate })
  let seed = 12345
  const rand = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch)
    let lp = 0
    for (let i = 0; i < len; i++) {
      const t = i / len
      // one-pole low-pass that closes as the tail decays
      const a = 1 - damping * t * 0.95
      lp = lp + (rand() - lp) * Math.max(0.02, a)
      data[i] = lp * Math.pow(1 - t, 2.2)
    }
  }
  perCtx.set(id, buf)
  return buf
}

function reverb(ctx: BaseAudioContext, seconds: number, damping: number, preDelay: number): { input: AudioNode; output: AudioNode } {
  const pre = ctx.createDelay(1)
  pre.delayTime.value = preDelay
  const conv = ctx.createConvolver()
  conv.buffer = impulse(ctx, seconds, damping)
  pre.connect(conv)
  return { input: pre, output: conv }
}

/** A slowly wobbling short delay: chorus, doubling or tape wow depending on settings. */
function wobble(ctx: BaseAudioContext, base: number, depth: number, rate: number): { input: AudioNode; output: AudioNode } {
  const d = ctx.createDelay(0.1)
  d.delayTime.value = base
  const lfo = ctx.createOscillator()
  lfo.frequency.value = rate
  const amt = ctx.createGain()
  amt.gain.value = depth
  lfo.connect(amt).connect(d.delayTime)
  lfo.start()
  return { input: d, output: d }
}

function gain(ctx: BaseAudioContext, v: number): GainNode {
  const g = ctx.createGain()
  g.gain.value = v
  return g
}

function filter(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q = 0.707): BiquadFilterNode {
  const f = ctx.createBiquadFilter()
  f.type = type
  f.frequency.value = freq
  f.Q.value = q
  return f
}

/** Rounds the wave to a few levels: the gritty, low-bit sound of a cheap digital radio. */
function quantizer(ctx: BaseAudioContext, levels: number): WaveShaperNode {
  const ws = ctx.createWaveShaper()
  const curve = new Float32Array(4096)
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1
    curve[i] = Math.round(x * levels) / levels
  }
  ws.curve = curve
  return ws
}

function saturator(ctx: BaseAudioContext, drive: number): WaveShaperNode {
  const ws = ctx.createWaveShaper()
  const curve = new Float32Array(1024)
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive)
  }
  ws.curve = curve
  return ws
}

/**
 * An echo time that sits on the song's grid: a dotted eighth, a quarter, an eighth or longer,
 * whichever first falls in a slow-echo range. An echo off the beat makes the voice sound out of time.
 */
export function echoTime(beatSec: number): number {
  for (const m of [0.75, 1, 0.5, 1.5, 2]) if (beatSec * m >= 0.28 && beatSec * m <= 0.65) return beatSec * m
  return Math.max(0.1, Math.min(1.9, beatSec * 0.75))
}

/**
 * Builds a preset's chain. `amount` (0..1) blends from nearly dry to the full effect; `beatSec`
 * is the song's beat length, which timed echoes follow.
 */
export function buildChain(ctx: BaseAudioContext, preset: VocalPreset, amount: number, beatSec = 0.5): Chain {
  const input = ctx.createGain()
  const output = ctx.createGain()
  const a = Math.max(0, Math.min(1, amount))
  // rumble and mic thumps never help a vocal
  const rumble = filter(ctx, 'highpass', 110)
  // a gentle vocal compressor: evens out loud and soft phrases so the voice sits up in the mix
  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = -22
  comp.knee.value = 8
  comp.ratio.value = 3
  comp.attack.value = 0.006
  comp.release.value = 0.15
  const hp = gain(ctx, 1.2)
  input.connect(rumble).connect(comp).connect(hp)
  const dry = gain(ctx, 1)
  dry.connect(output)

  const send = (node: { input: AudioNode; output: AudioNode }, level: number, from: AudioNode = hp): void => {
    const g = gain(ctx, level)
    from.connect(g).connect(node.input)
    node.output.connect(output)
  }

  switch (preset) {
    case 'clean': {
      hp.connect(dry)
      send(reverb(ctx, 1.4, 0.6, 0.015), 0.25 * a)
      break
    }
    case 'dreamy': {
      hp.connect(dry)
      dry.gain.value = 1 - 0.35 * a
      send(reverb(ctx, 5.5, 0.85, 0.045), 0.9 * a)
      // a slow, dark echo underneath the reverb, in time with the song
      const echo = ctx.createDelay(2)
      echo.delayTime.value = echoTime(beatSec)
      const fb = gain(ctx, 0.45)
      const tone = filter(ctx, 'lowpass', 2600)
      echo.connect(tone).connect(fb).connect(echo)
      send({ input: echo, output: tone }, 0.35 * a)
      break
    }
    case 'underwater': {
      const lp = filter(ctx, 'lowpass', 1800 - 1100 * a, 0.9)
      hp.connect(lp).connect(dry)
      send(wobble(ctx, 0.018, 0.005, 0.25), 0.7 * a, lp)
      send(reverb(ctx, 3.5, 0.9, 0.03), 0.6 * a, lp)
      break
    }
    case 'tape': {
      const band = filter(ctx, 'lowpass', 5200 - 2200 * a)
      const lowCut = filter(ctx, 'highpass', 180 + 220 * a)
      const sat = saturator(ctx, 1 + 3 * a)
      const wow = wobble(ctx, 0.006, 0.0012 * a, 0.9)
      hp.connect(lowCut).connect(sat).connect(band).connect(wow.input)
      wow.output.connect(dry)
      send(reverb(ctx, 1.8, 0.8, 0.02), 0.3 * a, band)
      break
    }
    case 'radio': {
      // a squad radio: a narrow phone band with a honky middle, driven hard, a little digital grit,
      // squashed flat so it stays loud and even
      dry.gain.value = 1 - a
      hp.connect(dry)
      const band = filter(ctx, 'highpass', 320 + 260 * a, 0.9)
      const honk = ctx.createBiquadFilter()
      honk.type = 'peaking'
      honk.frequency.value = 1700
      honk.Q.value = 1
      honk.gain.value = 4 + 4 * a
      const top = filter(ctx, 'lowpass', 3800 - 1000 * a, 1.1)
      const squash = ctx.createDynamicsCompressor()
      squash.threshold.value = -30
      squash.ratio.value = 8
      squash.attack.value = 0.002
      squash.release.value = 0.08
      const wet = gain(ctx, 0.9 * Math.max(0.15, a))
      hp.connect(band).connect(honk).connect(saturator(ctx, 2 + 6 * a)).connect(quantizer(ctx, Math.round(48 - 32 * a))).connect(top).connect(squash).connect(wet).connect(output)
      break
    }
    case 'haze': {
      hp.connect(dry)
      dry.gain.value = 1 - 0.45 * a
      // two slightly detuned, delayed doubles spread left and right
      for (const [delay, pan] of [
        [0.019, -0.8],
        [0.027, 0.8]
      ]) {
        const dbl = wobble(ctx, delay, 0.0025, 0.35 + Math.abs(pan) * 0.1)
        const p = ctx.createStereoPanner()
        p.pan.value = pan
        dbl.output.connect(p)
        send({ input: dbl.input, output: p }, 0.6 * a)
      }
      send(reverb(ctx, 7, 0.9, 0.06), 1.1 * a)
      break
    }
  }
  return { input, output }
}

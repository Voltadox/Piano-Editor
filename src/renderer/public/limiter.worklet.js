/* global AudioWorkletProcessor, registerProcessor, sampleRate */
// A limiter with no delay. The browser's own compressor looks 6 ms ahead, which is 6 ms added to
// every key you press; this one turns the level down the instant a peak arrives and lets it back
// up slowly, so nothing waits. Channels are turned down together to keep the stereo image.

class KeyfallLimiter extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const o = (options && options.processorOptions) || {}
    this.ceiling = o.ceiling || 0.89
    this.env = 0
    this.release = Math.exp(-1 / (sampleRate * (o.release || 0.12)))
  }

  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]
    if (!input || !input.length) return true
    const n = input[0].length
    const chans = Math.min(input.length, output.length)
    const ceiling = this.ceiling
    let env = this.env
    for (let i = 0; i < n; i++) {
      let peak = 0
      for (let c = 0; c < chans; c++) {
        const a = Math.abs(input[c][i])
        if (a > peak) peak = a
      }
      env = peak > env ? peak : peak + (env - peak) * this.release
      const g = env > ceiling ? ceiling / env : 1
      for (let c = 0; c < chans; c++) output[c][i] = input[c][i] * g
    }
    this.env = env < 1e-9 ? 0 : env
    return true
  }
}

registerProcessor('keyfall-limiter', KeyfallLimiter)

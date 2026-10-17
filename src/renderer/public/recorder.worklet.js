/* global AudioWorkletProcessor, registerProcessor, currentFrame */
// Copies the microphone input out to the main thread, tagged with the audio frame it started on.
class KeyfallRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && ch.length) this.port.postMessage({ frame: currentFrame, data: ch.slice(0) })
    return true
  }
}
registerProcessor('keyfall-recorder', KeyfallRecorder)

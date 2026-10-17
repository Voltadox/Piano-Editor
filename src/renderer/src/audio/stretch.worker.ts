/// <reference lib="webworker" />
import { wsola } from './stretch'

self.onmessage = (e: MessageEvent<{ id: number; channels: Float32Array[]; rate: number; sr: number }>) => {
  const { id, channels, rate, sr } = e.data
  const out = wsola(channels, rate, sr)
  ;(self as unknown as Worker).postMessage({ id, channels: out }, out.map((c) => c.buffer as ArrayBuffer))
}

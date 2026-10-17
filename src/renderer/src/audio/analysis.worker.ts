/// <reference lib="webworker" />
import { analyse, type Analysis } from '../model/analysis'

export type AnalysisReply = { type: 'progress'; value: number } | { type: 'done'; analysis: Analysis } | { type: 'error'; message: string }

const post = (m: AnalysisReply): void => (self as unknown as Worker).postMessage(m)

self.onmessage = (e: MessageEvent<{ pcm: Float32Array; rate: number }>) => {
  try {
    post({ type: 'done', analysis: analyse(e.data.pcm, e.data.rate, (value) => post({ type: 'progress', value })) })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

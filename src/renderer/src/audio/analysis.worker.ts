/// <reference lib="webworker" />
import { analyse, type Analysis } from '../model/analysis'
import { melodyNotes, type SungNote } from '../model/melody'

export type AnalysisRequest = { kind: 'song'; pcm: Float32Array; rate: number } | { kind: 'melody'; pcm: Float32Array; rate: number }

export type AnalysisReply =
  | { type: 'progress'; value: number }
  | { type: 'done'; analysis: Analysis }
  | { type: 'melody'; notes: SungNote[] }
  | { type: 'error'; message: string }

const post = (m: AnalysisReply): void => (self as unknown as Worker).postMessage(m)

self.onmessage = (e: MessageEvent<AnalysisRequest>) => {
  try {
    if (e.data.kind === 'melody') post({ type: 'melody', notes: melodyNotes(e.data.pcm, e.data.rate) })
    else post({ type: 'done', analysis: analyse(e.data.pcm, e.data.rate, (value) => post({ type: 'progress', value })) })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

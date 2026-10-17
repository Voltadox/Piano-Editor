import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  canEncodeAudio,
  canEncodeVideo,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  WebMOutputFormat,
  type AudioCodec,
  type VideoCodec
} from 'mediabunny'
import { engine } from '../audio/engine'
import { buildEvents } from '../audio/events'
import type { RenderReply, RenderRequest } from '../audio/render.worker'
import RenderWorker from '../audio/render.worker?worker'
import { getState } from '../state/store'
import { drawScene, pianoKeyLength } from '../view/draw'

const SAMPLE_RATE = 48000
const TAIL = 2.5

class Cancelled extends Error {}

function render(
  req: Omit<RenderRequest, 'soundfont' | 'events' | 'duration'>,
  onProgress: (p: number) => void,
  signal: AbortSignal
): Promise<Extract<RenderReply, { type: 'done' | 'pcm' }>> {
  const sf = engine.soundfontBytes
  if (!sf) return Promise.reject(new Error('Load a soundfont first. Exports are rendered through it.'))
  const { events, duration } = buildEvents(getState().song)
  return new Promise((resolve, reject) => {
    const worker = new RenderWorker()
    signal.addEventListener('abort', () => {
      worker.terminate()
      reject(new Cancelled())
    })
    worker.onmessage = (e: MessageEvent<RenderReply>) => {
      const m = e.data
      if (m.type === 'progress') onProgress(m.value)
      else {
        worker.terminate()
        if (m.type === 'error') reject(new Error(m.message))
        else resolve(m)
      }
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message))
    }
    const soundfont = sf.slice(0)
    const full: RenderRequest = { ...req, soundfont, events, duration }
    worker.postMessage(full, [soundfont])
  })
}

function startBusy(label: string): AbortController {
  const ctl = new AbortController()
  getState().set({ busy: { label, progress: 0, cancel: () => ctl.abort() } })
  return ctl
}
const progress = (label: string, value: number, ctl: AbortController): void =>
  getState().set({ busy: { label, progress: value, cancel: () => ctl.abort() } })

function finish(err?: unknown): void {
  getState().set({ busy: null })
  if (err instanceof Cancelled) getState().notify('Export cancelled')
  else if (err) getState().notify(`Export failed. ${err instanceof Error ? err.message : String(err)}`, 'error')
}

export async function exportAudio(format: 'wav' | 'mp3', targetPath?: string): Promise<void> {
  const { fileName } = getState()
  if (!engine.soundfontBytes) {
    getState().notify('Load a soundfont first. Exports are rendered through it.', 'error')
    return
  }
  const path = targetPath ?? (await window.keyfall.saveDialog(format, `${fileName}.${format}`))
  if (!path) return
  engine.pause()
  getState().set({ playing: false })
  const ctl = startBusy(`Rendering ${format.toUpperCase()}`)
  try {
    const res = await render(
      { lead: 0, tail: TAIL, sampleRate: SAMPLE_RATE, format, kbps: 256 },
      (p) => progress(`Rendering ${format.toUpperCase()}`, p, ctl),
      ctl.signal
    )
    if (res.type !== 'done') throw new Error('Unexpected render result')
    const saved = await window.keyfall.writeFile(path, res.data)
    finish()
    getState().notify(`Exported ${saved.name}`)
  } catch (err) {
    finish(err)
  }
}

export interface VideoPreset {
  id: string
  label: string
  width: number
  height: number
}
export const VIDEO_PRESETS: VideoPreset[] = [
  { id: '1080p', label: '1080p landscape (1920×1080)', width: 1920, height: 1080 },
  { id: '720p', label: '720p landscape (1280×720)', width: 1280, height: 720 },
  { id: 'vertical', label: 'Vertical for Shorts/Reels (1080×1920)', width: 1080, height: 1920 }
]

interface VideoFormat {
  container: 'mp4' | 'webm'
  video: VideoCodec
  audio: AudioCodec
}

async function pickFormat(width: number, height: number): Promise<VideoFormat | null> {
  const audio = { numberOfChannels: 2, sampleRate: SAMPLE_RATE }
  if ((await canEncodeVideo('avc', { width, height })) && (await canEncodeAudio('aac', audio)))
    return { container: 'mp4', video: 'avc', audio: 'aac' }
  for (const video of ['vp9', 'vp8'] as const)
    if ((await canEncodeVideo(video, { width, height })) && (await canEncodeAudio('opus', audio)))
      return { container: 'webm', video, audio: 'opus' }
  return null
}

export async function exportVideo(preset: VideoPreset, fps = 60, targetDir?: string): Promise<void> {
  const { fileName, song } = getState()
  if (!engine.soundfontBytes) {
    getState().notify('Load a soundfont first. Exports are rendered through it.', 'error')
    return
  }
  const { width, height } = preset
  const fmt = await pickFormat(width, height)
  if (!fmt) {
    getState().notify('This computer has no video encoder available for export.', 'error')
    return
  }
  const path = targetDir
    ? `${targetDir}/${fileName}.${fmt.container}`
    : await window.keyfall.saveDialog(fmt.container, `${fileName}.${fmt.container}`)
  if (!path) return
  engine.pause()
  getState().set({ playing: false })

  const lead = 2
  const ctl = startBusy('Rendering audio')
  try {
    const pcm = await render(
      { lead, tail: TAIL, sampleRate: SAMPLE_RATE, format: 'pcm' },
      (p) => progress('Rendering audio', p * 0.25, ctl),
      ctl.signal
    )
    if (pcm.type !== 'pcm') throw new Error('Unexpected render result')

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { alpha: false })!
    const output = new Output({
      format: fmt.container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
      target: new BufferTarget()
    })
    const video = new CanvasSource(canvas, { codec: fmt.video, quality: QUALITY_HIGH })
    const audio = new AudioBufferSource({ codec: fmt.audio, quality: QUALITY_HIGH })
    output.addVideoTrack(video, { frameRate: fps })
    output.addAudioTrack(audio)
    await output.start()

    const total = pcm.left.length
    const totalSec = total / SAMPLE_RATE
    const frames = Math.ceil(totalSec * fps)
    const kbH = Math.round(Math.max(height * (height > width ? 0.09 : 0.15), pianoKeyLength(width)))
    const pxPerSec = (height - kbH) / (height > width ? 4 : 2.6)
    let audioDone = 0
    const pushAudio = async (untilSec: number): Promise<void> => {
      const end = Math.min(total, Math.ceil(untilSec * SAMPLE_RATE))
      if (end <= audioDone) return
      const buf = new AudioBuffer({ length: end - audioDone, numberOfChannels: 2, sampleRate: SAMPLE_RATE })
      buf.copyToChannel(pcm.left.subarray(audioDone, end) as Float32Array<ArrayBuffer>, 0)
      buf.copyToChannel(pcm.right.subarray(audioDone, end) as Float32Array<ArrayBuffer>, 1)
      audioDone = end
      await audio.add(buf)
    }

    for (let i = 0; i < frames; i++) {
      if (ctl.signal.aborted) {
        await output.cancel()
        throw new Cancelled()
      }
      const ts = i / fps
      await pushAudio(ts + 1)
      drawScene(ctx, { song, width, height, time: ts - lead, pxPerSec, keyboardHeight: kbH, presentation: true })
      drawTitle(ctx, fileName, width, ts)
      await video.add(ts, 1 / fps)
      if (i % 15 === 0) progress(`Encoding video · frame ${i.toLocaleString()} of ${frames.toLocaleString()}`, 0.25 + (0.75 * i) / frames, ctl)
    }
    await pushAudio(totalSec + 1)
    video.close()
    audio.close()
    await output.finalize()
    const saved = await window.keyfall.writeFile(path, new Uint8Array(output.target.buffer!))
    finish()
    getState().notify(`Exported ${saved.name}`)
  } catch (err) {
    finish(err)
  }
}

function drawTitle(ctx: CanvasRenderingContext2D, title: string, width: number, ts: number): void {
  const alpha = ts < 2 ? 1 : Math.max(0, 1 - (ts - 2) / 0.8)
  if (alpha <= 0) return
  const size = Math.round(width / 28)
  ctx.globalAlpha = alpha
  ctx.fillStyle = '#e4e7f2'
  ctx.font = `700 ${size}px "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(title, width / 2, size * 2.2)
  ctx.textAlign = 'left'
  ctx.globalAlpha = 1
}

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
import type { Song } from '../model/song'
import { drawScene, pianoKeyLength } from '../view/draw'
import type { Theme } from '../view/theme'

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
  { id: '1080p', label: '1080p (1920×1080)', width: 1920, height: 1080 },
  { id: '720p', label: '720p (1280×720)', width: 1280, height: 720 },
  { id: '2160p', label: '4K (3840×2160)', width: 3840, height: 2160 },
  { id: 'vertical', label: 'Vertical for Shorts/Reels (1080×1920)', width: 1080, height: 1920 }
]

export interface VideoSettings {
  style: 'falling' | 'rising'
  size: string
  fps: 30 | 60
  titleCard: boolean
  /** blank uses the file name */
  title: string
  artist: string
  caption: string
}

export const DEFAULT_VIDEO: VideoSettings = {
  style: 'falling',
  size: '1080p',
  fps: 60,
  titleCard: true,
  title: '',
  artist: '',
  caption: ''
}

/** Seconds of empty stage before the first note, while the title card shows. */
export const VIDEO_LEAD = 2

export const presetFor = (v: VideoSettings): VideoPreset => VIDEO_PRESETS.find((p) => p.id === v.size) ?? VIDEO_PRESETS[0]

export interface VideoFrame {
  song: Song
  settings: VideoSettings
  theme: Theme
  bgImage: ImageBitmap | null
  fileName: string
  width: number
  height: number
  /** seconds since the start of the video */
  ts: number
}

/** One frame of the exported video; the export dialog's preview draws the same thing. */
export function drawVideoFrame(ctx: CanvasRenderingContext2D, f: VideoFrame): void {
  const { width, height } = f
  const portrait = height > width
  const kbH = Math.round(Math.max(height * (portrait ? 0.09 : 0.15), pianoKeyLength(width)))
  const pxPerSec = (height - kbH) / (portrait ? 4 : 2.6)
  drawScene(ctx, {
    song: f.song,
    width,
    height,
    time: f.ts - VIDEO_LEAD,
    pxPerSec,
    keyboardHeight: kbH,
    rising: f.settings.style === 'rising',
    theme: f.theme,
    bgImage: f.bgImage,
    presentation: true
  })
  if (f.settings.titleCard) drawTitle(ctx, f, f.settings.title.trim() || f.fileName)
}

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

export async function exportVideo(settings: VideoSettings, targetDir?: string): Promise<void> {
  const { fileName, song, theme, bgImage } = getState()
  const preset = presetFor(settings)
  const { fps } = settings
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

  const lead = VIDEO_LEAD
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
      drawVideoFrame(ctx, { song, settings, theme, bgImage, fileName, width, height, ts })
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

/** Title, artist and caption over the opening seconds, fading out as the first notes arrive. */
function drawTitle(ctx: CanvasRenderingContext2D, f: VideoFrame, title: string): void {
  const alpha = f.ts < VIDEO_LEAD ? 1 : Math.max(0, 1 - (f.ts - VIDEO_LEAD) / 0.8)
  if (alpha <= 0) return
  const { width, height } = f
  const size = Math.round(Math.min(width, height * 1.6) / 22)
  const cx = width / 2
  let y = height * (height > width ? 0.2 : 0.16)
  ctx.globalAlpha = alpha
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = size * 0.4
  ctx.fillStyle = '#f2f4fa'
  ctx.font = `700 ${size}px "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif`
  ctx.fillText(title, cx, y, width * 0.9)
  const artist = f.settings.artist.trim()
  if (artist) {
    y += size * 1.05
    ctx.fillStyle = 'rgba(228,231,242,0.8)'
    ctx.font = `500 ${Math.round(size * 0.5)}px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`
    ctx.fillText(artist, cx, y, width * 0.9)
  }
  const caption = f.settings.caption.trim()
  if (caption) {
    y += size * 1.05
    const cs = Math.round(size * 0.38)
    ctx.font = `600 ${cs}px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`
    const w = Math.min(width * 0.9, ctx.measureText(caption).width + cs * 1.6)
    ctx.shadowBlur = 0
    ctx.fillStyle = f.theme.accent
    ctx.beginPath()
    ctx.roundRect(cx - w / 2, y - cs, w, cs * 2, cs)
    ctx.fill()
    ctx.fillStyle = '#0a0c14'
    ctx.fillText(caption, cx, y + 1, w - cs)
  }
  ctx.shadowBlur = 0
  ctx.shadowColor = 'transparent'
  ctx.textAlign = 'left'
  ctx.globalAlpha = 1
}

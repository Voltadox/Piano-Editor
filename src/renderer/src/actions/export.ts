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
import type { EncodeRequest, RenderReply, RenderRequest } from '../audio/render.worker'
import { toBuffer } from '../audio/takes'
import { buildChain } from '../audio/vocalChain'
import { clipAudio, processAll, vocalLines } from '../audio/vocals'
import { audioAudible, tempoMap } from '../model/song'
import type { AudioTrack } from '../model/audio'
import { writeMidiFile } from '../model/midiio'
import RenderWorker from '../audio/render.worker?worker'
import { getState } from '../state/store'
import type { Song } from '../model/song'
import { drawScene, lyricsAt, pianoKeyLength } from '../view/draw'
import type { Theme } from '../view/theme'

const SAMPLE_RATE = 48000
const TAIL = 2.5

class Cancelled extends Error {}

/** Renders a song's notes (the open song unless given), at least `minDuration` seconds long. */
function render(
  req: Omit<RenderRequest, 'soundfont' | 'backup' | 'events' | 'duration'>,
  onProgress: (p: number) => void,
  signal: AbortSignal,
  song: Song = getState().song,
  minDuration = 0
): Promise<Extract<RenderReply, { type: 'done' | 'pcm' }>> {
  if (!engine.hasSound) return Promise.reject(new Error('Load a soundfont first. Exports are rendered through it.'))
  const built = buildEvents(song)
  const events = built.events
  // vocals can run past the last note
  const duration = Math.max(built.duration, vocalEnd(song), minDuration)
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
    const soundfont = engine.soundfontBytes?.slice(0) ?? null
    const backup = engine.backupBytes?.slice(0) ?? null
    const full: RenderRequest = { ...req, soundfont, backup, events, duration }
    worker.postMessage(full, [soundfont, backup].filter((b): b is ArrayBuffer => b !== null))
  })
}

const hasVocals = (song: Song): boolean => song.audioTracks.some((t) => t.clips.length && audioAudible(t, song))

function vocalEnd(song: Song): number {
  const map = tempoMap(song)
  let end = 0
  for (const t of song.audioTracks) for (const c of t.clips) end = Math.max(end, map.tickToSec(c.tick) + c.duration)
  return end
}

/**
 * Mixes the song's audible audio tracks (vocals tuned and through their effects) over the rendered
 * notes; with `only`, just those tracks, whether muted or not.
 */
async function mixVocals(song: Song, left: Float32Array, right: Float32Array, lead: number, only?: AudioTrack[]): Promise<{ left: Float32Array; right: Float32Array }> {
  await processAll(song)
  const len = left.length
  const ctx = new OfflineAudioContext(2, len, SAMPLE_RATE)
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -3
  limiter.knee.value = 3
  limiter.ratio.value = 12
  limiter.attack.value = 0.003
  limiter.release.value = 0.15
  limiter.connect(ctx.destination)
  const bed = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate: SAMPLE_RATE })
  bed.copyToChannel(left as Float32Array<ArrayBuffer>, 0)
  bed.copyToChannel(right as Float32Array<ArrayBuffer>, 1)
  const notes = ctx.createBufferSource()
  notes.buffer = bed
  notes.connect(limiter)
  notes.start(0)
  const map = tempoMap(song)
  for (const t of only ?? song.audioTracks.filter((x) => audioAudible(x, song))) {
    if (!t.clips.length) continue
    const chain = t.kind && t.kind !== 'vocal' ? (() => { const g = ctx.createGain(); return { input: g, output: g } })() : buildChain(ctx, t.preset, t.amount, 60 / map.bpmAt(0))
    const vol = ctx.createGain()
    vol.gain.value = t.volume
    const pan = ctx.createStereoPanner()
    pan.pan.value = t.pan
    chain.output.connect(vol).connect(pan).connect(limiter)
    for (const c of t.clips) {
      const a = clipAudio(song, t, c)
      if (!a) continue
      const src = ctx.createBufferSource()
      src.buffer = toBuffer(ctx, a.pcm, a.rate, a.right)
      const g = ctx.createGain()
      const at = lead + map.tickToSec(c.tick)
      g.gain.setValueAtTime(0, at)
      g.gain.linearRampToValueAtTime(1, at + Math.max(0.005, c.fadeIn))
      g.gain.setValueAtTime(1, at + Math.max(0, c.duration - c.fadeOut))
      g.gain.linearRampToValueAtTime(0, at + c.duration)
      src.connect(g).connect(chain.input)
      src.start(at, c.offset, c.duration)
    }
  }
  const out = await ctx.startRendering()
  return { left: out.getChannelData(0).slice(), right: out.getChannelData(1).slice() }
}

function encode(req: EncodeRequest, signal: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new RenderWorker()
    signal.addEventListener('abort', () => {
      worker.terminate()
      reject(new Cancelled())
    })
    worker.onmessage = (e: MessageEvent<RenderReply>) => {
      if (e.data.type === 'progress') return
      worker.terminate()
      if (e.data.type === 'done') resolve(e.data.data)
      else reject(new Error(e.data.type === 'error' ? e.data.message : 'Unexpected encode result'))
    }
    worker.postMessage(req, [req.left.buffer, req.right.buffer])
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
  if (!engine.hasSound) {
    getState().notify('Load a soundfont first. Exports are rendered through it.', 'error')
    return
  }
  const path = targetPath ?? (await window.keyfall.saveDialog(format, `${fileName}.${format}`))
  if (!path) return
  engine.pause()
  getState().set({ playing: false })
  const ctl = startBusy(`Rendering ${format.toUpperCase()}`)
  try {
    const song = getState().song
    let data: Uint8Array
    if (hasVocals(song)) {
      // notes first, then the vocals mixed over them, then the file is encoded
      const pcm = await render({ lead: 0, tail: TAIL, sampleRate: SAMPLE_RATE, format: 'pcm' }, (p) => progress('Rendering notes', p * 0.6, ctl), ctl.signal)
      if (pcm.type !== 'pcm') throw new Error('Unexpected render result')
      progress('Tuning and mixing vocals', 0.65, ctl)
      const mix = await mixVocals(song, pcm.left, pcm.right, 0)
      progress(`Encoding ${format.toUpperCase()}`, 0.85, ctl)
      data = await encode({ encode: true, left: mix.left, right: mix.right, sampleRate: SAMPLE_RATE, format, kbps: 256 }, ctl.signal)
    } else {
      const res = await render(
        { lead: 0, tail: TAIL, sampleRate: SAMPLE_RATE, format, kbps: 256 },
        (p) => progress(`Rendering ${format.toUpperCase()}`, p, ctl),
        ctl.signal
      )
      if (res.type !== 'done') throw new Error('Unexpected render result')
      data = res.data
    }
    const saved = await window.keyfall.writeFile(path, data)
    finish()
    getState().notify(`Exported ${saved.name}`)
  } catch (err) {
    finish(err)
  }
}

// ---------- single tracks and stems ----------

export type TrackRef = { kind: 'notes' | 'audio'; id: number }
export type TrackFormat = 'mid' | 'mp3' | 'wav'

/** A name that's safe in a file name. */
const safeName = (s: string): string => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim() || 'Track'

function trackOf(song: Song, ref: TrackRef): { name: string; empty: boolean } | null {
  if (ref.kind === 'notes') {
    const t = song.tracks.find((x) => x.id === ref.id)
    return t ? { name: t.name, empty: !t.notes.length } : null
  }
  const t = song.audioTracks.find((x) => x.id === ref.id)
  return t ? { name: t.name, empty: !t.clips.length } : null
}

/**
 * One track on its own, as a file. Audio starts at the top of the song and runs the song's full
 * length, so stems line up when they're dropped into another program together. Each keeps its
 * own level, pan and effects (vocals tuned), whether or not it's muted here.
 */
async function trackFile(song: Song, ref: TrackRef, format: TrackFormat, onProgress: (p: number) => void, signal: AbortSignal): Promise<Uint8Array> {
  const length = Math.max(buildEvents(song).duration, vocalEnd(song))
  if (ref.kind === 'notes') {
    const t = song.tracks.find((x) => x.id === ref.id)!
    // guide tracks (notes to sing) are silent here, but on their own they should be heard
    const alone = { ...t, muted: false, solo: false, silent: false }
    if (format === 'mid') return writeMidiFile({ ...song, tracks: [alone] }, t.name)
    const res = await render({ lead: 0, tail: TAIL, sampleRate: SAMPLE_RATE, format, kbps: 256 }, onProgress, signal, { ...song, tracks: [alone], audioTracks: [] }, length)
    if (res.type !== 'done') throw new Error('Unexpected render result')
    return res.data
  }
  const t = song.audioTracks.find((x) => x.id === ref.id)!
  const len = Math.ceil((length + TAIL) * SAMPLE_RATE)
  onProgress(0.2)
  const mix = await mixVocals(song, new Float32Array(len), new Float32Array(len), 0, [t])
  onProgress(0.7)
  return encode({ encode: true, left: mix.left, right: mix.right, sampleRate: SAMPLE_RATE, format: format === 'mid' ? 'mp3' : format, kbps: 256 }, signal)
}

/** Exports one track (note track as MIDI, MP3 or WAV; audio track as MP3 or WAV), asking where to save it. */
export async function exportTrack(ref: TrackRef, format: TrackFormat): Promise<void> {
  const { song, fileName } = getState()
  const t = trackOf(song, ref)
  if (!t) return
  if (t.empty) {
    getState().notify(`${t.name} has nothing in it to export yet.`)
    return
  }
  if (format !== 'mid' && ref.kind === 'notes' && !engine.hasSound) {
    getState().notify('Load a soundfont first. Note tracks are rendered through it (or export them as MIDI).', 'error')
    return
  }
  const path = await window.keyfall.saveDialog(format === 'mid' ? 'midi' : format, `${safeName(fileName)} - ${safeName(t.name)}.${format}`)
  if (!path) return
  engine.pause()
  getState().set({ playing: false })
  const label = `Exporting ${t.name}`
  const ctl = startBusy(label)
  try {
    const data = await trackFile(song, ref, format, (p) => progress(label, p, ctl), ctl.signal)
    const saved = await window.keyfall.writeFile(path, data)
    finish()
    getState().notify(`Exported ${saved.name}`)
  } catch (err) {
    finish(err)
  }
}

/** How every track is written by "Export all tracks". */
export type StemsChoice = 'mp3' | 'wav' | 'midi+mp3'

/**
 * Writes every track that has something in it into a folder: as MP3 or WAV stems, or with note
 * tracks as MIDI and audio tracks as MP3.
 */
export async function exportAllTracks(choice: StemsChoice, folder?: string): Promise<void> {
  const { song, fileName } = getState()
  const refs: TrackRef[] = [
    ...song.tracks.filter((t) => t.notes.length).map((t) => ({ kind: 'notes' as const, id: t.id })),
    ...song.audioTracks.filter((t) => t.clips.length).map((t) => ({ kind: 'audio' as const, id: t.id }))
  ]
  if (!refs.length) {
    getState().notify('There are no tracks with anything in them to export yet.')
    return
  }
  const formatOf = (r: TrackRef): TrackFormat => (choice === 'midi+mp3' ? (r.kind === 'notes' ? 'mid' : 'mp3') : choice)
  if (refs.some((r) => r.kind === 'notes' && formatOf(r) !== 'mid') && !engine.hasSound) {
    getState().notify('Load a soundfont first. Note tracks are rendered through it (or choose MIDI for note tracks).', 'error')
    return
  }
  const dir = folder ?? (await window.keyfall.pickFolder())
  if (!dir) return
  engine.pause()
  getState().set({ playing: false })
  const ctl = startBusy('Exporting tracks')
  const used = new Set<string>()
  const sep = dir.includes('\\') ? '\\' : '/'
  try {
    for (let i = 0; i < refs.length; i++) {
      const r = refs[i]
      const name = trackOf(song, r)!.name
      const label = `Exporting ${name} (${i + 1} of ${refs.length})`
      const data = await trackFile(song, r, formatOf(r), (p) => progress(label, (i + p) / refs.length, ctl), ctl.signal)
      // two tracks with one name get numbered rather than overwriting each other
      let file = `${safeName(fileName)} - ${safeName(name)}`
      for (let n = 2; used.has(file.toLowerCase()); n++) file = `${safeName(fileName)} - ${safeName(name)} (${n})`
      used.add(file.toLowerCase())
      await window.keyfall.writeFile(`${dir}${sep}${file}.${formatOf(r)}`, data)
    }
    finish()
    getState().notify(`Exported ${refs.length} track${refs.length === 1 ? '' : 's'} to ${dir}`)
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
  /** show the song's lyrics karaoke-style */
  lyrics: boolean
}

export const DEFAULT_VIDEO: VideoSettings = {
  style: 'falling',
  size: '1080p',
  fps: 60,
  titleCard: true,
  title: '',
  artist: '',
  caption: '',
  lyrics: true
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
  vocals?: ReturnType<typeof vocalLines>
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
    vocals: f.vocals,
    lyrics:
      f.settings.lyrics && f.song.lyrics.length
        ? lyricsAt(
            f.song.lyrics.map((l) => ({ start: tempoMap(f.song).tickToSec(l.tick), end: tempoMap(f.song).tickToSec(l.end), text: l.text })),
            f.ts - VIDEO_LEAD
          )
        : null,
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
  if (!engine.hasSound) {
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
    const notesPcm = await render(
      { lead, tail: TAIL, sampleRate: SAMPLE_RATE, format: 'pcm' },
      (p) => progress('Rendering audio', p * 0.2, ctl),
      ctl.signal
    )
    if (notesPcm.type !== 'pcm') throw new Error('Unexpected render result')
    let pcm = { left: notesPcm.left, right: notesPcm.right }
    if (hasVocals(song)) {
      progress('Tuning and mixing vocals', 0.22, ctl)
      pcm = await mixVocals(song, pcm.left, pcm.right, lead)
    }
    const vocals = vocalLines(song)

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
      drawVideoFrame(ctx, { song, settings, theme, bgImage, fileName, width, height, ts, vocals })
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

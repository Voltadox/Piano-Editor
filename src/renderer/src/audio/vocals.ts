import type { AudioClip, AudioTrack } from '../model/audio'
import { guideLine, scaleOf, songKey } from '../model/guide'
import { tempoMap, type Song } from '../model/song'
import { useStore } from '../state/store'
import { HOP_SEC, type TuneSettings } from './pitch'
import { ensureTakes, getTake, type TakeData } from './takes'
import type { TuneReply, TuneRequest } from './tune.worker'
import TuneWorker from './tune.worker?worker'

/**
 * Autotuned versions of each clip's active take, made in a worker and cached by their settings.
 * Until a version is ready the raw take plays; a store tick tells views to redraw.
 */

interface Processed {
  key: string
  pcm: Float32Array
  rate: number
  /** output pitch per 10 ms frame (MIDI, NaN unvoiced) */
  pitch: Float32Array
}

const done = new Map<string, Processed>()
const f0Cache = new Map<string, Float32Array>()
const pending = new Map<string, Promise<Processed | null>>()
let worker: Worker | null = null
let nextJob = 1
const waiting = new Map<number, (r: TuneReply) => void>()

function getWorker(): Worker {
  if (!worker) {
    worker = new TuneWorker()
    worker.onmessage = (e: MessageEvent<TuneReply>) => {
      waiting.get(e.data.id)?.(e.data)
      waiting.delete(e.data.id)
    }
  }
  return worker
}

function hash(a: Float32Array | undefined): number {
  if (!a) return 0
  let h = 5381
  for (let i = 0; i < a.length; i++) h = (h * 33 + (Number.isNaN(a[i]) ? 7 : Math.round(a[i]))) | 0
  return h
}

const settingsCache = new WeakMap<AudioClip, { track: AudioTrack; tracks: Song['tracks']; tempos: Song['tempos']; key: Song['key']; take: TakeData; s: TuneSettings }>()

/** What a clip's take should be processed with: the track's tune and voice settings, plus the key or guide line. */
export function tuneSettings(song: Song, track: AudioTrack, clip: AudioClip, take: TakeData): TuneSettings {
  const hit = settingsCache.get(clip)
  if (hit && hit.track === track && hit.tracks === song.tracks && hit.tempos === song.tempos && hit.key === song.key && hit.take === take) return hit.s
  const s = buildSettings(song, track, clip, take)
  settingsCache.set(clip, { track, tracks: song.tracks, tempos: song.tempos, key: song.key, take, s })
  return s
}

function buildSettings(song: Song, track: AudioTrack, clip: AudioClip, take: TakeData): TuneSettings {
  const scale = scaleOf(songKey(song))
  const settings: TuneSettings = {
    mode: track.tune.mode,
    speed: track.tune.speed,
    scale,
    transpose: track.transpose,
    detune: track.detune,
    formant: track.formant
  }
  if (track.tune.mode === 'guide') {
    const startSec = tempoMap(song).tickToSec(clip.tick) - clip.offset
    const frames = Math.ceil(take.pcm.length / (take.rate * HOP_SEC))
    settings.guide = guideLine(song, track.tune.voice, track.tune.centre, startSec, frames, HOP_SEC)
  }
  return settings
}

const keyOf = (takeId: string, s: TuneSettings): string =>
  [takeId, s.mode, s.speed.toFixed(2), s.transpose, s.detune, s.formant.toFixed(2), s.scale.join('.'), hash(s.guide)].join('|')

/** The audio to play for a clip right now: its processed take if ready, else the raw take (and start processing). */
export function clipAudio(song: Song, track: AudioTrack, clip: AudioClip): { pcm: Float32Array; rate: number; pitch?: Float32Array } | null {
  const takeId = clip.takes[clip.active]
  const take = takeId ? getTake(takeId) : undefined
  if (!take) return null
  const settings = tuneSettings(song, track, clip, take)
  const key = keyOf(takeId, settings)
  const ready = done.get(key)
  if (ready) return ready
  void process(takeId, take, settings, key)
  return take
}

/** Processes a take (once per distinct settings) and resolves when it's ready. */
export function process(takeId: string, take: TakeData, settings: TuneSettings, key = keyOf(takeId, settings)): Promise<Processed | null> {
  const hit = done.get(key)
  if (hit) return Promise.resolve(hit)
  let p = pending.get(key)
  if (p) return p
  p = new Promise<Processed | null>((resolve) => {
    const id = nextJob++
    waiting.set(id, (r) => {
      pending.delete(key)
      if (!r.pcm || !r.pitch) return resolve(null)
      if (r.f0) f0Cache.set(takeId, r.f0)
      const result = { key, pcm: r.pcm, rate: take.rate, pitch: r.pitch }
      done.set(key, result)
      // ping views so the new pitch line and audio are picked up
      useStore.setState((s) => ({ vocalVersion: s.vocalVersion + 1 }))
      resolve(result)
    })
    const req: TuneRequest = { id, pcm: take.pcm, rate: take.rate, settings, f0: f0Cache.get(takeId) }
    getWorker().postMessage(req)
  })
  pending.set(key, p)
  return p
}

/** Processes every clip in the song and waits for all of it (used before exporting). */
export async function processAll(song: Song): Promise<void> {
  const jobs: Promise<unknown>[] = []
  for (const t of song.audioTracks)
    for (const c of t.clips) {
      const takeId = c.takes[c.active]
      const take = takeId ? getTake(takeId) : undefined
      if (take) jobs.push(process(takeId, take, tuneSettings(song, t, c, take)))
    }
  await Promise.all(jobs)
}

/** The tuned pitch line for a clip, if it has been worked out. */
export function clipPitch(song: Song, track: AudioTrack, clip: AudioClip): Float32Array | null {
  const a = clipAudio(song, track, clip)
  return a && 'pitch' in a && a.pitch ? a.pitch : null
}

/** How many takes are still being autotuned. */
export const tuningCount = (): number => pending.size

/** Loads takes a song refers to that are only on disk (after opening or recovering a song). */
export function watchTakes(): () => void {
  const check = (song: Song): void => {
    const need = [...new Set(song.audioTracks.flatMap((t) => t.clips.flatMap((c) => c.takes)))].filter((id) => !getTake(id))
    if (!need.length) return
    void ensureTakes(need).then((missing) => {
      useStore.setState((s) => ({ vocalVersion: s.vocalVersion + 1 }))
      if (missing.length) useStore.getState().notify(`${missing.length} recorded take${missing.length === 1 ? '' : 's'} couldn't be found on disk.`, 'error')
    })
  }
  check(useStore.getState().song)
  return useStore.subscribe((s, p) => {
    if (s.song.audioTracks !== p.song.audioTracks) check(s.song)
  })
}

/** Every clip's tuned pitch line, placed on the song timeline, for drawing. */
export function vocalLines(song: Song): { color: string; origin: number; from: number; to: number; pitch: Float32Array }[] {
  const map = tempoMap(song)
  const out: { color: string; origin: number; from: number; to: number; pitch: Float32Array }[] = []
  for (const t of song.audioTracks) {
    if (t.muted) continue
    for (const c of t.clips) {
      const pitch = clipPitch(song, t, c)
      if (!pitch) continue
      const from = map.tickToSec(c.tick)
      out.push({ color: t.color, origin: from - c.offset, from, to: from + c.duration, pitch })
    }
  }
  return out
}

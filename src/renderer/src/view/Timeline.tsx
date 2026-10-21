import { useEffect, useRef, useState } from 'react'
import { engine } from '../audio/engine'
import { getTake } from '../audio/takes'
import { clearTimelineRange, cropTimelineRange, loopTimelineRange, removeTimelineBars, repeatTimelineRange, toggleTimeline } from '../actions/timeline'
import { setLoop } from '../actions/transport'
import { arrangeEnd, moveClip, moveRange, songAudio, TIMELINE_SNAPS, trimClip, trimNotes, type Range, type TimelineSnap } from '../model/timeline'
import { audioAudible, isAudible, lowerBound, snapTicks, tempoMap, ticksPerBar, ticksPerBeat, trackTimes, type Song, type Track } from '../model/song'
import { pickTrack, updateTrack } from '../state/edit'
import { savePref } from '../state/prefs'
import { getState, useStore } from '../state/store'
import { updateAudioTrack } from '../state/vocalEdit'

/**
 * The timeline: every track as a lane running left to right, like a video editor's, for working
 * on the song in big pieces. Drag across lanes to pick a stretch, then drag it somewhere else,
 * clear it, repeat it, crop to it or take it out of the song. Clips and note blocks are cropped by
 * their edges, and audio clips dragged along by the strip along their top. Everything snaps to
 * the timeline's grid, or moves freely with Alt held. The falling-notes stage stays the place for notes.
 */

/** lane height; the header column and ruler sizes are in the stylesheet */
const LANE_H = 58
const MAX_PPS = 600
/** the strip along the top of an audio clip that drags it */
const GRIP_H = 14
/** how near a clip's or block's edge (pixels) the pointer crops it */
const EDGE = 6

interface Lane {
  kind: 'notes' | 'audio'
  id: number
  name: string
  color: string
  tag: string
  muted: boolean
  solo: boolean
  /** shown but not played (notes to sing) */
  silent: boolean
}

function lanesOf(song: Song): Lane[] {
  const tag = (t: Track): string => (t.beat ? 'Beat' : t.beatbox ? 'Beatbox' : t.remake ? 'Remake' : t.silent ? 'To sing' : t.role === 'chords' ? 'Chords' : 'MIDI')
  return [
    ...song.tracks.map((t) => ({ kind: 'notes' as const, id: t.id, name: t.name, color: t.color, tag: tag(t), muted: t.muted, solo: t.solo, silent: !!t.silent })),
    ...song.audioTracks.map((t) => ({
      kind: 'audio' as const,
      id: t.id,
      name: t.name,
      color: t.color,
      tag: t.kind === 'reference' ? 'Song' : t.kind === 'stem' ? 'Stem' : t.kind === 'beatbox' ? 'Beatbox' : 'Vocal',
      muted: t.muted,
      solo: t.solo,
      silent: false
    }))
  ]
}

/** A #rrggbb colour see-through by `a` (0..1). */
const alpha = (color: string, a: number): string =>
  /^#[0-9a-f]{6}$/i.test(color) ? color + Math.round(a * 255).toString(16).padStart(2, '0') : color

/** Each track's lowest and highest note, so its notes fill its lane. */
const pitchSpan = new WeakMap<Track['notes'], { lo: number; hi: number }>()
function spanOf(t: Track): { lo: number; hi: number } {
  let s = pitchSpan.get(t.notes)
  if (!s) {
    let lo = 127
    let hi = 0
    for (const n of t.notes) {
      lo = Math.min(lo, n.pitch)
      hi = Math.max(hi, n.pitch)
    }
    s = lo > hi ? { lo: 60, hi: 60 } : { lo, hi }
    pitchSpan.set(t.notes, s)
  }
  return s
}

/**
 * Runs of notes (ticks, from the first note's start to the last one's end), split wherever a bar
 * or more goes quiet, drawn as blocks like a video editor's clips.
 */
const blockCache = new WeakMap<Track['notes'], [number, number][]>()
function blocksOf(t: Track, bar: number): [number, number][] {
  let b = blockCache.get(t.notes)
  if (!b) {
    b = []
    for (const n of t.notes) {
      const last = b[b.length - 1]
      const end = n.tick + Math.max(1, n.dur)
      if (last && n.tick < last[1] + bar) last[1] = Math.max(last[1], end)
      else b.push([n.tick, end])
    }
    blockCache.set(t.notes, b)
  }
  return b
}

/** The timeline's grid in ticks (1 when it is off, or `free`: Alt is held). */
function gridOf(s: Song, snap: TimelineSnap, free: boolean): number {
  if (free || snap === 'off') return 1
  return snap === 'bar' ? ticksPerBar(s) : snap === 'beat' ? ticksPerBeat(s) : snapTicks(s.ppq, snap)
}

/** The edge of a clip or note block that a drag crops. */
interface Edge {
  lane: number
  kind: 'notes' | 'audio'
  trackId: number
  clipId: number
  edge: 'start' | 'end'
  /** the block's (or clip's) extent, in ticks */
  from: number
  to: number
}

/** Loudest sample per block of a take, for drawing its waveform. */
const PEAK = 256
const peakCache = new Map<string, Float32Array>()
function peaksOf(takeId: string): Float32Array | null {
  const hit = peakCache.get(takeId)
  if (hit) return hit
  const take = getTake(takeId)
  if (!take) return null
  const n = Math.ceil(take.pcm.length / PEAK)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let m = 0
    for (let k = i * PEAK; k < Math.min(take.pcm.length, (i + 1) * PEAK); k++) {
      const v = Math.abs(take.pcm[k]) + (take.right ? Math.abs(take.right[k]) : 0)
      if (v > m) m = v
    }
    out[i] = take.right ? m / 2 : m
  }
  peakCache.set(takeId, out)
  return out
}

export function Timeline(): React.JSX.Element {
  const song = useStore((s) => s.song)
  const range = useStore((s) => s.tlRange)
  const lanes = lanesOf(song)
  const wrapRef = useRef<HTMLDivElement>(null)
  const rulerRef = useRef<HTMLCanvasElement>(null)
  const lanesRef = useRef<HTMLCanvasElement>(null)
  /** seconds at the left edge, and pixels per second */
  const view = useRef({ start: 0, pps: 0 })
  const [scrollY, setScrollY] = useState(0)
  const scrollRef = useRef(0)
  scrollRef.current = scrollY
  const drag = useRef<
    | { kind: 'range'; x0: number; lane: number; tick0: number; moved: boolean; free: boolean }
    | { kind: 'seek' }
    | { kind: 'loop'; tick0: number }
    | { kind: 'clip'; x0: number; lane: number; trackId: number; clipId: number; tick0: number; base: Song; moved: boolean }
    | { kind: 'move'; x0: number; lane: number; r: Range; copy: boolean; base: Song; moved: boolean }
    | { kind: 'trim'; x0: number; lane: number; at: Edge; base: Song; moved: boolean }
    | null
  >(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const snap = useStore((s) => s.tlSnap)

  const width = (): number => lanesRef.current?.clientWidth ?? 800
  const songSeconds = (s: Song): number => Math.max(4, tempoMap(s).tickToSec(arrangeEnd(s)))
  const fit = (): void => {
    const s = getState().song
    view.current = { start: 0, pps: Math.min(MAX_PPS, (width() - 24) / (songSeconds(s) * 1.03)) }
  }
  const minPps = (): number => Math.min(MAX_PPS, (width() - 24) / (songSeconds(getState().song) * 1.5))
  const zoom = (factor: number, aroundX = width() / 2): void => {
    const v = view.current
    const at = v.start + aroundX / v.pps
    const pps = Math.max(minPps(), Math.min(MAX_PPS, v.pps * factor))
    view.current = { pps, start: Math.max(0, at - aroundX / pps) }
  }
  const secAt = (x: number): number => view.current.start + x / view.current.pps
  const xOf = (sec: number): number => (sec - view.current.start) * view.current.pps

  // ---------- drawing ----------
  useEffect(() => {
    const ruler = rulerRef.current!
    const canvas = lanesRef.current!
    const rctx = ruler.getContext('2d')!
    const ctx = canvas.getContext('2d')!
    let raf = 0
    const size = (c: HTMLCanvasElement): { w: number; h: number; dpr: number } => {
      const dpr = window.devicePixelRatio || 1
      const w = c.clientWidth
      const h = c.clientHeight
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr)
        c.height = Math.round(h * dpr)
      }
      return { w, h, dpr }
    }
    const frame = (): void => {
      const st = getState()
      const s = st.song
      const map = tempoMap(s)
      const B = ticksPerBar(s)
      const beat = ticksPerBeat(s)
      const { w: W, h: H, dpr } = size(canvas)
      const r = size(ruler)
      if (!view.current.pps) fit()
      const v = view.current
      const playing = st.playing
      const now = playing ? engine.heardTime() : engine.time()
      // keep the playhead in view while playing, a page at a time
      if (playing && (xOf(now) > W - 40 || xOf(now) < 0)) view.current = { ...v, start: Math.max(0, now - 40 / v.pps) }
      const lo = secAt(0)
      const hi = secAt(W)
      const ls = lanesOf(s)

      // bar lines, thinned out when they'd crowd
      const barPx = map.tickToSec(B) * v.pps
      const every = barPx >= 14 ? 1 : Math.pow(2, Math.ceil(Math.log2(14 / Math.max(0.1, barPx))))
      const firstBar = Math.max(0, Math.floor(map.secToTick(Math.max(0, lo)) / B))
      const lastBar = Math.ceil(map.secToTick(hi) / B)

      // ruler
      rctx.setTransform(r.dpr, 0, 0, r.dpr, 0, 0)
      rctx.fillStyle = '#10131e'
      rctx.fillRect(0, 0, r.w, r.h)
      const { loop, loopOn, tlRange } = st
      if (loop) {
        const a = xOf(map.tickToSec(loop.start))
        const b = xOf(map.tickToSec(loop.end))
        rctx.fillStyle = loopOn ? 'rgba(124,140,255,0.32)' : 'rgba(255,255,255,0.08)'
        rctx.fillRect(a, r.h - 8, b - a, 8)
      }
      if (tlRange) {
        rctx.fillStyle = 'rgba(124,140,255,0.16)'
        const a = xOf(map.tickToSec(tlRange.from))
        rctx.fillRect(a, 0, xOf(map.tickToSec(tlRange.to)) - a, r.h)
      }
      rctx.font = '11px "Segoe UI", system-ui, sans-serif'
      rctx.textBaseline = 'top'
      for (let b = firstBar - (firstBar % every); b <= lastBar; b += every) {
        const x = Math.round(xOf(map.tickToSec(b * B)))
        rctx.fillStyle = 'rgba(255,255,255,0.28)'
        rctx.fillRect(x, 14, 1, r.h - 14)
        rctx.fillStyle = '#8a91ab'
        rctx.fillText(String(b + 1), x + 3, 16)
        // beats, when there's room
        if (every === 1 && barPx > 60)
          for (let k = beat; k < B; k += beat) {
            rctx.fillStyle = 'rgba(255,255,255,0.12)'
            rctx.fillRect(Math.round(xOf(map.tickToSec(b * B + k))), r.h - 6, 1, 6)
          }
      }
      rctx.font = '600 11px "Segoe UI", system-ui, sans-serif'
      for (const sec of s.sections) {
        const x = xOf(map.tickToSec(sec.bar * B))
        if (x > r.w || x < -200) continue
        rctx.fillStyle = '#7c8cff'
        rctx.fillRect(Math.round(x), 0, 2, 13)
        rctx.fillText(sec.name, x + 5, 1)
      }

      // lanes
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = '#0a0c14'
      ctx.fillRect(0, 0, W, H)
      const sy = scrollRef.current
      ls.forEach((_, i) => {
        if (i % 2) return
        ctx.fillStyle = 'rgba(255,255,255,0.018)'
        ctx.fillRect(0, i * LANE_H - sy, W, LANE_H)
      })
      for (let b = firstBar - (firstBar % every); b <= lastBar; b += every) {
        ctx.fillStyle = b % (4 * every) === 0 ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.045)'
        ctx.fillRect(Math.round(xOf(map.tickToSec(b * B))), 0, 1, H)
      }
      ls.forEach((lane, i) => {
        const top = i * LANE_H - sy
        if (top > H || top + LANE_H < 0) return
        ctx.fillStyle = 'rgba(255,255,255,0.05)'
        ctx.fillRect(0, top + LANE_H - 1, W, 1)
        if (lane.kind === 'notes') {
          const t = s.tracks.find((x) => x.id === lane.id)!
          const audible = isAudible(t, s) && !t.silent
          // blocks where the track plays
          ctx.globalAlpha = audible ? 1 : 0.45
          for (const [a, b] of blocksOf(t, B)) {
            const x0 = xOf(map.tickToSec(a))
            const x1 = xOf(map.tickToSec(b))
            if (x1 < 0 || x0 > W) continue
            ctx.fillStyle = alpha(t.color, 0.13)
            ctx.strokeStyle = alpha(t.color, 0.4)
            ctx.beginPath()
            ctx.roundRect(x0 + 1, top + 3, Math.max(2, x1 - x0 - 2), LANE_H - 7, 5)
            ctx.fill()
            ctx.stroke()
          }
          const times = trackTimes(t, map)
          const { lo: plo, hi: phi } = spanOf(t)
          const rows = Math.max(1, phi - plo)
          const inner = LANE_H - 16
          const nh = Math.max(1.5, Math.min(5, inner / (rows + 1)))
          ctx.fillStyle = t.color
          for (let k = lowerBound(times.start, lo - times.maxDur); k < t.notes.length && times.start[k] <= hi; k++) {
            if (times.end[k] < lo) continue
            const n = t.notes[k]
            const x = xOf(times.start[k])
            const y = top + 8 + (1 - (n.pitch - plo) / rows) * (inner - nh)
            ctx.fillRect(x, y, Math.max(1, (times.end[k] - times.start[k]) * v.pps - 0.5), nh)
          }
          ctx.globalAlpha = 1
        } else {
          const t = s.audioTracks.find((x) => x.id === lane.id)!
          ctx.globalAlpha = audioAudible(t, s) ? 1 : 0.45
          for (const c of t.clips) {
            const s0 = map.tickToSec(c.tick)
            const x0 = xOf(s0)
            const x1 = xOf(s0 + c.duration)
            if (x1 < 0 || x0 > W) continue
            ctx.fillStyle = alpha(t.color, 0.19)
            ctx.strokeStyle = alpha(t.color, 0.67)
            ctx.beginPath()
            ctx.roundRect(x0 + 0.5, top + 3, Math.max(2, x1 - x0 - 1), LANE_H - 7, 5)
            ctx.fill()
            ctx.stroke()
            // the grip, with the clip's name
            ctx.save()
            ctx.beginPath()
            ctx.roundRect(x0 + 0.5, top + 3, Math.max(2, x1 - x0 - 1), GRIP_H, [5, 5, 0, 0])
            ctx.fillStyle = alpha(t.color, 0.32)
            ctx.fill()
            ctx.clip()
            ctx.fillStyle = '#e6e9f5'
            ctx.font = '600 10px "Segoe UI", system-ui, sans-serif'
            ctx.textBaseline = 'middle'
            ctx.fillText(t.name, Math.max(x0, 0) + 6, top + 3 + GRIP_H / 2 + 0.5)
            ctx.restore()
            const takeId = c.takes[c.active]
            const peaks = takeId ? peaksOf(takeId) : null
            const take = takeId ? getTake(takeId) : undefined
            if (peaks && take) {
              ctx.fillStyle = alpha(t.color, 0.8)
              const mid = top + 3 + GRIP_H + (LANE_H - 7 - GRIP_H) / 2
              const amp = (LANE_H - 7 - GRIP_H) / 2 - 3
              for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, x1); x++) {
                const a = c.offset + (secAt(x) - s0)
                const b = c.offset + (secAt(x + 1) - s0)
                let m = 0
                for (let p = Math.floor((a * take.rate) / PEAK); p <= Math.floor((b * take.rate) / PEAK) && p < peaks.length; p++) if (p >= 0 && peaks[p] > m) m = peaks[p]
                const hh = Math.max(0.5, Math.min(1, m) * amp)
                ctx.fillRect(x, mid - hh, 1, hh * 2)
              }
            }
          }
          ctx.globalAlpha = 1
        }
      })

      // the selected stretch, on its lanes
      if (tlRange) {
        const a = xOf(map.tickToSec(tlRange.from))
        const b = xOf(map.tickToSec(tlRange.to))
        ls.forEach((lane, i) => {
          const on = lane.kind === 'notes' ? tlRange.tracks.includes(lane.id) : tlRange.audio.includes(lane.id)
          if (!on) return
          ctx.fillStyle = 'rgba(124,140,255,0.2)'
          ctx.fillRect(a, i * LANE_H - sy, b - a, LANE_H - 1)
        })
        ctx.fillStyle = '#9aa6ff'
        ctx.fillRect(Math.round(a), 0, 1, H)
        ctx.fillRect(Math.round(b) - 1, 0, 1, H)
      }
      if (loop && loopOn) {
        ctx.fillStyle = 'rgba(124,140,255,0.35)'
        ctx.fillRect(Math.round(xOf(map.tickToSec(loop.start))), 0, 1, H)
        ctx.fillRect(Math.round(xOf(map.tickToSec(loop.end))), 0, 1, H)
      }
      // playhead
      const px = Math.round(xOf(now))
      ctx.fillStyle = '#ff5a5f'
      ctx.fillRect(px - 1, 0, 2, H)
      rctx.fillStyle = '#ff5a5f'
      rctx.fillRect(px - 1, 0, 2, r.h)
      rctx.beginPath()
      rctx.moveTo(px - 6, 0)
      rctx.lineTo(px + 6, 0)
      rctx.lineTo(px, 8)
      rctx.fill()
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  // a new song starts zoomed to fit
  const lastSong = useRef<Song | null>(null)
  useEffect(() => {
    const prev = lastSong.current
    lastSong.current = song
    if (prev && prev.reference?.trackId !== song.reference?.trackId) fit()
  }, [song])

  // ---------- pointer ----------
  const maxScroll = (): number => Math.max(0, lanes.length * LANE_H - (lanesRef.current?.clientHeight ?? 0) + 8)
  useEffect(() => {
    const el = wrapRef.current!
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const x = e.clientX - lanesRef.current!.getBoundingClientRect().left
      if (e.ctrlKey || e.altKey) zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, x)
      else if (e.shiftKey) setScrollY((y) => Math.max(0, Math.min(maxScroll(), y + e.deltaY)))
      else {
        const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / view.current.pps
        view.current = { ...view.current, start: Math.max(0, view.current.start + d) }
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  const local = (e: React.PointerEvent | React.MouseEvent): { x: number; y: number } => {
    const b = lanesRef.current!.getBoundingClientRect()
    return { x: e.clientX - b.left, y: e.clientY - b.top }
  }
  const laneAt = (y: number): number => Math.max(0, Math.min(lanes.length - 1, Math.floor((y + scrollY) / LANE_H)))
  const grid = (free: boolean): number => gridOf(getState().song, getState().tlSnap, free)
  /** A tick on the grid (anywhere, holding Alt) nearest a point. */
  const snapAt = (x: number, free: boolean): number => {
    const s = getState().song
    const g = grid(free)
    return Math.max(0, Math.round(tempoMap(s).secToTick(Math.max(0, secAt(x))) / g) * g)
  }
  /** How far a drag from x0 to x moves something starting at `tick`, in ticks, by whole grid steps. */
  const dragTicks = (x0: number, x: number, tick: number, free: boolean): number => {
    const m = tempoMap(getState().song)
    const g = grid(free)
    return Math.round((m.secToTick(m.tickToSec(tick) + secAt(x) - secAt(x0)) - tick) / g) * g
  }
  const rangeFor = (lane0: number, lane1: number, a: number, b: number, free: boolean): Range => {
    const g = grid(free)
    const from = Math.min(a, b)
    const to = Math.max(Math.max(a, b), from + g)
    const pick = lanes.slice(Math.min(lane0, lane1), Math.max(lane0, lane1) + 1)
    return { from, to, tracks: pick.filter((l) => l.kind === 'notes').map((l) => l.id), audio: pick.filter((l) => l.kind === 'audio').map((l) => l.id) }
  }
  /** The bar under a point, on its lane: what a right-click picks when it isn't on the selection. */
  const barRange = (x: number, lane: number): Range => {
    const s = getState().song
    const B = ticksPerBar(s)
    const from = Math.floor(tempoMap(s).secToTick(Math.max(0, secAt(x))) / B) * B
    return { ...rangeFor(lane, lane, from, from + B, false), to: from + B }
  }
  const inRange = (x: number, lane: number): boolean => {
    const r = getState().tlRange
    if (!r || !lanes[lane]) return false
    const tick = tempoMap(getState().song).secToTick(secAt(x))
    const l = lanes[lane]
    return tick >= r.from && tick < r.to && (l.kind === 'notes' ? r.tracks.includes(l.id) : r.audio.includes(l.id))
  }
  const activate = (lane: Lane): void => getState().set(lane.kind === 'notes' ? { activeTrackId: lane.id } : { activeAudioId: lane.id })
  /** The audio clip whose grip is under a point, if any. */
  const gripAt = (x: number, y: number): { lane: number; trackId: number; clipId: number; tick: number } | null => {
    const lane = Math.floor((y + scrollY) / LANE_H)
    const l = lanes[lane]
    const top = lane * LANE_H - scrollY
    if (l?.kind !== 'audio' || y < top + 3 || y > top + 3 + GRIP_H) return null
    const s = getState().song
    const m = tempoMap(s)
    const sec = secAt(x)
    const c = s.audioTracks.find((t) => t.id === l.id)?.clips.find((c) => sec >= m.tickToSec(c.tick) && sec <= m.tickToSec(c.tick) + c.duration)
    return c ? { lane, trackId: l.id, clipId: c.id, tick: c.tick } : null
  }
  /** The edge of a clip or note block under a point, if any: the nearest, within EDGE pixels. */
  const edgeAt = (x: number, y: number): Edge | null => {
    const lane = Math.floor((y + scrollY) / LANE_H)
    const l = lanes[lane]
    if (!l) return null
    const s = getState().song
    const m = tempoMap(s)
    const spans: { clipId: number; from: number; to: number; x0: number; x1: number }[] = []
    if (l.kind === 'notes') {
      const t = s.tracks.find((x) => x.id === l.id)
      for (const [a, b] of t ? blocksOf(t, ticksPerBar(s)) : []) spans.push({ clipId: -1, from: a, to: b, x0: xOf(m.tickToSec(a)), x1: xOf(m.tickToSec(b)) })
    } else
      for (const c of s.audioTracks.find((t) => t.id === l.id)?.clips ?? []) {
        const s0 = m.tickToSec(c.tick)
        spans.push({ clipId: c.id, from: c.tick, to: m.secToTick(s0 + c.duration), x0: xOf(s0), x1: xOf(s0 + c.duration) })
      }
    let best: Edge | null = null
    let near = EDGE
    for (const sp of spans)
      for (const [edge, ex] of [['start', sp.x0], ['end', sp.x1]] as const)
        if (Math.abs(x - ex) <= near) {
          near = Math.abs(x - ex)
          best = { lane, kind: l.kind, trackId: l.id, clipId: sp.clipId, edge, from: sp.from, to: sp.to }
        }
    return best
  }

  const st = getState()
  const map = tempoMap(song)
  const B = ticksPerBar(song)
  const end = arrangeEnd(song)

  return (
    <div className="tl" ref={wrapRef}>
      <div className="tl-top">
        <div className="tl-corner">
          <button className="btn small-btn" title="Zoom out (Ctrl+scroll)" onClick={() => zoom(1 / 1.5)}>−</button>
          <button className="btn small-btn" title="Zoom in (Ctrl+scroll)" onClick={() => zoom(1.5)}>+</button>
          <button className="btn small-btn" title="Show the whole song" onClick={fit}>Fit</button>
          <select
            className="select tl-snap"
            value={snap}
            title="What selecting, moving and cropping snap to (hold Alt to ignore it)"
            aria-label="Snap"
            onChange={(e) => {
              const v = e.target.value as TimelineSnap
              getState().set({ tlSnap: v })
              savePref('tlSnap', v)
            }}
          >
            {TIMELINE_SNAPS.map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
        </div>
        <canvas
          ref={rulerRef}
          className="tl-ruler"
          title="Click or drag to move the playhead · Shift+drag to set the loop"
          onPointerDown={(e) => {
            ;(e.target as Element).setPointerCapture(e.pointerId)
            const { x } = local(e)
            if (e.shiftKey) {
              const tick0 = snapAt(x, false)
              drag.current = { kind: 'loop', tick0 }
            } else {
              drag.current = { kind: 'seek' }
              engine.seek(Math.max(0, secAt(x)))
            }
          }}
          onPointerMove={(e) => {
            const d = drag.current
            const { x } = local(e)
            if (d?.kind === 'seek') engine.seek(Math.max(0, secAt(x)))
            else if (d?.kind === 'loop') {
              const t = snapAt(x, false)
              setLoop(Math.min(d.tick0, t), Math.max(d.tick0, t, Math.min(d.tick0, t) + B))
            }
          }}
          onPointerUp={() => (drag.current = null)}
        />
      </div>
      <div className="tl-body">
        <div className="tl-heads">
          <div style={{ transform: `translateY(${-scrollY}px)` }}>
            {lanes.map((l) => (
              <div
                key={`${l.kind}${l.id}`}
                className={`tl-head${(l.kind === 'notes' ? st.activeTrackId : st.activeAudioId) === l.id ? ' active' : ''}${l.kind === 'notes' && st.trackPicks.length > 1 && st.trackPicks.includes(l.id) ? ' picked' : ''}`}
                style={{ height: LANE_H, borderLeftColor: l.color }}
                title={l.kind === 'notes' ? 'Ctrl+click more tracks, then press G to merge them' : undefined}
                onClick={(e) => {
                  activate(l)
                  if (l.kind === 'notes') pickTrack(l.id, e.ctrlKey || e.shiftKey)
                }}
              >
                <div className="tl-name" title={l.name}>{l.name}</div>
                <div className="tl-meta">
                  <span className="meta">{l.tag}</span>
                  <button
                    className={`ms${l.muted ? ' on mute' : ''}`}
                    title="Mute"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (l.kind === 'notes') updateTrack(l.id, { muted: !l.muted })
                      else updateAudioTrack(l.id, { muted: !l.muted })
                    }}
                  >
                    M
                  </button>
                  <button
                    className={`ms${l.solo ? ' on solo' : ''}`}
                    title="Solo"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (l.kind === 'notes') updateTrack(l.id, { solo: !l.solo })
                      else updateAudioTrack(l.id, { solo: !l.solo })
                    }}
                  >
                    S
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
        <canvas
          ref={lanesRef}
          className="tl-lanes"
          onPointerDown={(e) => {
            if (e.button !== 0) return
            ;(e.target as Element).setPointerCapture(e.pointerId)
            setMenu(null)
            const { x, y } = local(e)
            const lane = laneAt(y)
            const r = getState().tlRange
            if (e.shiftKey && r) {
              // Shift+click stretches the selection to here, over the lanes in between
              const lanesOn = lanes.map((l, i) => ((l.kind === 'notes' ? r.tracks : r.audio).includes(l.id) ? i : -1)).filter((i) => i >= 0)
              const first = Math.min(lane, ...lanesOn)
              const last = Math.max(lane, ...lanesOn)
              const t = snapAt(x, e.altKey)
              getState().set({ tlRange: rangeFor(first, last, Math.min(r.from, t), Math.max(r.to, t), e.altKey) })
              return
            }
            const at = edgeAt(x, y)
            if (at) {
              getState().beginGesture()
              drag.current = { kind: 'trim', x0: x, lane: at.lane, at, base: getState().song, moved: false }
              return
            }
            const grip = gripAt(x, y)
            if (grip) {
              getState().beginGesture()
              drag.current = { kind: 'clip', x0: x, lane: grip.lane, trackId: grip.trackId, clipId: grip.clipId, tick0: grip.tick, base: getState().song, moved: false }
              return
            }
            if (r && inRange(x, lane)) {
              getState().beginGesture()
              drag.current = { kind: 'move', x0: x, lane, r, copy: e.ctrlKey, base: getState().song, moved: false }
              return
            }
            drag.current = { kind: 'range', x0: x, lane, tick0: snapAt(x, e.altKey), moved: false, free: e.altKey }
          }}
          onPointerMove={(e) => {
            const d = drag.current
            const { x, y } = local(e)
            const el = e.currentTarget
            if (!d) {
              const at = edgeAt(x, y)
              const grip = at ? null : gripAt(x, y)
              const inside = !at && !grip && inRange(x, laneAt(y))
              el.style.cursor = at ? 'ew-resize' : grip ? 'grab' : inside ? 'move' : ''
              el.title = at
                ? at.kind === 'audio'
                  ? 'Drag to crop this clip (drag back out to bring it back; hold Alt to ignore the grid)'
                  : 'Drag in to crop these notes (hold Alt to ignore the grid)'
                : grip
                  ? songAudio(getState().song).includes(grip.trackId)
                    ? 'Drag to move the song, with its stems, notes to sing, chords, lyrics and recreated parts (hold Alt to ignore the grid)'
                    : 'Drag to move this clip (hold Alt to ignore the grid)'
                  : inside
                    ? 'Drag to move the selection (Ctrl+drag copies it; hold Alt to ignore the grid)'
                    : ''
              return
            }
            if (d.kind === 'seek' || d.kind === 'loop') return
            if (!d.moved && Math.abs(x - d.x0) < 4) return
            d.moved = true
            if (d.kind === 'clip') {
              el.style.cursor = 'grabbing'
              const ticks = dragTicks(d.x0, x, d.tick0, e.altKey)
              getState().apply(() => moveClip(d.base, d.trackId, d.clipId, ticks))
            } else if (d.kind === 'move') {
              const ticks = Math.max(-d.r.from, dragTicks(d.x0, x, d.r.from, e.altKey))
              getState().apply(() => moveRange(d.base, d.r, ticks, d.copy))
              getState().set({ tlRange: { ...d.r, from: d.r.from + ticks, to: d.r.to + ticks } })
            } else if (d.kind === 'trim') {
              const { at, base } = d
              const tick = snapAt(x, e.altKey)
              if (at.kind === 'notes') getState().apply(() => trimNotes(base, at.trackId, at.from, at.to, at.edge, tick))
              else {
                const clip = base.audioTracks.find((t) => t.id === at.trackId)?.clips.find((c) => c.id === at.clipId)
                if (!clip) return
                const take = getTake(clip.takes[clip.active])
                const takeSec = take ? take.pcm.length / take.rate : clip.offset + clip.duration
                getState().apply(() => trimClip(base, at.trackId, at.clipId, at.edge, tick, takeSec))
              }
            } else getState().set({ tlRange: rangeFor(d.lane, laneAt(y), d.tick0, snapAt(x, d.free), d.free) })
          }}
          onPointerUp={(e) => {
            const d = drag.current
            drag.current = null
            if (!d || d.kind === 'seek' || d.kind === 'loop') return
            if (d.kind !== 'range') getState().endGesture()
            if (d.kind === 'clip') e.currentTarget.style.cursor = 'grab'
            if (d.moved) return
            // a click: the playhead goes there and the lane becomes the one you're working on
            const { x } = local(e)
            engine.seek(Math.max(0, secAt(x)))
            getState().set({ tlRange: null })
            const lane = lanes[d.lane]
            if (lane) activate(lane)
          }}
          onLostPointerCapture={() => {
            // the drag was taken away (the window lost focus): keep what was moved so far as one step
            const k = drag.current?.kind
            if (k === 'clip' || k === 'move' || k === 'trim') getState().endGesture()
            drag.current = null
          }}
          onDoubleClick={(e) => {
            // straight into the notes, at this point of the song
            const { x, y } = local(e)
            const lane = lanes[laneAt(y)]
            if (lane) activate(lane)
            engine.seek(Math.max(0, secAt(x)))
            toggleTimeline()
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            const { x, y } = local(e)
            const lane = laneAt(y)
            if (!lanes[lane]) return
            if (!inRange(x, lane)) getState().set({ tlRange: barRange(x, lane) })
            setMenu({ x: e.clientX, y: e.clientY })
          }}
        />
        {!lanes.length && <div className="tl-empty">No tracks yet. Add one in the Tracks tab, or open a song in the Reference tab.</div>}
      </div>
      {menu && range && (
        <RangeMenu
          at={menu}
          text={describeRange(song, range)}
          canRepeatToEnd={end > range.to}
          bars={`bars ${Math.floor(range.from / B) + 1}–${Math.ceil(range.to / B)}`}
          close={() => setMenu(null)}
          openNotes={() => {
            const r = range
            const ids = new Set<number>()
            for (const t of song.tracks) if (r.tracks.includes(t.id)) for (const n of t.notes) if (n.tick >= r.from && n.tick < r.to) ids.add(n.id)
            engine.seek(map.tickToSec(r.from))
            toggleTimeline()
            getState().setSelection(ids)
          }}
        />
      )}
    </div>
  )
}

/** "2 bars from 5 on 3 tracks" */
export function describeRange(song: Song, r: Range): string {
  const B = ticksPerBar(song)
  const beat = ticksPerBeat(song)
  const n = r.tracks.length + r.audio.length
  const pos = (tick: number): string => (tick % B === 0 ? `${tick / B + 1}` : `${Math.floor(tick / B) + 1}.${Math.round((tick % B) / beat) + 1}`)
  const bars = (r.to - r.from) / B
  return `${Number.isInteger(bars) ? bars : bars.toFixed(2)} bar${bars === 1 ? '' : 's'} from ${pos(r.from)} on ${n} track${n === 1 ? '' : 's'}`
}

function RangeMenu(props: { at: { x: number; y: number }; text: string; bars: string; canRepeatToEnd: boolean; close: () => void; openNotes: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (e: Event): void => {
      if (!ref.current?.contains(e.target as Node)) props.close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.close()
    }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', onKey)
    }
  })
  const run = (fn: () => void) => () => {
    props.close()
    fn()
  }
  return (
    <div ref={ref} className="menu context" role="menu" style={{ left: Math.min(props.at.x, window.innerWidth - 260), top: Math.min(props.at.y, window.innerHeight - 380) }} onContextMenu={(e) => e.preventDefault()}>
      <div className="menu-label">{props.text}</div>
      <button role="menuitem" title="Silences these bars on these tracks; the rest of the song stays where it is" onClick={run(clearTimelineRange)}>
        Clear <span className="kbd">Del</span>
      </button>
      <button role="menuitem" title="Keeps only this stretch on these tracks; everything before and after it there is cleared" onClick={run(cropTimelineRange)}>
        Crop to this
      </button>
      <div className="menu-label" title="Copies it into the bars after it, again and again, replacing what was there on these tracks">Repeat it</div>
      {props.canRepeatToEnd && <button role="menuitem" onClick={run(() => repeatTimelineRange('end'))}>To the end of the song</button>}
      <div className="menu-row">
        {[1, 3, 7].map((n) => (
          <button key={n} role="menuitem" title={`${n + 1} times in all${n === 1 ? ' (Ctrl+D)' : ''}`} onClick={run(() => repeatTimelineRange(n))}>×{n + 1}</button>
        ))}
      </div>
      <div className="menu-label">Bars</div>
      <button role="menuitem" onClick={run(loopTimelineRange)}>Loop these bars</button>
      <button role="menuitem" onClick={run(props.openNotes)}>Edit the notes <span className="kbd">double-click</span></button>
      <button role="menuitem" className="danger" title="Every track loses these bars and everything after them moves back" onClick={run(removeTimelineBars)}>
        Remove {props.bars} from the song
      </button>
    </div>
  )
}

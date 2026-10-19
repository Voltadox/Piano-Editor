import {
  HIGHEST,
  isAudible,
  isBlack,
  LOWEST,
  lowerBound,
  noteName,
  tempoMap,
  ticksPerBar,
  ticksPerBeat,
  trackTimes,
  type Song
} from '../model/song'
import { HOP_SEC } from '../audio/pitch'
import type { ClipNotes } from '../audio/vocals'
import { DEFAULT_THEME, type Theme } from './theme'

export const COLORS = {
  laneBlack: 'rgba(255,255,255,0.028)',
  laneLine: 'rgba(255,255,255,0.05)',
  octaveLine: 'rgba(255,255,255,0.10)',
  beat: 'rgba(255,255,255,0.06)',
  bar: 'rgba(255,255,255,0.16)',
  sub: 'rgba(255,255,255,0.025)',
  barLabel: 'rgba(228,231,242,0.45)',
  keyWhite: '#eceef4',
  keyWhiteShade: '#c9ccd8',
  keyBlack: '#151824',
  keyBlackTop: '#2a2e40',
  keyEdge: '#05060a',
  select: '#ffffff',
  boxFill: 'rgba(124,140,255,0.12)',
  boxLine: 'rgba(124,140,255,0.8)'
}

// ---------- keyboard geometry ----------

const WHITE_IN_OCT = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6]
const whiteIndex = (p: number): number => Math.floor(p / 12) * 7 + WHITE_IN_OCT[p % 12]
const FIRST_WHITE = whiteIndex(LOWEST)
const WHITE_COUNT = whiteIndex(HIGHEST) - FIRST_WHITE + 1

export interface KeyLayout {
  whiteW: number
  blackW: number
  x: (p: number) => number
  w: (p: number) => number
  /** pitch under an x position; black keys win where they overlap */
  pitchAt: (x: number) => number
}

export function keyLayout(width: number): KeyLayout {
  const whiteW = width / WHITE_COUNT
  const blackW = whiteW * 0.62
  const x = (p: number): number => {
    const wi = whiteIndex(p) - FIRST_WHITE
    return isBlack(p) ? wi * whiteW + whiteW - blackW / 2 : wi * whiteW
  }
  const w = (p: number): number => (isBlack(p) ? blackW : whiteW)
  const pitchAt = (px: number): number => {
    const wi = Math.max(0, Math.min(WHITE_COUNT - 1, Math.floor(px / whiteW)))
    // find the white pitch with this index
    let p = LOWEST
    while (p < HIGHEST && (isBlack(p) || whiteIndex(p) - FIRST_WHITE < wi)) p++
    for (const b of [p - 1, p + 1]) {
      if (b >= LOWEST && b <= HIGHEST && isBlack(b) && px >= x(b) && px < x(b) + blackW) return b
    }
    return p
  }
  return { whiteW, blackW, x, w, pitchAt }
}

/** Key length that gives white keys roughly a real piano's proportions at this width. */
export const pianoKeyLength = (width: number): number => (width / WHITE_COUNT) * 5.5

// ---------- scene ----------

export interface Scene {
  song: Song
  width: number
  height: number
  /** song time at the keyboard line, seconds */
  time: number
  pxPerSec: number
  keyboardHeight: number
  selection?: Set<number>
  hoverId?: number
  box?: { x0: number; y0: number; x1: number; y1: number } | null
  /** grid ticks for snap subdivision lines; 0 hides them */
  snapTicks?: number
  activeTrackId?: number
  liveKeys?: Map<number, number>
  liveColor?: string
  /** time runs upward: notes grow out of the keyboard and rise away (used while recording) */
  rising?: boolean
  /** notes being recorded, in seconds, drawn in `liveColor` */
  take?: { pitch: number; start: number; end: number; vel: number }[]
  /** loop region in seconds */
  loop?: { start: number; end: number } | null
  /** beats left in a recording count-in */
  countdown?: number
  /** tuned vocal melodies to draw over the keys they sing */
  vocals?: { color: string; origin: number; from: number; to: number; pitch: Float32Array }[]
  /** a vocal track's sung notes, shown as bars to move by hand (pitch editing) */
  vocalNotes?: VocalNotesLayer | null
  /** section names shown at their bar lines */
  sections?: { bar: number; name: string }[]
  /** the chord lane: chord names at the time each chord starts */
  chordMarks?: { sec: number; label: string; index: number }[]
  /** the lyric line being sung now and the next one */
  lyrics?: { now: string | null; next: string | null } | null
  /** the pitch being sung now, and the reference note to aim for */
  livePitch?: { midi: number; target: number | null } | null
  /** pitches to mark on the keyboard (a Studio chord suggestion) */
  hints?: number[] | null
  theme?: Theme
  bgImage?: ImageBitmap | null
  /** larger labels and no editing chrome, for video export */
  presentation?: boolean
}

export interface TimeAxis {
  /** y of the keyboard line */
  line: number
  /** visible song time range */
  lo: number
  hi: number
  yOf: (sec: number) => number
  secAt: (y: number) => number
}

/** Maps song time to y for a scene, in either direction. */
export function timeAxis(s: Pick<Scene, 'height' | 'keyboardHeight' | 'pxPerSec' | 'time' | 'rising'>): TimeAxis {
  const line = s.height - s.keyboardHeight
  const pps = s.pxPerSec
  const span = line / pps
  const t = s.time
  return s.rising
    ? { line, lo: t - span, hi: t, yOf: (sec) => line - (t - sec) * pps, secAt: (y) => t - (line - y) / pps }
    : { line, lo: t, hi: t + span, yOf: (sec) => line - (sec - t) * pps, secAt: (y) => t + (line - y) / pps }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, rr)
}

export function drawBackground(ctx: CanvasRenderingContext2D, W: number, H: number, theme: Theme, img?: ImageBitmap | null): void {
  if (theme.background === 'image' && img) {
    const k = Math.max(W / img.width, H / img.height)
    const iw = img.width * k
    const ih = img.height * k
    ctx.drawImage(img, (W - iw) / 2, (H - ih) / 2, iw, ih)
    ctx.fillStyle = `rgba(5,6,10,${theme.imageDim})`
    ctx.fillRect(0, 0, W, H)
    return
  }
  if (theme.background === 'gradient') {
    const g = ctx.createLinearGradient(0, 0, 0, H)
    g.addColorStop(0, theme.bg)
    g.addColorStop(1, theme.bg2)
    ctx.fillStyle = g
  } else ctx.fillStyle = theme.bg
  ctx.fillRect(0, 0, W, H)
}

// ---------- key-hit sparks ----------

const SPARK_LIFE = 0.55
const SPARK_EVERY = 0.04
const FLASH = 0.3

function hash(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b)
  x ^= x >>> 13
  x = Math.imul(x, 0xc2b2ae35)
  x ^= x >>> 16
  return (x >>> 0) / 4294967296
}

interface Spark {
  seed: number
  pitch: number
  start: number
  end: number
  color: string
}

/**
 * Particles are born at a steady rate while a note sounds. Each one's path depends only on its
 * seed and age, so scrubbing, live playback and video export all draw the same thing.
 */
function drawSparks(ctx: CanvasRenderingContext2D, sparks: Spark[], keys: KeyLayout, line: number, t: number, strength: number): void {
  const u = keys.whiteW / 26 // scale speeds and sizes with the keyboard
  ctx.globalCompositeOperation = 'lighter'
  for (const s of sparks) {
    const cx = keys.x(s.pitch) + keys.w(s.pitch) / 2
    const spread = keys.w(s.pitch) * 0.8
    ctx.fillStyle = s.color
    const first = Math.max(0, Math.ceil((t - SPARK_LIFE - s.start) / SPARK_EVERY))
    const last = Math.floor((Math.min(t, s.end) - s.start) / SPARK_EVERY)
    for (let k = first; k <= last; k++) {
      const age = t - (s.start + k * SPARK_EVERY)
      if (age < 0 || age > SPARK_LIFE) continue
      // a burst on the attack, then a trickle while the key is held
      const count = k === 0 ? 7 : 1
      for (let j = 0; j < count; j++) {
        const seed = s.seed * 977 + k * 31 + j
        const a = hash(seed)
        const b = hash(seed + 101)
        const c = hash(seed + 202)
        const boost = k === 0 ? 1.5 : 1
        const vx = (a - 0.5) * 150 * u * boost
        const vy = (110 + b * 230) * u * boost
        const px = cx + (c - 0.5) * spread + vx * age
        const py = line - 3 - vy * age + 380 * u * age * age
        const life = 1 - age / SPARK_LIFE
        const size = (1.2 + c * 2.2) * u * (0.4 + 0.6 * life)
        ctx.globalAlpha = Math.min(1, life * strength)
        ctx.fillRect(px - size / 2, py - size / 2, size, size)
      }
    }
  }
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
}

// ---------- the stage ----------

export function drawScene(ctx: CanvasRenderingContext2D, s: Scene): void {
  const { song, width: W, height: H, time: t } = s
  const theme = s.theme ?? DEFAULT_THEME
  const kbH = s.keyboardHeight
  const keys = keyLayout(W)
  const map = tempoMap(song)
  const rising = !!s.rising
  const { line, lo, hi, yOf } = timeAxis(s)

  drawBackground(ctx, W, H, theme, s.bgImage)

  // pitch lanes
  for (let p = LOWEST; p <= HIGHEST; p++) {
    if (isBlack(p)) {
      ctx.fillStyle = COLORS.laneBlack
      ctx.fillRect(keys.x(p), 0, keys.blackW, line)
    } else if (p % 12 === 0 || p % 12 === 5) {
      ctx.fillStyle = p % 12 === 0 ? COLORS.octaveLine : COLORS.laneLine
      ctx.fillRect(Math.round(keys.x(p)), 0, 1, line)
    }
  }

  // beat grid
  const tpb = ticksPerBeat(song)
  const tpbar = ticksPerBar(song)
  const startTick = Math.max(0, map.secToTick(Math.max(0, lo)))
  const endTick = map.secToTick(hi)
  if (!s.presentation || theme.beatLines) {
    if (s.snapTicks && s.snapTicks > 1) {
      const g = s.snapTicks
      const spacing = (map.tickToSec(startTick + g) - map.tickToSec(startTick)) * s.pxPerSec
      if (spacing >= 9) {
        ctx.fillStyle = COLORS.sub
        for (let k = Math.ceil(startTick / g) * g; k <= endTick; k += g) ctx.fillRect(0, Math.round(yOf(map.tickToSec(k))), W, 1)
      }
    }
    ctx.textBaseline = 'bottom'
    const named = new Map((s.sections ?? []).map((x) => [x.bar, x.name]))
    for (let k = Math.floor(startTick / tpb) * tpb; k <= endTick; k += tpb) {
      const y = Math.round(yOf(map.tickToSec(k)))
      if (y > line) continue
      const isBar = Math.round(k) % Math.round(tpbar) === 0
      ctx.fillStyle = isBar ? COLORS.bar : COLORS.beat
      ctx.fillRect(0, y, W, isBar ? 1.5 : 1)
      if (isBar && !s.presentation) {
        const b = Math.round(k / tpbar)
        ctx.font = `11px "Cascadia Mono", Consolas, monospace`
        ctx.fillStyle = COLORS.barLabel
        ctx.fillText(String(b + 1), 6, y - 2)
        const name = named.get(b)
        if (name) {
          ctx.font = `600 12px "Segoe UI", system-ui, sans-serif`
          ctx.fillStyle = hexA(theme.accent, 0.9)
          ctx.textAlign = 'right'
          ctx.fillText(name, W - 8, y - 2)
          ctx.textAlign = 'left'
        }
      }
    }
  }

  if (s.loop && !s.presentation) drawLoop(ctx, s.loop, W, line, yOf, theme.accent)
  if (s.chordMarks?.length && !s.presentation) drawChordLane(ctx, s.chordMarks, line, yOf, theme.accent)

  // notes
  const lit = new Map<number, { color: string; start: number }>()
  const sparks: Spark[] = []
  const wantSparks = theme.sparks && theme.glow > 0
  const anySel = s.selection && s.selection.size > 0
  const labelSize = s.presentation ? 13 : 10
  const radius = (w: number): number => w * 0.5 * theme.roundness
  ctx.font = `600 ${labelSize}px "Segoe UI", system-ui, sans-serif`
  ctx.textBaseline = 'bottom'
  ctx.textAlign = 'center'
  const drawNote = (pitch: number, st: number, en: number, vel: number, color: string, dim: number, ring: 'select' | 'hover' | null): void => {
    const x = keys.x(pitch)
    const w = keys.w(pitch)
    const pad = isBlack(pitch) ? 0.5 : Math.max(1, w * 0.07)
    // the attack end sits toward the keyboard when falling, away from it when rising
    const yAttack = Math.min(line, yOf(st))
    const yRelease = Math.min(line, yOf(en))
    const bottom = rising ? yRelease : yAttack
    const top = Math.min(rising ? yAttack : yRelease, bottom - 3)
    const h = bottom - top

    ctx.globalAlpha = dim * (0.62 + (0.38 * vel) / 127)
    ctx.fillStyle = color
    roundRect(ctx, x + pad, top, w - pad * 2, h, radius(w))
    ctx.fill()
    ctx.globalAlpha = dim
    // darker edge reads as the note's attack
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.fillRect(x + pad + 1, rising ? top : bottom - Math.min(3, h), w - pad * 2 - 2, Math.min(3, h))
    if (ring) {
      ctx.globalAlpha = 1
      ctx.lineWidth = ring === 'select' ? 2 : 1
      ctx.strokeStyle = ring === 'select' ? COLORS.select : 'rgba(255,255,255,0.5)'
      roundRect(ctx, x + pad + 0.5, top + 0.5, w - pad * 2 - 1, h - 1, radius(w))
      ctx.stroke()
    }
    if (h > labelSize + 6 && w > labelSize * 1.7) {
      ctx.globalAlpha = dim * 0.9
      ctx.fillStyle = 'rgba(10,12,20,0.75)'
      ctx.fillText(noteName(pitch), x + w / 2, rising ? top + labelSize + 3 : bottom - 3)
    }
    ctx.globalAlpha = 1
  }
  for (const pass of [false, true]) {
    for (const track of song.tracks) {
      const times = trackTimes(track, map)
      const audible = isAudible(track, song)
      const from = lowerBound(times.start, Math.min(lo, t - SPARK_LIFE) - times.maxDur - 0.001)
      const to = lowerBound(times.start, hi)
      const dim = !audible ? 0.22 : 1
      for (let i = from; i < to; i++) {
        const n = track.notes[i]
        if (isBlack(n.pitch) !== pass) continue
        const st = times.start[i]
        const en = times.end[i]
        if (audible && st <= t) {
          if (en > t) lit.set(n.pitch, { color: track.color, start: st })
          if (wantSparks && en > t - SPARK_LIFE) sparks.push({ seed: n.id, pitch: n.pitch, start: st, end: en, color: track.color })
        }
        if (en <= lo || st >= hi) continue
        const ring = anySel && s.selection!.has(n.id) ? 'select' : n.id === s.hoverId ? 'hover' : null
        drawNote(n.pitch, st, en, n.vel, track.color, dim, ring)
      }
    }
    if (s.take) {
      const color = s.liveColor ?? theme.accent
      for (const n of s.take) {
        if (isBlack(n.pitch) !== pass) continue
        if (wantSparks && n.start <= t && n.end > t - SPARK_LIFE)
          sparks.push({ seed: n.pitch * 7919 + Math.round(n.start * 1000), pitch: n.pitch, start: n.start, end: n.end, color })
        if (n.end > lo && n.start < hi) drawNote(n.pitch, n.start, n.end, n.vel, color, 1, null)
      }
    }
  }
  ctx.textAlign = 'left'

  if (s.liveKeys)
    for (const p of s.liveKeys.keys()) if (!lit.has(p)) lit.set(p, { color: s.liveColor ?? theme.accent, start: t })

  // glow where sounding notes meet the keyboard, flaring on each attack
  if (theme.glow > 0) {
    ctx.globalCompositeOperation = 'lighter'
    for (const [p, l] of lit) {
      const flash = Math.max(0, 1 - (t - l.start) / FLASH)
      const x = keys.x(p) + keys.w(p) / 2
      const r = keys.whiteW * (1.6 + flash * 1.2)
      const g = ctx.createRadialGradient(x, line, 0, x, line, r)
      g.addColorStop(0, hexA(l.color, Math.min(1, (0.4 + 0.45 * flash) * theme.glow)))
      g.addColorStop(1, hexA(l.color, 0))
      ctx.fillStyle = g
      ctx.fillRect(x - r, line - r, r * 2, r)
      if (flash > 0) {
        // a short beam of light up the lane
        const beam = keys.w(p) * 0.9
        const bh = keys.whiteW * 6 * theme.glow
        const lg = ctx.createLinearGradient(0, line, 0, line - bh)
        lg.addColorStop(0, hexA(l.color, 0.35 * flash * Math.min(1, theme.glow)))
        lg.addColorStop(1, hexA(l.color, 0))
        ctx.fillStyle = lg
        ctx.fillRect(x - beam / 2, line - bh, beam, bh)
      }
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  if (s.vocalNotes) drawVocalNotes(ctx, s.vocalNotes, keys, line, lo, hi, yOf)
  if (s.vocals?.length) drawVocals(ctx, s.vocals, keys, line, lo, hi, yOf)

  const litColors = new Map<number, string>()
  for (const [p, l] of lit) litColors.set(p, l.color)
  drawKeyboard(ctx, keys, W, line, kbH, litColors, theme.accent, !!s.presentation)
  if (s.hints) drawHints(ctx, keys, line, kbH, s.hints, theme.accent)
  if (s.livePitch) drawLivePitch(ctx, keys, line, s.livePitch)

  if (sparks.length) drawSparks(ctx, sparks, keys, line, t, theme.glow)

  if (s.lyrics && (s.lyrics.now || s.lyrics.next)) drawLyrics(ctx, s.lyrics, W, line, theme.accent, !!s.presentation)

  if (s.countdown) {
    const size = Math.round(Math.min(W, line) * 0.22)
    ctx.font = `700 ${size}px "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = hexA(theme.accent, 0.85)
    ctx.fillText(String(s.countdown), W / 2, line / 2)
    ctx.textAlign = 'left'
  }

  if (s.box) {
    const { x0, y0, x1, y1 } = s.box
    ctx.fillStyle = COLORS.boxFill
    ctx.strokeStyle = COLORS.boxLine
    ctx.lineWidth = 1
    ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
    ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0))
  }
}

export const CHORD_PILL = { x: 30, w: 50, h: 18 }

/** Chord names on the left edge, each just above the line where its chord starts. */
function drawChordLane(ctx: CanvasRenderingContext2D, marks: NonNullable<Scene['chordMarks']>, line: number, yOf: (sec: number) => number, accent: string): void {
  ctx.font = '600 12px "Segoe UI", system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  for (const m of marks) {
    const y = yOf(m.sec)
    if (y < -CHORD_PILL.h || y > line + CHORD_PILL.h) continue
    const top = y - CHORD_PILL.h - 2
    ctx.fillStyle = 'rgba(10,12,20,0.78)'
    roundRect(ctx, CHORD_PILL.x, top, CHORD_PILL.w, CHORD_PILL.h, 6)
    ctx.fill()
    ctx.strokeStyle = hexA(accent, 0.7)
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.fillStyle = '#e4e7f2'
    ctx.fillText(m.label, CHORD_PILL.x + CHORD_PILL.w / 2, top + CHORD_PILL.h / 2 + 1)
  }
  ctx.textAlign = 'left'
  ctx.textBaseline = 'bottom'
}

/** Which chord pill (by chord index) is under a point, if any. */
export function chordPillAt(s: Scene, px: number, py: number): number | null {
  if (!s.chordMarks || px < CHORD_PILL.x || px > CHORD_PILL.x + CHORD_PILL.w) return null
  const { yOf } = timeAxis(s)
  for (const m of s.chordMarks) {
    const y = yOf(m.sec)
    if (py >= y - CHORD_PILL.h - 2 && py <= y - 2) return m.index
  }
  return null
}

/** Where a fractional pitch sits across the keys: key centres, with fractions in between. */
function pitchX(keys: KeyLayout): { xOf: (m: number) => number; pitchAt: (x: number) => number } {
  const centre = (p: number): number => keys.x(p) + keys.w(p) / 2
  const xOf = (m: number): number => {
    const p = Math.max(LOWEST, Math.min(HIGHEST - 1, m))
    const b = Math.floor(p)
    return centre(b) + (centre(b + 1) - centre(b)) * (p - b)
  }
  const pitchAt = (x: number): number => {
    let lo = LOWEST
    let hi = HIGHEST - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (centre(mid) <= x) lo = mid
      else hi = mid - 1
    }
    const span = centre(lo + 1) - centre(lo)
    return Math.max(LOWEST, Math.min(HIGHEST, lo + (x - centre(lo)) / span))
  }
  return { xOf, pitchAt }
}

/** The fractional pitch under an x position on the stage. */
export const pitchAtX = (width: number, x: number): number => pitchX(keyLayout(width)).pitchAt(x)

export interface VocalNotesLayer {
  color: string
  clips: ClipNotes[]
  /** the note under the pointer, by clip and start frame */
  hover?: { clipId: number; start: number } | null
  /**
   * a note being dragged: to a pitch, or (with `word`, in take seconds) its whole word moved by
   * `dt` seconds
   */
  drag?: { clipId: number; start: number; pitch: number | null; dt: number; word: { start: number; end: number } | null } | null
}

/** "E4", "E4 +12¢": a fractional pitch as the nearest note and how far off it is. */
export function pitchLabel(m: number): string {
  const r = Math.round(m)
  const cents = Math.round((m - r) * 100)
  return cents ? `${noteName(r)} ${cents > 0 ? '+' : ''}${cents}¢` : noteName(r)
}

/** The bar a sung note is drawn as: where it lands across the keys and its span up the stage. */
function vocalNoteBox(c: ClipNotes, n: ClipNotes['notes'][number], keys: KeyLayout, line: number, yOf: (sec: number) => number, pitch: number, dt = 0): { x: number; w: number; top: number; bottom: number } {
  const w = Math.max(6, keys.whiteW * 0.78)
  // a word being moved shows where it's going, outside its clip if need be
  const start = dt ? c.origin + n.start * HOP_SEC + dt : Math.max(c.from, c.origin + n.start * HOP_SEC)
  const end = dt ? c.origin + n.end * HOP_SEC + dt : Math.min(c.to, c.origin + n.end * HOP_SEC)
  return { x: pitchX(keys).xOf(pitch) - w / 2, w, top: yOf(end), bottom: Math.min(line, yOf(start)) }
}

const shownPitch = (n: ClipNotes['notes'][number]): number => (Number.isNaN(n.target) ? n.sung : n.target)

/** Sung notes as soft bars under the vocal line: brighter when moved by hand, hollow when left as sung. */
function drawVocalNotes(ctx: CanvasRenderingContext2D, layer: VocalNotesLayer, keys: KeyLayout, line: number, lo: number, hi: number, yOf: (sec: number) => number): void {
  let label: { x: number; y: number; text: string } | null = null
  for (const c of layer.clips) {
    const d = layer.drag?.clipId === c.clipId ? layer.drag : null
    if (!d?.word && (c.to < lo || c.from > hi)) continue
    for (const n of c.notes) {
      // the dragged word's notes move with the pointer
      const inWord = !!d?.word && n.start * HOP_SEC >= d.word.start - 1e-6 && n.end * HOP_SEC <= d.word.end + 1e-6
      const dt = inWord ? d!.dt : 0
      const s = c.origin + n.start * HOP_SEC + dt
      const e = c.origin + n.end * HOP_SEC + dt
      if (inWord ? e < lo || s > hi : e < Math.max(lo, c.from) || s > Math.min(hi, c.to)) continue
      const dragging = d?.start === n.start
      const hover = dragging || inWord || (layer.hover?.clipId === c.clipId && layer.hover.start === n.start)
      const pitch = dragging && d!.pitch !== null ? d!.pitch : shownPitch(n)
      const b = vocalNoteBox(c, n, keys, line, yOf, pitch, dt)
      if (b.bottom - b.top < 1) continue
      roundRect(ctx, b.x, b.top, b.w, b.bottom - b.top, Math.min(b.w / 2, 6))
      const untuned = !(dragging && d!.pitch !== null) && Number.isNaN(n.target)
      ctx.fillStyle = hexA(layer.color, untuned ? 0.06 : hover ? 0.42 : n.edited ? 0.3 : 0.16)
      ctx.fill()
      ctx.setLineDash(untuned ? [4, 3] : [])
      ctx.lineWidth = hover || n.edited ? 2 : 1
      ctx.strokeStyle = hexA(layer.color, hover ? 1 : n.edited ? 0.85 : 0.5)
      ctx.stroke()
      ctx.setLineDash([])
      if (dragging && d!.pitch !== null && !Number.isNaN(n.sung)) {
        // a faint mark where it was sung, so you can see how far it has moved
        const sx = pitchX(keys).xOf(n.sung)
        ctx.fillStyle = hexA(layer.color, 0.5)
        ctx.fillRect(sx - 1, b.top, 2, b.bottom - b.top)
      }
      if (dragging && d!.word) {
        const ms = Math.round(d!.dt * 1000)
        label = { x: b.x + b.w / 2, y: Math.max(16, b.top - 6), text: `${ms > 0 ? '+' : ms < 0 ? '−' : ''}${Math.abs(ms)} ms ${ms < 0 ? 'earlier' : ms > 0 ? 'later' : ''}`.trim() }
      } else if (hover && !inWord) label = { x: b.x + b.w / 2, y: Math.max(16, b.top - 6), text: untuned ? `${pitchLabel(n.sung)} · as sung` : pitchLabel(pitch) }
    }
  }
  if (label) {
    ctx.font = '600 12px "Segoe UI", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    const w = ctx.measureText(label.text).width + 12
    ctx.fillStyle = 'rgba(12,14,22,0.85)'
    roundRect(ctx, label.x - w / 2, label.y - 18, w, 18, 5)
    ctx.fill()
    ctx.fillStyle = '#e4e7f2'
    ctx.fillText(label.text, label.x, label.y - 3)
    ctx.textAlign = 'left'
  }
  ctx.font = '600 12px "Segoe UI", system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  const hint = layer.clips.length ? 'Editing vocals: drag a note sideways to change its pitch (Alt bends it) · up or down to move its word in time · double-click puts the pitch back · Esc to finish' : 'Editing pitch: record a take on this vocal track first · Esc to finish'
  const hw = ctx.measureText(hint).width + 20
  ctx.fillStyle = 'rgba(12,14,22,0.85)'
  roundRect(ctx, 90, line - 32, hw, 24, 12)
  ctx.fill()
  ctx.fillStyle = hexA(layer.color, 1)
  ctx.fillText(hint, 100, line - 20)
}

/** The sung note under a point on the stage, while editing pitch. */
export function hitVocalNote(s: Scene, px: number, py: number): { clip: ClipNotes; note: ClipNotes['notes'][number] } | null {
  const layer = s.vocalNotes
  if (!layer) return null
  const { line, yOf } = timeAxis(s)
  if (py >= line) return null
  const keys = keyLayout(s.width)
  for (const c of layer.clips)
    for (const n of c.notes) {
      const b = vocalNoteBox(c, n, keys, line, yOf, shownPitch(n))
      if (px >= b.x - 3 && px <= b.x + b.w + 3 && py >= b.top - 3 && py <= b.bottom + 3) return { clip: c, note: n }
    }
  return null
}

/** A sung melody as a glowing line over the keys it sings (fractional pitches fall between keys). */
function drawVocals(
  ctx: CanvasRenderingContext2D,
  lines: NonNullable<Scene['vocals']>,
  keys: KeyLayout,
  line: number,
  lo: number,
  hi: number,
  yOf: (sec: number) => number
): void {
  const centre = (p: number): number => keys.x(p) + keys.w(p) / 2
  const xOf = (m: number): number => {
    const p = Math.max(LOWEST, Math.min(HIGHEST - 1, m))
    const b = Math.floor(p)
    return centre(b) + (centre(b + 1) - centre(b)) * (p - b)
  }
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  for (const v of lines) {
    const i0 = Math.max(0, Math.floor((Math.max(lo, v.from) - v.origin) / HOP_SEC))
    const i1 = Math.min(v.pitch.length, Math.ceil((Math.min(hi, v.to) - v.origin) / HOP_SEC))
    if (i1 <= i0) continue
    ctx.beginPath()
    let pen = false
    for (let i = i0; i < i1; i++) {
      const p = v.pitch[i]
      if (Number.isNaN(p)) {
        pen = false
        continue
      }
      const x = xOf(p)
      const y = Math.min(line, yOf(v.origin + i * HOP_SEC))
      if (pen) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
      pen = true
    }
    ctx.strokeStyle = hexA(v.color, 0.25)
    ctx.lineWidth = keys.whiteW * 0.45
    ctx.stroke()
    ctx.strokeStyle = v.color
    ctx.lineWidth = Math.max(2, keys.whiteW * 0.12)
    ctx.stroke()
  }
}

/**
 * The pitch you're singing, as a glowing marker on the keyboard line: green when within 35 cents
 * of the reference note (in any octave), amber otherwise, with how far off you are.
 */
function drawLivePitch(ctx: CanvasRenderingContext2D, keys: KeyLayout, line: number, p: { midi: number; target: number | null }): void {
  const m = Math.max(LOWEST, Math.min(HIGHEST - 1, p.midi))
  const b = Math.floor(m)
  const centre = (k: number): number => keys.x(k) + keys.w(k) / 2
  const x = centre(b) + (centre(b + 1) - centre(b)) * (m - b)
  let off: number | null = null
  if (p.target !== null) {
    // compare in the octave nearest the target, so singing an octave away still counts
    const d = p.midi - p.target
    off = d - 12 * Math.round(d / 12)
  }
  const good = off !== null && Math.abs(off) < 0.35
  const color = off === null ? '#e4e7f2' : good ? '#5fd3a8' : '#f2bf5e'
  const r = Math.max(6, keys.whiteW * 0.42)
  const glow = ctx.createRadialGradient(x, line, 0, x, line, r * 3)
  glow.addColorStop(0, hexA(color.length === 7 ? color : '#e4e7f2', 0.55))
  glow.addColorStop(1, hexA(color.length === 7 ? color : '#e4e7f2', 0))
  ctx.fillStyle = glow
  ctx.fillRect(x - r * 3, line - r * 3, r * 6, r * 6)
  ctx.beginPath()
  ctx.arc(x, line - r - 4, r, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  if (off !== null) {
    ctx.font = '600 12px "Segoe UI", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillStyle = color
    const cents = Math.round(off * 100)
    ctx.fillText(good ? 'on pitch' : `${cents > 0 ? '+' : ''}${cents}¢`, x, line - 2 * r - 10)
    ctx.textAlign = 'left'
  }
}

/** Karaoke-style lyrics near the top of the stage: the line being sung, and the next one under it. */
function drawLyrics(ctx: CanvasRenderingContext2D, l: { now: string | null; next: string | null }, W: number, line: number, accent: string, presentation: boolean): void {
  const size = Math.round(Math.max(18, Math.min(W / 34, line / 14)) * (presentation ? 1.25 : 1))
  const y = Math.round(line * 0.2)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.shadowColor = 'rgba(0,0,0,0.7)'
  ctx.shadowBlur = size * 0.5
  if (l.now) {
    ctx.font = `600 ${size}px "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif`
    ctx.fillStyle = '#f2f4fa'
    ctx.fillText(l.now, W / 2, y, W * 0.9)
    ctx.fillStyle = hexA(accent, 0.9)
    const w = Math.min(W * 0.9, ctx.measureText(l.now).width)
    ctx.fillRect(W / 2 - w / 2, y + size * 0.7, w, 2)
  }
  if (l.next) {
    ctx.font = `500 ${Math.round(size * 0.7)}px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`
    ctx.fillStyle = 'rgba(228,231,242,0.55)'
    ctx.fillText(l.next, W / 2, y + size * 1.6, W * 0.9)
  }
  ctx.shadowBlur = 0
  ctx.shadowColor = 'transparent'
  ctx.textAlign = 'left'
}

/** The lyric line under the playhead (or coming up next) and the one after it. */
export function lyricsAt(lines: { start: number; end: number; text: string }[], t: number): { now: string | null; next: string | null } | null {
  if (!lines.length) return null
  const i = lines.findIndex((l) => l.end > t)
  if (i < 0) return null
  const cur = lines[i]
  // show a line from just before it's sung
  if (cur.start - t > 4) return { now: null, next: cur.text }
  return { now: cur.text, next: lines[i + 1]?.text ?? null }
}

/** Dots on the keys of a suggested chord. */
function drawHints(ctx: CanvasRenderingContext2D, keys: KeyLayout, top: number, h: number, pitches: number[], accent: string): void {
  for (const p of pitches) {
    if (p < LOWEST || p > HIGHEST) continue
    const black = isBlack(p)
    const x = keys.x(p) + keys.w(p) / 2
    const y = top + (black ? h * 0.63 - keys.blackW * 0.9 : h - keys.whiteW * 0.9)
    const r = keys.w(p) * (black ? 0.3 : 0.26)
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = accent
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = black ? 'rgba(255,255,255,0.8)' : 'rgba(10,12,20,0.6)'
    ctx.stroke()
  }
}

function drawLoop(
  ctx: CanvasRenderingContext2D,
  loop: { start: number; end: number },
  W: number,
  line: number,
  yOf: (sec: number) => number,
  accent: string
): void {
  const ya = yOf(loop.start)
  const yb = yOf(loop.end)
  const top = Math.max(0, Math.min(ya, yb))
  const bottom = Math.min(line, Math.max(ya, yb))
  if (bottom > top) {
    ctx.fillStyle = hexA(accent, 0.05)
    ctx.fillRect(0, top, W, bottom - top)
  }
  ctx.font = '600 11px "Segoe UI", system-ui, sans-serif'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'bottom'
  for (const [y, label] of [[ya, 'Loop start'], [yb, 'Loop end']] as const) {
    if (y < 0 || y > line) continue
    ctx.fillStyle = hexA(accent, 0.8)
    ctx.fillRect(0, Math.round(y) - 1, W, 2)
    ctx.fillText(label, W - 8, y - 4)
  }
  ctx.textAlign = 'left'
}

function drawKeyboard(
  ctx: CanvasRenderingContext2D,
  keys: KeyLayout,
  W: number,
  top: number,
  h: number,
  lit: Map<number, string>,
  accent: string,
  presentation: boolean
): void {
  ctx.fillStyle = COLORS.keyEdge
  ctx.fillRect(0, top, W, h)
  const bh = h * 0.63
  for (let p = LOWEST; p <= HIGHEST; p++) {
    if (isBlack(p)) continue
    const x = keys.x(p)
    const color = lit.get(p)
    const g = ctx.createLinearGradient(0, top, 0, top + h)
    g.addColorStop(0, color ?? COLORS.keyWhite)
    g.addColorStop(1, color ? hexA(color, 0.75) : COLORS.keyWhiteShade)
    ctx.fillStyle = g
    roundRect(ctx, x + 0.5, top + (color ? 2 : 0), keys.whiteW - 1, h - (color ? 2 : 0), 3)
    ctx.fill()
    if (p % 12 === 0 && keys.whiteW > 13) {
      ctx.fillStyle = 'rgba(20,24,36,0.55)'
      ctx.font = `${presentation ? 12 : 9}px "Segoe UI", system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      ctx.fillText(noteName(p), x + keys.whiteW / 2, top + h - 4)
      ctx.textAlign = 'left'
    }
  }
  for (let p = LOWEST; p <= HIGHEST; p++) {
    if (!isBlack(p)) continue
    const x = keys.x(p)
    const color = lit.get(p)
    ctx.fillStyle = color ?? COLORS.keyBlack
    roundRect(ctx, x, top, keys.blackW, bh, 2)
    ctx.fill()
    if (!color) {
      ctx.fillStyle = COLORS.keyBlackTop
      ctx.fillRect(x + 2, top + bh - 6, keys.blackW - 4, 4)
    }
  }
  // the rail notes land on
  ctx.fillStyle = accent
  ctx.fillRect(0, top - 2, W, 3)
  ctx.fillStyle = hexA(accent, 0.25)
  ctx.fillRect(0, top - 6, W, 4)
}

export function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

/** Hit-testing helpers shared by the editor. */
export interface NoteHit {
  trackId: number
  noteId: number
  /** which part of the note is under the pointer */
  part: 'body' | 'end' | 'start'
}

export function hitNote(s: Scene, px: number, py: number, edge = 6): NoteHit | null {
  const { song, height: H, time: t, pxPerSec: pps } = s
  const line = H - s.keyboardHeight
  if (py >= line) return null
  const keys = keyLayout(s.width)
  const map = tempoMap(song)
  const sec = t + (line - py) / pps
  // black notes are drawn on top, so test them first; active track wins ties
  const tracks = [...song.tracks].sort((a, b) => Number(b.id === s.activeTrackId) - Number(a.id === s.activeTrackId))
  for (const pass of [true, false]) {
    for (const track of tracks) {
      const times = trackTimes(track, map)
      const from = lowerBound(times.start, sec - times.maxDur - 1)
      const to = lowerBound(times.start, sec + edge / pps + 0.001)
      for (let i = to - 1; i >= from; i--) {
        const n = track.notes[i]
        if (isBlack(n.pitch) !== pass) continue
        const x = keys.x(n.pitch)
        if (px < x || px >= x + keys.w(n.pitch)) continue
        const yTop = line - (times.end[i] - t) * pps
        const yBot = Math.min(line, line - (times.start[i] - t) * pps)
        const top = Math.min(yTop, yBot - 3)
        if (py < top - 2 || py > yBot + 2) continue
        const h = yBot - top
        const e = Math.min(edge, h / 3)
        const part = py <= top + e ? 'end' : py >= yBot - e && yBot < line ? 'start' : 'body'
        return { trackId: track.id, noteId: n.id, part }
      }
    }
  }
  return null
}

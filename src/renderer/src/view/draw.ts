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

export const COLORS = {
  bg: '#0a0c14',
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
  rail: '#7c8cff',
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
  /** larger labels and no editing chrome, for video export */
  presentation?: boolean
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, rr)
}

export function drawScene(ctx: CanvasRenderingContext2D, s: Scene): void {
  const { song, width: W, height: H, time: t, pxPerSec: pps } = s
  const kbH = s.keyboardHeight
  const line = H - kbH
  const keys = keyLayout(W)
  const map = tempoMap(song)
  const rising = !!s.rising
  // visible window of song time
  const lo = rising ? t - line / pps : t
  const hi = rising ? t : t + line / pps

  ctx.fillStyle = COLORS.bg
  ctx.fillRect(0, 0, W, H)

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
  const yOf = (sec: number): number => (rising ? line - (t - sec) * pps : line - (sec - t) * pps)
  if (s.snapTicks && s.snapTicks > 1) {
    const g = s.snapTicks
    const spacing = (map.tickToSec(startTick + g) - map.tickToSec(startTick)) * pps
    if (spacing >= 9) {
      ctx.fillStyle = COLORS.sub
      for (let k = Math.ceil(startTick / g) * g; k <= endTick; k += g) ctx.fillRect(0, Math.round(yOf(map.tickToSec(k))), W, 1)
    }
  }
  ctx.font = `${s.presentation ? 14 : 11}px "Cascadia Mono", Consolas, monospace`
  ctx.textBaseline = 'bottom'
  for (let k = Math.floor(startTick / tpb) * tpb; k <= endTick; k += tpb) {
    const y = Math.round(yOf(map.tickToSec(k)))
    if (y > line) continue
    const isBar = Math.round(k) % Math.round(tpbar) === 0
    ctx.fillStyle = isBar ? COLORS.bar : COLORS.beat
    ctx.fillRect(0, y, W, isBar ? 1.5 : 1)
    if (isBar && !s.presentation) {
      ctx.fillStyle = COLORS.barLabel
      ctx.fillText(String(Math.round(k / tpbar) + 1), 6, y - 2)
    }
  }

  // notes
  const lit = new Map<number, string>()
  const anySel = s.selection && s.selection.size > 0
  const labelSize = s.presentation ? 13 : 10
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
    roundRect(ctx, x + pad, top, w - pad * 2, h, Math.min(6, w * 0.28))
    ctx.fill()
    ctx.globalAlpha = dim
    // darker edge reads as the note's attack
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.fillRect(x + pad + 1, rising ? top : bottom - Math.min(3, h), w - pad * 2 - 2, Math.min(3, h))
    if (ring) {
      ctx.globalAlpha = 1
      ctx.lineWidth = ring === 'select' ? 2 : 1
      ctx.strokeStyle = ring === 'select' ? COLORS.select : 'rgba(255,255,255,0.5)'
      roundRect(ctx, x + pad + 0.5, top + 0.5, w - pad * 2 - 1, h - 1, Math.min(6, w * 0.28))
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
      const from = lowerBound(times.start, lo - times.maxDur - 0.001)
      const to = lowerBound(times.start, hi)
      const dim = !audible ? 0.22 : 1
      for (let i = from; i < to; i++) {
        const n = track.notes[i]
        if (isBlack(n.pitch) !== pass) continue
        const st = times.start[i]
        const en = times.end[i]
        if (en <= lo) continue
        if (st <= t && en > t && audible) lit.set(n.pitch, track.color)
        const ring = anySel && s.selection!.has(n.id) ? 'select' : n.id === s.hoverId ? 'hover' : null
        drawNote(n.pitch, st, en, n.vel, track.color, dim, ring)
      }
    }
    if (s.take)
      for (const n of s.take)
        if (isBlack(n.pitch) === pass && n.end > lo && n.start < hi)
          drawNote(n.pitch, n.start, n.end, n.vel, s.liveColor ?? COLORS.rail, 1, null)
  }
  ctx.textAlign = 'left'

  if (s.liveKeys) for (const p of s.liveKeys.keys()) lit.set(p, s.liveColor ?? COLORS.rail)

  // glow where sounding notes meet the keyboard
  for (const [p, color] of lit) {
    const x = keys.x(p) + keys.w(p) / 2
    const g = ctx.createRadialGradient(x, line, 0, x, line, keys.whiteW * 1.8)
    g.addColorStop(0, hexA(color, 0.55))
    g.addColorStop(1, hexA(color, 0))
    ctx.fillStyle = g
    ctx.fillRect(x - keys.whiteW * 2, line - keys.whiteW * 2, keys.whiteW * 4, keys.whiteW * 2)
  }

  drawKeyboard(ctx, keys, W, line, kbH, lit, !!s.presentation)

  if (s.box) {
    const { x0, y0, x1, y1 } = s.box
    ctx.fillStyle = COLORS.boxFill
    ctx.strokeStyle = COLORS.boxLine
    ctx.lineWidth = 1
    ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
    ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0))
  }
}

function drawKeyboard(
  ctx: CanvasRenderingContext2D,
  keys: KeyLayout,
  W: number,
  top: number,
  h: number,
  lit: Map<number, string>,
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
  ctx.fillStyle = COLORS.rail
  ctx.fillRect(0, top - 2, W, 3)
  ctx.fillStyle = 'rgba(124,140,255,0.25)'
  ctx.fillRect(0, top - 6, W, 4)
}

function hexA(hex: string, a: number): string {
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

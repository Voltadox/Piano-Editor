import { useEffect, useRef } from 'react'
import { engine } from '../audio/engine'
import { isAudible, lowerBound, tempoMap, ticksPerBeat, trackTimes, type Note } from '../model/song'
import { setVelocities } from '../state/edit'
import { getState } from '../state/store'
import { timeAxis, type TimeAxis } from './draw'
import { keyboardHeight } from './FallView'

export const LANE_W = 96
const PAD = 8

/**
 * Velocity strip beside the stage, sharing its time axis: each note is a bar at its start time,
 * as long as it is loud. Drag across it to paint velocities onto the selected notes, or onto the
 * active track's notes when nothing is selected.
 */
export function VelocityLane(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const painting = useRef<{ lastY: number } | null>(null)
  const hover = useRef<{ x: number; y: number } | null>(null)

  const axis = (): { a: TimeAxis; h: number } => {
    const canvas = canvasRef.current!
    const stageW = (canvas.parentElement?.clientWidth ?? LANE_W * 4) - LANE_W
    const h = canvas.clientHeight
    const st = getState()
    const a = timeAxis({ height: h, keyboardHeight: keyboardHeight(stageW, h), pxPerSec: st.pxPerSec, time: engine.time(), rising: st.recording })
    return { a, h }
  }

  const editable = (): ((n: Note, trackId: number) => boolean) => {
    const { selection, activeTrackId } = getState()
    return selection.size ? (n) => selection.has(n.id) : (_n, trackId) => trackId === activeTrackId
  }

  const velAt = (x: number): number => Math.round(Math.min(127, Math.max(1, ((x - PAD) / (LANE_W - PAD * 2)) * 127)))

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d', { alpha: false })!
    let raf = 0
    const frame = (): void => {
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const { a } = axis()
      const { song } = getState()
      const map = tempoMap(song)
      const canEdit = editable()
      const inner = w - PAD * 2

      ctx.fillStyle = '#0e1120'
      ctx.fillRect(0, 0, w, h)
      // velocity guides at 32, 64, 96 and 127
      for (const v of [32, 64, 96, 127]) {
        ctx.fillStyle = v === 64 ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.05)'
        ctx.fillRect(Math.round(PAD + (inner * v) / 127), 0, 1, a.line)
      }
      // beats, matching the stage
      const tpb = ticksPerBeat(song)
      const from = Math.max(0, map.secToTick(Math.max(0, a.lo)))
      for (let k = Math.floor(from / tpb) * tpb; map.tickToSec(k) <= a.hi; k += tpb) {
        const y = Math.round(a.yOf(map.tickToSec(k)))
        if (y <= a.line) {
          ctx.fillStyle = 'rgba(255,255,255,0.05)'
          ctx.fillRect(0, y, w, 1)
        }
      }
      for (const pass of [false, true]) {
        for (const t of song.tracks) {
          const times = trackTimes(t, map)
          const audible = isAudible(t, song)
          for (let i = lowerBound(times.start, a.lo); i < times.start.length && times.start[i] <= a.hi; i++) {
            const n = t.notes[i]
            const on = canEdit(n, t.id)
            if (on !== pass) continue
            const y = Math.round(a.yOf(times.start[i]))
            if (y > a.line) continue
            const x = PAD + (inner * n.vel) / 127
            ctx.globalAlpha = on ? 1 : audible ? 0.22 : 0.1
            ctx.fillStyle = t.color
            ctx.fillRect(PAD, y - 1, x - PAD, 2)
            ctx.beginPath()
            ctx.arc(x, y, on ? 3.5 : 2.5, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      }
      ctx.globalAlpha = 1

      // label and readout where the keyboard sits
      ctx.fillStyle = '#05060a'
      ctx.fillRect(0, a.line, w, h - a.line)
      ctx.fillStyle = 'rgba(228,231,242,0.55)'
      ctx.font = '600 10px "Segoe UI", system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillText('VELOCITY', w / 2, a.line + 10)
      const hv = hover.current
      if (hv && hv.y < a.line) {
        ctx.fillStyle = '#e4e7f2'
        ctx.font = '600 15px "Cascadia Mono", Consolas, monospace'
        ctx.fillText(String(velAt(hv.x)), w / 2, a.line + 26)
        ctx.fillStyle = 'rgba(124,140,255,0.6)'
        ctx.fillRect(Math.round(hv.x), 0, 1, a.line)
      }
      ctx.textAlign = 'left'
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  const local = (e: React.PointerEvent): { x: number; y: number } => {
    const r = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  /** Sets every editable note starting between two y positions to the velocity under x. */
  const paint = (x: number, y0: number, y1: number): void => {
    const { a } = axis()
    const { song } = getState()
    const map = tempoMap(song)
    const tol = 4 / getState().pxPerSec
    const s0 = Math.min(a.secAt(y0), a.secAt(y1)) - tol
    const s1 = Math.max(a.secAt(y0), a.secAt(y1)) + tol
    const canEdit = editable()
    const vel = velAt(x)
    const out = new Map<number, number>()
    for (const t of song.tracks) {
      const times = trackTimes(t, map)
      for (let i = lowerBound(times.start, s0); i < times.start.length && times.start[i] <= s1; i++) {
        const n = t.notes[i]
        if (canEdit(n, t.id) && n.vel !== vel) out.set(n.id, vel)
      }
    }
    setVelocities(out)
  }

  return (
    <canvas
      ref={canvasRef}
      className="vel-lane"
      title="Velocity: drag across to set how loud notes are. Paints the selected notes, or the active track when nothing is selected."
      onPointerDown={(e) => {
        const { x, y } = local(e)
        if (e.button !== 0 || getState().recording || y >= axis().a.line) return
        ;(e.target as Element).setPointerCapture(e.pointerId)
        getState().beginGesture()
        painting.current = { lastY: y }
        paint(x, y, y)
      }}
      onPointerMove={(e) => {
        const { x, y } = local(e)
        hover.current = { x, y }
        const p = painting.current
        if (!p) return
        paint(x, p.lastY, y)
        p.lastY = y
      }}
      onPointerUp={() => {
        if (!painting.current) return
        painting.current = null
        getState().endGesture()
      }}
      onPointerLeave={() => (hover.current = null)}
      onWheel={(e) => engine.seek(Math.max(0, engine.time() - e.deltaY / getState().pxPerSec))}
    />
  )
}

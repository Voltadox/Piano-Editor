import { useEffect, useRef } from 'react'
import { engine } from '../audio/engine'
import { HIGHEST, LOWEST, isAudible, songDuration, tempoMap, ticksPerBar, trackTimes } from '../model/song'
import { getState } from '../state/store'

/** Whole-song strip: every note as a dot, the playhead, and click/drag to seek. */
export function Overview(): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const dragging = useRef(false)

  useEffect(() => {
    const canvas = ref.current!
    const ctx = canvas.getContext('2d')!
    let raf = 0
    // notes are drawn once per song change into an offscreen layer; each frame only adds the playhead
    const layer = document.createElement('canvas')
    const lctx = layer.getContext('2d')!
    let cache: { song: unknown; w: number } = { song: null, w: 0 }
    const loop = (): void => {
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
        cache.w = 0
      }
      const { song } = getState()
      const dur = Math.max(1, songDuration(song))
      if (cache.song !== song || cache.w !== canvas.width) {
        layer.width = canvas.width
        layer.height = canvas.height
        const ctx = lctx
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.fillStyle = '#0e1120'
        ctx.fillRect(0, 0, w, h)
        const map = tempoMap(song)
        const bar = ticksPerBar(song)
        ctx.fillStyle = 'rgba(255,255,255,0.06)'
        const barSec = map.tickToSec(bar)
        const every = Math.max(1, Math.ceil(((barSec / dur) * w < 6 ? 6 / ((barSec / dur) * w) : 1)))
        for (let b = 0; map.tickToSec(b * bar) < dur; b += every) ctx.fillRect(Math.round((map.tickToSec(b * bar) / dur) * w), 0, 1, h)
        for (const t of song.tracks) {
          const times = trackTimes(t, map)
          ctx.fillStyle = t.color
          ctx.globalAlpha = isAudible(t, song) ? 0.85 : 0.2
          t.notes.forEach((n, i) => {
            const x = (times.start[i] / dur) * w
            const nw = Math.max(1, ((times.end[i] - times.start[i]) / dur) * w)
            const y = h - 3 - ((n.pitch - LOWEST) / (HIGHEST - LOWEST)) * (h - 6)
            ctx.fillRect(x, y - 1, nw, 2)
          })
        }
        ctx.globalAlpha = 1
        cache = { song, w: canvas.width }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.drawImage(layer, 0, 0)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const x = (engine.time() / dur) * w
      ctx.fillStyle = 'rgba(124,140,255,0.18)'
      ctx.fillRect(0, 0, x, h)
      ctx.fillStyle = '#7c8cff'
      ctx.fillRect(Math.round(x) - 1, 0, 2, h)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const seekTo = (clientX: number): void => {
    const r = ref.current!.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    engine.seek(f * Math.max(1, songDuration(getState().song)))
  }

  return (
    <canvas
      ref={ref}
      className="overview"
      title="Song overview: click or drag to jump"
      onPointerDown={(e) => {
        dragging.current = true
        ;(e.target as Element).setPointerCapture(e.pointerId)
        seekTo(e.clientX)
      }}
      onPointerMove={(e) => dragging.current && seekTo(e.clientX)}
      onPointerUp={() => (dragging.current = false)}
    />
  )
}

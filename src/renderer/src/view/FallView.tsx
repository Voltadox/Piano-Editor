import { useEffect, useRef } from 'react'
import { engine } from '../audio/engine'
import { HIGHEST, LOWEST, lowerBound, snapTicks, snapTo, tempoMap, trackTimes, type Note } from '../model/song'
import { addNote, deleteNotes, mapNotes } from '../state/edit'
import { getState } from '../state/store'
import { pressKey, releaseKey } from '../audio/midiInput'
import { vocalLines } from '../audio/vocals'
import { countdown, viewClock } from '../actions/transport'
import { drawScene, hitNote, keyLayout, pianoKeyLength, type Scene } from './draw'

type Box = { x0: number; y0: number; x1: number; y1: number }

type Drag =
  | { kind: 'move'; originTick: number; originPitch: number; anchorTick: number; base: Map<number, Note>; lastPitch: number; ch: number }
  | { kind: 'end'; originTick: number; anchorEnd: number; base: Map<number, Note> }
  | { kind: 'start'; originTick: number; anchorStart: number; base: Map<number, Note> }
  | { kind: 'draw'; noteId: number; startTick: number }
  | { kind: 'box'; box: Box; additive: Set<number> }
  | { kind: 'key'; pitch: number; ch: number }

export const keyboardHeight = (w: number, h: number): number => Math.round(Math.min(h * 0.24, Math.max(90, pianoKeyLength(w))))

export function FallView(): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const size = useRef({ w: 1, h: 1, dpr: 1 })
  const drag = useRef<Drag | null>(null)
  const hoverId = useRef<number | undefined>(undefined)
  const box = useRef<Box | null>(null)

  const scene = (): Scene => {
    const st = getState()
    const active = st.song.tracks.find((t) => t.id === st.activeTrackId)
    const map = tempoMap(st.song)
    const clock = viewClock()
    return {
      song: clock.songVisible ? st.song : { ...st.song, tracks: [] },
      width: size.current.w,
      height: size.current.h,
      time: clock.time,
      pxPerSec: st.pxPerSec,
      keyboardHeight: keyboardHeight(size.current.w, size.current.h),
      selection: st.selection,
      hoverId: hoverId.current,
      box: box.current,
      snapTicks: st.snap === 'off' ? 0 : snapTicks(st.song.ppq, st.snap),
      activeTrackId: st.activeTrackId,
      liveKeys: engine.liveKeys,
      liveColor: active?.color,
      rising: clock.rising,
      take: clock.live,
      loop: st.loop && st.loopOn && clock.songVisible ? { start: map.tickToSec(st.loop.start), end: map.tickToSec(st.loop.end) } : null,
      hints: st.studio && st.studioChords ? st.studioHint : null,
      vocals: clock.songVisible ? vocalLines(st.song) : undefined,
      sections: st.song.sections,
      countdown: countdown(),
      theme: st.theme,
      bgImage: st.bgImage
    }
  }

  // sizing + render loop
  useEffect(() => {
    const canvas = canvasRef.current!
    const wrap = wrapRef.current!
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      size.current = { w: Math.max(1, r.width), h: Math.max(1, r.height), dpr }
      canvas.width = Math.round(r.width * dpr)
      canvas.height = Math.round(r.height * dpr)
    })
    ro.observe(wrap)
    const ctx = canvas.getContext('2d', { alpha: false })!
    let raf = 0
    const frame = (): void => {
      const { dpr } = size.current
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      drawScene(ctx, scene())
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const tickAt = (y: number): number => {
    const s = scene()
    const line = s.height - s.keyboardHeight
    return Math.max(0, tempoMap(s.song).secToTick(s.time + (line - y) / s.pxPerSec))
  }
  const grid = (): number => {
    const { song, snap } = getState()
    return snapTicks(song.ppq, snap)
  }
  const defaultLen = (): number => {
    const { song, snap } = getState()
    return snap === 'off' ? song.ppq / 4 : grid()
  }
  const activeTrack = () => {
    const { song, activeTrackId } = getState()
    return song.tracks.find((t) => t.id === activeTrackId) ?? song.tracks[0]
  }
  const channelOf = (trackId: number): number => getState().song.tracks.find((t) => t.id === trackId)?.channel ?? 0

  const selectionBase = (): Map<number, Note> => {
    const { song, selection } = getState()
    const base = new Map<number, Note>()
    for (const t of song.tracks) for (const n of t.notes) if (selection.has(n.id)) base.set(n.id, n)
    return base
  }

  const findNote = (id: number): { note: Note; trackId: number } | null => {
    for (const t of getState().song.tracks) {
      const note = t.notes.find((n) => n.id === id)
      if (note) return { note, trackId: t.id }
    }
    return null
  }

  const createNote = (x: number, y: number, len: number): Note | null => {
    const track = activeTrack()
    if (!track) return null
    const s = scene()
    const pitch = keyLayout(s.width).pitchAt(x)
    const g = grid()
    const tick = getState().snap === 'off' ? Math.round(tickAt(y)) : Math.floor(tickAt(y) / g) * g
    const note = addNote(track.id, { pitch, tick, dur: len, vel: 96 })
    getState().setSelection(new Set([note.id]))
    engine.previewNote(track.channel, pitch, 96)
    return note
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button === 1) return
    const { x, y } = local(e)
    const s = scene()
    const line = s.height - s.keyboardHeight
    const st = getState()
    ;(e.target as Element).setPointerCapture(e.pointerId)

    if (y >= line) {
      const pitch = keyLayout(s.width).pitchAt(x)
      void engine.init().then(() => pressKey(pitch, 100))
      drag.current = { kind: 'key', pitch, ch: 0 }
      return
    }
    // the view runs upward while recording and in Studio mode; note editing waits until it stops
    if (s.rising) return

    const hit = hitNote(s, x, y)
    if (e.button === 2) {
      // right-click deletes an unselected note; with a selection it opens the selection menu
      if (hit && !st.selection.has(hit.noteId)) deleteNotes(new Set([hit.noteId]))
      else if (st.selection.size) st.set({ contextMenu: { x: e.clientX, y: e.clientY } })
      return
    }

    if (hit) {
      let sel = st.selection
      if (e.ctrlKey || e.shiftKey) {
        sel = new Set(sel)
        if (sel.has(hit.noteId)) sel.delete(hit.noteId)
        else sel.add(hit.noteId)
        st.setSelection(sel)
        if (!sel.has(hit.noteId)) return
      } else if (!sel.has(hit.noteId)) {
        sel = new Set([hit.noteId])
        st.setSelection(sel)
      }
      const found = findNote(hit.noteId)!
      st.set({ activeTrackId: found.trackId })
      st.beginGesture()
      const base = selectionBase()
      const originTick = tickAt(y)
      const ch = channelOf(found.trackId)
      if (hit.part === 'end') drag.current = { kind: 'end', originTick, anchorEnd: found.note.tick + found.note.dur, base }
      else if (hit.part === 'start') drag.current = { kind: 'start', originTick, anchorStart: found.note.tick, base }
      else {
        drag.current = { kind: 'move', originTick, originPitch: found.note.pitch, anchorTick: found.note.tick, base, lastPitch: found.note.pitch, ch }
        engine.previewNote(ch, found.note.pitch, found.note.vel)
      }
      return
    }

    if (st.tool === 'draw') {
      st.beginGesture()
      const note = createNote(x, y, defaultLen())
      if (note) drag.current = { kind: 'draw', noteId: note.id, startTick: note.tick }
      return
    }

    const additive = e.ctrlKey || e.shiftKey ? new Set(st.selection) : new Set<number>()
    if (!additive.size) st.setSelection(new Set())
    box.current = { x0: x, y0: y, x1: x, y1: y }
    drag.current = { kind: 'box', box: box.current, additive }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const { x, y } = local(e)
    const d = drag.current
    const st = getState()
    if (!d) {
      const s = scene()
      const hit = s.rising ? null : hitNote(s, x, y)
      hoverId.current = hit?.noteId
      const c = canvasRef.current!
      c.style.cursor = hit ? (hit.part === 'body' ? 'grab' : 'ns-resize') : st.tool === 'draw' ? 'crosshair' : 'default'
      return
    }
    const g = grid()
    const free = e.altKey || st.snap === 'off'
    const snap = (tick: number): number => (free ? Math.round(tick) : snapTo(tick, g))
    const minLen = free ? 10 : g
    const raw = tickAt(y) - ('originTick' in d ? d.originTick : 0)

    switch (d.kind) {
      case 'move': {
        const s = scene()
        let dTick = snap(d.anchorTick + raw) - d.anchorTick
        let dPitch = keyLayout(s.width).pitchAt(x) - d.originPitch
        let minTick = Infinity
        let minP = Infinity
        let maxP = -Infinity
        for (const b of d.base.values()) {
          minTick = Math.min(minTick, b.tick)
          minP = Math.min(minP, b.pitch)
          maxP = Math.max(maxP, b.pitch)
        }
        dTick = Math.max(dTick, -minTick)
        dPitch = Math.max(LOWEST - minP, Math.min(HIGHEST - maxP, dPitch))
        const ids = new Set(d.base.keys())
        st.apply((song) =>
          mapNotes(song, ids, (n) => {
            const b = d.base.get(n.id)!
            return { ...n, tick: b.tick + dTick, pitch: b.pitch + dPitch }
          })
        )
        const p = d.originPitch + dPitch
        if (p !== d.lastPitch) {
          d.lastPitch = p
          engine.previewNote(d.ch, p, 90, 0.2)
        }
        break
      }
      case 'end': {
        const dEnd = snap(d.anchorEnd + raw) - d.anchorEnd
        const ids = new Set(d.base.keys())
        st.apply((song) =>
          mapNotes(song, ids, (n) => {
            const b = d.base.get(n.id)!
            return { ...n, dur: Math.max(minLen, b.dur + dEnd) }
          })
        )
        break
      }
      case 'start': {
        const dStart = snap(d.anchorStart + raw) - d.anchorStart
        const ids = new Set(d.base.keys())
        st.apply((song) =>
          mapNotes(song, ids, (n) => {
            const b = d.base.get(n.id)!
            const end = b.tick + b.dur
            const tick = Math.max(0, Math.min(end - minLen, b.tick + dStart))
            return { ...n, tick, dur: end - tick }
          })
        )
        break
      }
      case 'draw': {
        const t = tickAt(y)
        const end = free ? Math.round(t) : Math.ceil(t / g) * g
        const dur = Math.max(minLen, end - d.startTick)
        st.apply((song) => mapNotes(song, new Set([d.noteId]), (n) => ({ ...n, dur })))
        break
      }
      case 'box': {
        d.box.x1 = x
        d.box.y1 = y
        st.setSelection(notesInBox(d.box, d.additive))
        break
      }
      case 'key': {
        const s = scene()
        const pitch = keyLayout(s.width).pitchAt(x)
        if (pitch !== d.pitch && y >= s.height - s.keyboardHeight) {
          releaseKey(d.pitch)
          pressKey(pitch, 100)
          d.pitch = pitch
        }
        break
      }
    }
  }

  const onPointerUp = (): void => {
    const d = drag.current
    drag.current = null
    box.current = null
    if (!d) return
    if (d.kind === 'key') {
      releaseKey(d.pitch)
      return
    }
    if (d.kind !== 'box') getState().endGesture()
  }

  const notesInBox = (b: Box, additive: Set<number>): Set<number> => {
    const s = scene()
    const line = s.height - s.keyboardHeight
    const keys = keyLayout(s.width)
    const map = tempoMap(s.song)
    const secA = s.time + (line - Math.max(b.y0, b.y1)) / s.pxPerSec
    const secB = s.time + (line - Math.min(b.y0, b.y1)) / s.pxPerSec
    const xa = Math.min(b.x0, b.x1)
    const xb = Math.max(b.x0, b.x1)
    const out = new Set(additive)
    for (const t of s.song.tracks) {
      const times = trackTimes(t, map)
      const to = lowerBound(times.start, secB)
      for (let i = lowerBound(times.start, secA - times.maxDur); i < to; i++) {
        if (times.end[i] < secA) continue
        const n = t.notes[i]
        const nx = keys.x(n.pitch)
        if (nx + keys.w(n.pitch) >= xa && nx <= xb) out.add(n.id)
      }
    }
    return out
  }

  const onDoubleClick = (e: React.MouseEvent): void => {
    const { x, y } = local(e)
    const s = scene()
    if (s.rising || y >= s.height - s.keyboardHeight || hitNote(s, x, y) || getState().tool === 'draw') return
    createNote(x, y, defaultLen())
  }

  const onWheel = (e: React.WheelEvent): void => {
    const st = getState()
    if (e.ctrlKey) {
      const next = Math.min(1200, Math.max(30, st.pxPerSec * Math.exp(-e.deltaY * 0.0015)))
      st.set({ pxPerSec: next })
      return
    }
    engine.seek(Math.max(0, engine.time() - e.deltaY / st.pxPerSec))
  }

  return (
    <div ref={wrapRef} className="fall-wrap">
      <canvas
        ref={canvasRef}
        className="fall-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => (hoverId.current = undefined)}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  )
}

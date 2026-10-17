import { engine } from '../audio/engine'
import { beginTake, commitTake, liveTake, liveTrail, wallNow, type LiveNote } from '../audio/midiInput'
import { songEndTick, tempoMap, ticksPerBar, ticksPerBeat } from '../model/song'
import { savePref } from '../state/prefs'
import { getState, useStore } from '../state/store'

export async function togglePlay(): Promise<void> {
  const st = getState()
  if (st.playing) {
    stop()
    return
  }
  await engine.play()
  getState().set({ playing: true })
}

export function stop(): void {
  const st = getState()
  engine.pause()
  engine.freeRun = false
  if (st.recording) {
    const n = commitTake()
    getState().notify(n ? `Recorded ${n} note${n === 1 ? '' : 's'} into the active track` : 'Nothing was recorded')
  }
  getState().set({ playing: false, recording: false })
}

export async function toggleRecord(): Promise<void> {
  const st = getState()
  if (st.recording) {
    stop()
    return
  }
  if (!st.midiInputs.length) {
    st.notify('Connect a USB MIDI keyboard to record. It is picked up automatically.', 'error')
    return
  }
  beginTake()
  engine.freeRun = true
  getState().set({ recording: true })
  if (st.playing) return
  const { song, loop, loopOn, countIn } = getState()
  const map = tempoMap(song)
  // with a loop on, each take starts at the top of the loop
  if (loopOn && loop) engine.seek(map.tickToSec(loop.start))
  const tick = map.secToTick(engine.time())
  const preroll = (countIn * ticksPerBar(song) * 60) / (map.bpmAt(tick) * song.ppq)
  await engine.play(preroll)
  getState().set({ playing: true })
}

/** Beats left in the count-in, or 0 once it is over. */
export function countdown(): number {
  const t = engine.time()
  if (!getState().recording || t >= engine.prerollEnd) return 0
  const { song } = getState()
  const map = tempoMap(song)
  const beat = (ticksPerBeat(song) * 60) / (map.bpmAt(0) * song.ppq)
  return Math.ceil((engine.prerollEnd - t) / beat - 1e-6)
}

export function goToStart(): void {
  engine.seek(getState().loopOn && getState().loop ? tempoMap(getState().song).tickToSec(getState().loop!.start) : 0)
}

export function seekBy(sec: number): void {
  engine.seek(Math.max(0, engine.time() + sec))
}

// ---------- metronome ----------

export function toggleMetronome(): void {
  const on = !getState().metronome
  getState().set({ metronome: on })
  savePref('metronome', on)
}

export function setCountIn(bars: number): void {
  getState().set({ countIn: bars })
  savePref('countIn', bars)
}

// ---------- loop ----------

export function setLoop(start: number, end: number): void {
  if (end - start < 1) return
  getState().set({ loop: { start, end }, loopOn: true })
}

/**
 * With notes selected, loops the bars they cover. Otherwise turns the loop on or off,
 * creating a four-bar loop from the current bar the first time.
 */
export function toggleLoop(): void {
  const { song, selection, loop, loopOn } = getState()
  const bar = ticksPerBar(song)
  if (selection.size) {
    let lo = Infinity
    let hi = -Infinity
    for (const t of song.tracks)
      for (const n of t.notes)
        if (selection.has(n.id)) {
          lo = Math.min(lo, n.tick)
          hi = Math.max(hi, n.tick + n.dur)
        }
    setLoop(Math.floor(lo / bar) * bar, Math.max(Math.ceil(hi / bar), Math.floor(lo / bar) + 1) * bar)
    return
  }
  if (loop) {
    getState().set({ loopOn: !loopOn })
    return
  }
  // past the end of the song, loop its last four bars instead
  const at = Math.min(tempoMap(song).secToTick(engine.time()), Math.max(0, songEndTick(song) - bar * 4))
  const here = Math.floor(at / bar) * bar
  setLoop(here, here + bar * 4)
}

/** Keeps the engine's metronome and loop in step with the store. */
export function syncTransport(): () => void {
  const apply = (): void => {
    const { metronome, loop, loopOn, song } = getState()
    engine.metronome = metronome
    const map = tempoMap(song)
    engine.setLoop(loop && loopOn ? { start: map.tickToSec(loop.start), end: map.tickToSec(loop.end) } : null)
  }
  apply()
  return useStore.subscribe((s, p) => {
    if (s.metronome !== p.metronome || s.loop !== p.loop || s.loopOn !== p.loopOn || s.song.tempos !== p.song.tempos) apply()
  })
}

// ---------- live view ----------

export interface ViewClock {
  /** time runs upward, notes rising out of the keys */
  rising: boolean
  time: number
  /** false while Studio mode is idle: the stage shows only what is being played */
  songVisible: boolean
  live: LiveNote[] | undefined
}

/**
 * Recording and Studio mode run the stage upward. Studio mode with the transport stopped
 * runs on the wall clock, so a jam trails up the screen without the song moving.
 */
export function viewClock(): ViewClock {
  const { recording, studio, playing } = getState()
  if (recording) return { rising: true, time: engine.time(), songVisible: true, live: liveTake() }
  if (studio && playing) return { rising: true, time: engine.time(), songVisible: true, live: liveTrail(engine.time()) }
  if (studio) {
    const t = wallNow()
    return { rising: true, time: t, songVisible: false, live: liveTrail(t) }
  }
  return { rising: false, time: engine.time(), songVisible: true, live: undefined }
}

export function toggleStudio(): void {
  const on = !getState().studio
  getState().set({ studio: on, studioHint: null })
  savePref('studio', on)
}

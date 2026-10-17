import { engine } from '../audio/engine'
import { beginTake, commitTake } from '../audio/midiInput'
import { getState } from '../state/store'

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
  if (!st.playing) {
    await engine.play()
    getState().set({ playing: true })
  }
}

export function goToStart(): void {
  engine.seek(0)
}

export function seekBy(sec: number): void {
  engine.seek(Math.max(0, engine.time() + sec))
}

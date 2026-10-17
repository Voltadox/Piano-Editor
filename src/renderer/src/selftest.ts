import { engine } from './audio/engine'
import { DEFAULT_VIDEO, exportAudio, exportVideo } from './actions/export'
import { loadMidiBytes, loadSoundfontBytes } from './actions/files'
import { writeMidiFile } from './model/midiio'
import { getState } from './state/store'

const log = (...a: unknown[]): void => console.log('[selftest]', ...a)
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Developer check run with `--selftest=<soundfont>|<outDir>`; never runs in normal use. */
export async function runSelftest(arg: string): Promise<void> {
  const [sfPath, outDir] = arg.split('|')
  try {
    const sf = await window.keyfall.readFile(sfPath)
    if (!sf) throw new Error(`cannot read ${sfPath}`)
    await loadSoundfontBytes(sf.data.buffer.slice(sf.data.byteOffset, sf.data.byteOffset + sf.data.byteLength) as ArrayBuffer, sf.name, null)
    log('soundfont', getState().sfName, 'presets', engine.synth?.presetList.length)

    // MIDI round trip
    const before = getState().song
    const bytes = writeMidiFile(before, 'roundtrip')
    const notesBefore = before.tracks.reduce((a, t) => a + t.notes.length, 0)
    loadMidiBytes(bytes, 'roundtrip.mid', null)
    const after = getState().song
    const notesAfter = after.tracks.reduce((a, t) => a + t.notes.length, 0)
    log('roundtrip notes', notesBefore, '->', notesAfter, 'tracks', after.tracks.length, 'bpm', after.tempos[0].bpm)

    await engine.play()
    getState().set({ playing: true })
    await wait(1500)
    log('playhead after 1.5s', engine.time().toFixed(2), 'voices', engine.synth?.voiceCount, 'ctx', engine.ctx?.state)
    engine.pause()
    getState().set({ playing: false })
    engine.seek(4.8)

    await exportAudio('wav', `${outDir}/selftest.wav`)
    await exportAudio('mp3', `${outDir}/selftest.mp3`)
    getState().set({ fileName: 'selftest' })
    await exportVideo({ ...DEFAULT_VIDEO, size: '720p', fps: 30 }, outDir)
    log('toast', getState().toast?.text)

    // decode a frame of the exported video to confirm the picture survived encoding
    const vid = await window.keyfall.readFile(`${outDir}/selftest.mp4`)
    if (vid) {
      const el = document.createElement('video')
      el.muted = true
      el.src = URL.createObjectURL(new Blob([vid.data as Uint8Array<ArrayBuffer>], { type: 'video/mp4' }))
      await new Promise((r) => (el.onloadeddata = r))
      el.currentTime = 6
      await new Promise((r) => (el.onseeked = r))
      log('video', el.videoWidth, 'x', el.videoHeight, 'duration', el.duration.toFixed(2))
      const c = document.createElement('canvas')
      c.width = el.videoWidth
      c.height = el.videoHeight
      c.getContext('2d')!.drawImage(el, 0, 0)
      const png = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))
      await window.keyfall.writeFile(`${outDir}/frame.png`, new Uint8Array(await png.arrayBuffer()))
    }
  } catch (err) {
    log('FAILED', err instanceof Error ? err.stack : String(err))
  }
  window.keyfall.selftestDone()
}

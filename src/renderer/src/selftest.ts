import { engine } from './audio/engine'
import { DEFAULT_VIDEO, exportAudio, exportVideo } from './actions/export'
import { loadMidiBytes, loadSoundfontBytes } from './actions/files'
import { setLoop, toggleMetronome, toggleRecord, toggleStudio } from './actions/transport'
import { pressKey, releaseKey, shapeVelocity } from './audio/midiInput'
import { detectKey, keyName, recognizeChord, suggestChords } from './model/harmony'
import { writeMidiFile } from './model/midiio'
import { emptySong, tempoMap, ticksPerBar } from './model/song'
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
    await grabFrame(`${outDir}/selftest.mp4`, `${outDir}/frame.png`, 6)

    getState().set({ fileName: 'selftest-rising' })
    await exportVideo({ ...DEFAULT_VIDEO, style: 'rising', size: '720p', fps: 30, artist: 'Keyfall', caption: 'Self-test' }, outDir)
    log('toast', getState().toast?.text)
    await grabFrame(`${outDir}/selftest-rising.mp4`, `${outDir}/frame-rising.png`, 6)
    await grabFrame(`${outDir}/selftest-rising.mp4`, `${outDir}/frame-title.png`, 0.5)

    // the loop should hold the playhead inside bars 1-2 (with the clock jumping back seamlessly)
    const { song } = getState()
    const bar = ticksPerBar(song)
    setLoop(0, bar * 2)
    const loopEnd = tempoMap(song).tickToSec(bar * 2)
    toggleMetronome()
    engine.seek(0)
    await engine.play()
    getState().set({ playing: true })
    let maxT = 0
    let wraps = 0
    let last = 0
    for (let i = 0; i < 120; i++) {
      await wait(50)
      const t = engine.time()
      if (t < last - 0.5) wraps++
      last = t
      maxT = Math.max(maxT, t)
    }
    log('loop end', loopEnd.toFixed(2), 'max playhead', maxT.toFixed(2), 'wraps in 6s', wraps)
    engine.pause()
    toggleMetronome()
    getState().set({ playing: false, loopOn: false })

    // harmony helpers
    log('chord A C E ->', recognizeChord([57, 60, 64])?.name, '· G B D F ->', recognizeChord([55, 59, 62, 65])?.name)
    const cMajor = new Array(12).fill(0)
    for (const pc of [0, 2, 4, 5, 7, 9, 11]) cMajor[pc] = pc === 0 || pc === 7 ? 3 : 1
    const key = detectKey(cMajor)
    log('key of C major scale ->', key && keyName(key), '· after Am:', suggestChords(key, [], recognizeChord([57, 60, 64]), 60).map((s) => `${s.chord.name}(${s.numeral})`).join(' '))
    getState().set({ velEven: 0.8, velLevel: 90 })
    log('velocity 20 and 127 evened ->', shapeVelocity(20), shapeVelocity(127))
    getState().set({ velEven: 0 })

    // velocity lane with the song playing
    getState().set({ laneOpen: true })
    engine.seek(0.4)
    await engine.play()
    getState().set({ playing: true })
    await wait(700)
    engine.pause()
    getState().set({ playing: false })
    await wait(300)
    await window.keyfall.selftestCapture(`${outDir}/window-lane.png`)

    // studio mode: play an A minor chord on the on-screen keys and let the panel react
    getState().set({ laneOpen: false })
    toggleStudio()
    for (const p of [57, 60, 64]) pressKey(p, 90)
    await wait(1200)
    log('studio hint', getState().studioHint?.join(','))
    await window.keyfall.selftestCapture(`${outDir}/window-studio.png`)
    for (const p of [57, 60, 64]) releaseKey(p)
    toggleStudio()

    getState().set({ videoOpen: true })
    await wait(400)
    await window.keyfall.selftestCapture(`${outDir}/window-video.png`)
    getState().set({ videoOpen: false })

    // recording into a brand-new, empty song must keep running (with its count-in) until stopped
    getState().loadSong(emptySong(), 'Untitled', null)
    engine.seek(0)
    getState().set({ midiInputs: ['selftest keyboard'] })
    await toggleRecord()
    await wait(2600)
    pressKey(60, 100)
    await wait(500)
    releaseKey(60)
    await wait(400)
    log('recording empty song: still recording', getState().recording, 'playhead', engine.time().toFixed(2))
    await toggleRecord()
    const rec = getState().song.tracks[0].notes
    log('recorded notes', rec.length, rec.map((n) => `pitch ${n.pitch} tick ${n.tick} dur ${n.dur}`).join('; '), '·', getState().toast?.text)
    await wait(300)
  } catch (err) {
    log('FAILED', err instanceof Error ? err.stack : String(err))
  }
  window.keyfall.selftestDone()
}

/** Decodes one frame of an exported video to confirm the picture survived encoding. */
async function grabFrame(videoPath: string, pngPath: string, at: number): Promise<void> {
  const vid = await window.keyfall.readFile(videoPath)
  if (!vid) {
    log('missing', videoPath)
    return
  }
  const el = document.createElement('video')
  el.muted = true
  el.src = URL.createObjectURL(new Blob([vid.data as Uint8Array<ArrayBuffer>], { type: 'video/mp4' }))
  await new Promise((r) => (el.onloadeddata = r))
  el.currentTime = at
  await new Promise((r) => (el.onseeked = r))
  log('video', videoPath, el.videoWidth, 'x', el.videoHeight, 'duration', el.duration.toFixed(2))
  const c = document.createElement('canvas')
  c.width = el.videoWidth
  c.height = el.videoHeight
  c.getContext('2d')!.drawImage(el, 0, 0)
  const png = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))
  await window.keyfall.writeFile(pngPath, new Uint8Array(await png.arrayBuffer()))
}

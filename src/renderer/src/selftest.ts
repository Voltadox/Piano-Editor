import { engine } from './audio/engine'
import { DEFAULT_VIDEO, exportAudio, exportVideo } from './actions/export'
import { loadMidiBytes, loadSoundfontBytes } from './actions/files'
import { setLoop, toggleMetronome, toggleRecord, toggleStudio } from './actions/transport'
import { pressKey, releaseKey, shapeVelocity } from './audio/midiInput'
import { detectKey, keyName, recognizeChord, suggestChords } from './model/harmony'
import { splitHands } from './model/hands'
import { packProject, unpackProject } from './actions/project'
import { usePresetBackground } from './actions/look'
import { detectPitch, pitchShifts, psola } from './audio/pitch'
import { addTake, getTake } from './audio/takes'
import { processAll } from './audio/vocals'
import { addSection, duplicateSection, generateDrums, moveSection } from './state/arrange'
import { addAudioTrack, addRecordedPasses } from './state/vocalEdit'
import { selectAll, selectionSustained, setSustain } from './state/edit'
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
    // hand split, scored against the demo song's real left and right hand tracks
    {
      const tracks = getState().song.tracks
      const truth = new Map<string, 'L' | 'R'>()
      for (const tr of tracks) for (const n of tr.notes) truth.set(`${n.tick}:${n.pitch}`, /left/i.test(tr.name) ? 'L' : 'R')
      const merged = tracks.flatMap((tr) => tr.notes.map(({ pitch, tick, dur, vel }) => ({ pitch, tick, dur, vel })))
      const { left, right } = splitHands(merged, 48)
      const right_ = left.filter((n) => truth.get(`${n.tick}:${n.pitch}`) === 'L').length + right.filter((n) => truth.get(`${n.tick}:${n.pitch}`) === 'R').length
      log('hand split on demo song:', right_, 'of', merged.length, 'notes assigned correctly')
    }
    getState().set({ velEven: 0.8, velLevel: 90 })
    // sustain under the whole demo song, then off again
    selectAll()
    setSustain(true)
    const pedal = getState().song.tracks.map((tr) => tr.ccs.filter((c) => c.num === 64).length)
    const ticked = selectionSustained()
    setSustain(false)
    log('sustain: pedal events per track', pedal.join('/'), '· tickbox', ticked, '-> after untick', selectionSustained())
    getState().setSelection(new Set())
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
    getState().set({ studioChords: false })
    await wait(800)
    await window.keyfall.selftestCapture(`${outDir}/window-studio-plain.png`)
    await wait(800)
    await window.keyfall.selftestCapture(`${outDir}/window-studio-plain2.png`)
    log('studio without chords: hint', getState().studioHint)
    getState().set({ studioChords: true })
    for (const p of [57, 60, 64]) releaseKey(p)
    toggleStudio()

    getState().set({ videoOpen: true })
    await wait(400)
    await window.keyfall.selftestCapture(`${outDir}/window-video.png`)
    getState().set({ videoOpen: false })

    log('soundfont presets', getState().sfPresets.length, getState().sfPresets.slice(0, 3).map((p) => `${p.name} ${p.bank}:${p.program}`).join(', '))

    // autotune: a hummed "voice" 40 cents flat of A3 with vibrato, tuned to C major
    {
      const rate = 48000
      const n = rate * 2
      const voice = new Float32Array(n)
      let phase = 0
      for (let i = 0; i < n; i++) {
        const t = i / rate
        const f = 220 * Math.pow(2, (-0.4 + 0.15 * Math.sin(2 * Math.PI * 5 * t)) / 12)
        phase += (2 * Math.PI * f) / rate
        // a few harmonics with a vowel-like falloff, fading in and out
        let v = 0
        for (let h = 1; h <= 8; h++) v += Math.sin(phase * h) / (h * h * 0.6 + 0.4)
        voice[i] = 0.3 * v * Math.min(1, t * 8, (2 - t) * 8)
      }
      const median = (f: Float32Array): number => {
        const v = [...f].filter((x) => x > 0).sort((a, b) => a - b)
        return v[v.length >> 1] ?? 0
      }
      const f0 = detectPitch(voice, rate)
      const settings = { mode: 'key' as const, speed: 1, scale: [0, 2, 4, 5, 7, 9, 11], transpose: 0, detune: 0, formant: 0 }
      const tuned = psola(voice, rate, f0, pitchShifts(f0, settings).shift, 0)
      const airy = psola(voice, rate, f0, pitchShifts(f0, settings).shift, 3)
      log('autotune: sung', median(f0).toFixed(1), 'Hz -> tuned', median(detectPitch(tuned, rate)).toFixed(1), 'Hz (A3 = 220) · with formant +3:', median(detectPitch(airy, rate)).toFixed(1), 'Hz')

      // as a vocal track: saved into a project file, reopened, and mixed into a WAV export
      const trackId = addAudioTrack('Vocals')
      const takeId = addTake(voice, rate)
      addRecordedPasses(trackId, [{ tick: getState().song.ppq * 4, duration: n / rate, takeId }])
      await processAll(getState().song)
      // the tuned melody should show as a line over A3 as it comes down
      engine.seek(1.7)
      await wait(700)
      await window.keyfall.selftestCapture(`${outDir}/window-ribbon-a.png`)
      await wait(700)
      await window.keyfall.selftestCapture(`${outDir}/window-ribbon.png`)
      const packed = await packProject(getState().song)
      const back = unpackProject(packed)
      log('project file', (packed.length / 1024).toFixed(0), 'KB · reopened vocal tracks', back.audioTracks.length, 'clips', back.audioTracks[0]?.clips.length, 'take found', !!getTake(back.audioTracks[0]?.clips[0]?.takes[0] ?? ''))
      await exportAudio('wav', `${outDir}/selftest-vocals.wav`)
      log('export with vocals:', getState().toast?.text)
    }

    // beat generated to follow the demo song
    generateDrums('lofi', 42)
    {
      const drums = getState().song.tracks.find((t) => t.beat)!
      log('beat:', drums.beat!.patterns.map((p) => p.name).join(', '), '· bars', drums.beat!.bars.length, '· notes', drums.notes.length)
    }

    // sections: mark verse and chorus, play the chorus twice, then move it first
    addSection(0, 'Verse')
    addSection(4, 'Chorus')
    const sectionNotes0 = getState().song.tracks.reduce((a, t) => a + t.notes.length, 0)
    duplicateSection(getState().song.sections[1].id)
    const sectionNotes1 = getState().song.tracks.reduce((a, t) => a + t.notes.length, 0)
    moveSection(getState().song.sections.find((s) => s.name === 'Chorus')!.id, -1)
    log('sections:', getState().song.sections.map((s) => `${s.name}@${s.bar + 1}`).join(' '), '· notes', sectionNotes0, '->', sectionNotes1)

    // the studio panel with vocals, a background photo and the pitch line on stage
    await usePresetBackground('misty-pines.jpg')
    getState().set({ drawerOpen: true, drawerTab: 'vocals' })
    engine.seek(1.6)
    await wait(1500)
    await window.keyfall.selftestCapture(`${outDir}/window-vocals.png`)
    await wait(900)
    await window.keyfall.selftestCapture(`${outDir}/window-vocals2.png`)
    getState().set({ drawerTab: 'beat' })
    await wait(600)
    await window.keyfall.selftestCapture(`${outDir}/window-beat.png`)
    getState().set({ drawerTab: 'mixer' })
    await wait(600)
    await window.keyfall.selftestCapture(`${outDir}/window-mixer.png`)
    getState().set({ drawerOpen: false })

    // recording into a brand-new, empty song must keep running (with its count-in) until stopped
    getState().loadSong(emptySong(), 'Untitled', null)
    engine.seek(0)
    getState().set({ midiInputs: ['selftest keyboard'] })
    await toggleRecord()
    await wait(2600)
    // a bass note with the left hand under a chord and melody in the right
    pressKey(43, 100)
    pressKey(64, 100)
    pressKey(67, 100)
    pressKey(72, 100)
    await wait(500)
    for (const p of [43, 64, 67, 72]) releaseKey(p)
    pressKey(76, 90)
    await wait(300)
    releaseKey(76)
    await wait(400)
    log('recording empty song: still recording', getState().recording, 'playhead', engine.time().toFixed(2))
    await toggleRecord()
    log('recorded:', getState().song.tracks.map((tr) => `${tr.name} [${tr.notes.map((n) => n.pitch).join(' ')}]`).join(' · '), '·', getState().toast?.text)
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

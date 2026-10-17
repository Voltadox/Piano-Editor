import { engine } from './audio/engine'
import { DEFAULT_VIDEO, exportAudio, exportVideo } from './actions/export'
import { applyBackupFont, loadMidiBytes, loadSoundfontBytes } from './actions/files'
import { SoundBankLoader, SpessaSynthProcessor } from 'spessasynth_core'
import { setLoop, setPlaybackRate, toggleMetronome, toggleRecord, toggleStudio } from './actions/transport'
import { pressKey, releaseKey, shapeVelocity } from './audio/midiInput'
import { detectKey, keyName, recognizeChord, suggestChords } from './model/harmony'
import { splitHands } from './model/hands'
import { packProject, unpackProject } from './actions/project'
import { usePresetBackground } from './actions/look'
import { detectPitch, pitchShifts, psola } from './audio/pitch'
import { addTake, getTake } from './audio/takes'
import { closeMic, loadRecorderWorklet, micLevel, openMic } from './audio/vocalRecorder'
import { processAll } from './audio/vocals'
import { addSection, copyReferenceGroove, duplicateSection, generateDrums, moveSection } from './state/arrange'
import { chordLabel, importReferenceAudio, keyLabel, setChordAt } from './actions/reference'
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

    // the mic capture worklet must load under the page's security policy
    await loadRecorderWorklet().then(
      () => log('recorder worklet loaded'),
      (e) => log('recorder worklet FAILED to load', e instanceof Error ? e.message : String(e))
    )
    // and the microphone should open through it (if this computer has one)
    await openMic().then(
      async () => {
        await wait(500)
        log('microphone opened · input level', micLevel().toFixed(4))
        closeMic()
      },
      (e) => log('microphone did not open:', e instanceof Error ? `${e.name}: ${e.message}` : String(e))
    )
    // loading a soundfont while the backup loads must not leave either one stuck "Loading…"
    await applyBackupFont(false)
    const both = Promise.all([applyBackupFont(true), loadSoundfontBytes(sf.data.buffer.slice(sf.data.byteOffset, sf.data.byteOffset + sf.data.byteLength) as ArrayBuffer, sf.name, null)])
    const settled = await Promise.race([both.then(() => true), wait(15000).then(() => false)])
    log('soundfont + backup loaded together:', settled ? 'both finished' : 'STUCK', '· still loading:', getState().sfLoading)
    // the bundled backup soundfont should supply drums behind the user's piano soundfont
    await applyBackupFont(true)
    {
      const core = new SpessaSynthProcessor(48000, { eventsEnabled: false, effectsEnabled: false })
      core.soundBankManager.addSoundBank(SoundBankLoader.fromArrayBuffer(sf.data.buffer.slice(sf.data.byteOffset, sf.data.byteOffset + sf.data.byteLength) as ArrayBuffer), 'main')
      core.soundBankManager.addSoundBank(SoundBankLoader.fromArrayBuffer(engine.backupBytes!.slice(0)), 'backup')
      core.soundBankManager.priorityOrder = ['main', 'backup']
      await core.processorInitialized
      core.programChange(0, 0)
      core.programChange(9, 0)
      core.noteOn(9, 36, 120)
      const l = new Float32Array(24000)
      const r = new Float32Array(24000)
      for (let pos = 0; pos < 24000; pos += 128) core.process(l, r, pos, 128)
      let peak = 0
      for (const v of l) peak = Math.max(peak, Math.abs(v))
      log('backup soundfont: channel 1 plays', core.midiChannels[0].preset?.name, '· drum channel plays', core.midiChannels[9].preset?.name, '· kick peak', peak.toFixed(3))
    }
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

    // reference mode: a synthetic 96 BPM song (Am F C G verse, F G Am Am / F G C C chorus, verse),
    // drums on 1-3 / 2-4 / eighths, with a 0.37 s lead-in, imported into a new song
    {
      getState().loadSong(emptySong(), 'Reference test', null)
      const sr = 48000
      const beatSec = 60 / 96
      const lead = 0.37
      const plan = [0, 1, 2, 3, 0, 1, 2, 3, 1, 3, 0, 0, 1, 3, 2, 2, 0, 1, 2, 3, 0, 1, 2, 3]
      const triads = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]
      const n = Math.ceil((lead + plan.length * 4 * beatSec + 1) * sr)
      const x = new Float32Array(n)
      let seed = 7
      const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
      const hz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12)
      plan.forEach((p, b) => {
        const t0 = lead + b * 4 * beatSec
        const s0 = Math.floor(t0 * sr)
        for (let i = 0; i < Math.floor(4 * beatSec * sr); i++) {
          let v = 0
          for (const m of triads[p]) for (let h = 1; h <= 4; h++) v += Math.sin((2 * Math.PI * hz(m) * h * i) / sr) / (h * 3)
          v += 0.8 * Math.sin((2 * Math.PI * hz(triads[p][0] - 24) * i) / sr)
          x[s0 + i] += 0.05 * v
        }
        for (let q = 0; q < 8; q++) {
          const s = Math.floor((t0 + (q * beatSec) / 2) * sr)
          // hats: noise through a resonator ringing around 8 kHz, like a real closed hi-hat
          const wr = (2 * Math.PI * 8000) / sr
          const rr = 0.9
          let y1 = 0
          let y2 = 0
          for (let i = 0; i < 1700; i++) {
            const y = 2 * rr * Math.cos(wr) * y1 - rr * rr * y2 + (1 - rr) * rnd()
            y2 = y1
            y1 = y
            x[s + i] += 0.35 * y * Math.exp(-i / 320)
          }
          if (q % 2) continue
          if (q === 0 || q === 4) for (let i = 0; i < 13000; i++) x[s + i] += 0.6 * Math.sin((2 * Math.PI * (55 + 80 * Math.exp(-i / 870)) * i) / sr) * Math.exp(-i / 5400)
          else for (let i = 0; i < 11000; i++) x[s + i] += 0.25 * rnd() * Math.exp(-i / 2600)
        }
      })
      const buf = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: sr })
      buf.copyToChannel(x, 0)
      buf.copyToChannel(x, 1)
      await importReferenceAudio('synthetic-96bpm.wav', buf)
      const song = getState().song
      const map = tempoMap(song)
      const ref = song.audioTracks.find((t) => t.kind === 'reference')!
      const clip = ref.clips[0]
      // where does the audio's first downbeat (0.37 s into the file) land on the song's grid?
      const audioToSong = (sec: number): number => map.tickToSec(clip.tick) - clip.offset + sec
      const downTick = map.secToTick(audioToSong(lead))
      const barTicks = ticksPerBar(song)
      log('reference: tempo', song.tempos.map((t) => t.bpm.toFixed(2)).join(','), '· first downbeat at bar', (downTick / barTicks + 1).toFixed(3), '· bar 10 lands at', ((map.secToTick(audioToSong(lead + 9 * 4 * beatSec)) / barTicks) + 1).toFixed(3))
      const names = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
      log('reference: key', song.key && keyLabel(song.key.tonic, song.key.minor), '· chords', song.chords.slice(0, 14).map((c) => `${c.root < 0 ? 'N' : names[c.root] + (c.minor ? 'm' : '')}@${(c.tick / barTicks + 1).toFixed(2)}`).join(' '))
      log('reference: sections', song.sections.map((s) => `${s.name}@${s.bar + 1}`).join(' '), '· chord pad notes', song.tracks.find((t) => t.role === 'chords')?.notes.length)
      generateDrums('lofi', 3)
      const beat1 = getState().song.tracks.find((t) => t.beat)!.beat!
      copyReferenceGroove()
      const beat2 = getState().song.tracks.find((t) => t.beat)!.beat!
      const g = beat2.patterns[0]
      log('reference: matching beat', beat1.patterns.length, 'patterns over', beat1.bars.length, 'bars · copied groove', beat2.patterns.length, 'patterns; first:', [36, 38, 42].map((p) => g.hits[p].map((v) => (v ? 'x' : '.')).join('')).join(' | '))
      const padBefore = getState().song.tracks.find((t) => t.role === 'chords')!.notes.length
      setChordAt(0, { root: 2, minor: true })
      log('reference: chord 1 changed to', chordLabel(getState().song.chords[0]), '· pad notes', padBefore, '->', getState().song.tracks.find((t) => t.role === 'chords')!.notes.length)
      setChordAt(0, { root: 9, minor: true })
      // practice speed: 75% should advance the playhead three-quarters as fast
      await setPlaybackRate(0.75)
      engine.seek(5)
      await engine.play()
      getState().set({ playing: true })
      await wait(2000)
      const moved = engine.time() - 5
      engine.pause()
      getState().set({ playing: false })
      await setPlaybackRate(1)
      log('practice speed 75%: playhead moved', moved.toFixed(2), 's in 2 s of real time')
      getState().set({ drawerOpen: true, drawerTab: 'reference' })
      engine.seek(9)
      await wait(900)
      await window.keyfall.selftestCapture(`${outDir}/window-reference-a.png`)
      await wait(900)
      await window.keyfall.selftestCapture(`${outDir}/window-reference.png`)
      getState().set({ drawerOpen: false })
    }

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

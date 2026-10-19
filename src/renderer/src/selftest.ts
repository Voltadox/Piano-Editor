import { engine } from './audio/engine'
import { DEFAULT_VIDEO, exportAllTracks, exportAudio, exportVideo } from './actions/export'
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
import { decodeWavMono, encodeWavMono } from './audio/wav'
import { closeMic, loadRecorderWorklet, micLevel, openMic } from './audio/vocalRecorder'
import { clipAudio, processAll, vocalLines, vocalNotes } from './audio/vocals'
import { drawScene } from './view/draw'
import { buildChain } from './audio/vocalChain'
import { addSection, copyReferenceGroove, duplicateSection, generateDrums, moveSection } from './state/arrange'
import { chordLabel, importReferenceAudio, keyLabel, setChordAt } from './actions/reference'
import { askImportChoices } from './ui/ImportDialog'
import { fitChoices, fitToBars } from './actions/fitBars'
import { findLyrics, listening, listenTo, separateReference } from './actions/separate'
import { readFont, remakeBacking } from './actions/remake'
import { placed, soundSlot } from './audio/fontSlots'
import { addAudioTrack, addRecordedPasses, moveVocalWord, setNoteEdit, updateAudioTrack } from './state/vocalEdit'
import { choosePreset, selectAll, selectionSustained, setSustain } from './state/edit'
import { writeMidiFile } from './model/midiio'
import { emptySong, newId, newTrack, tempoMap, ticksPerBar } from './model/song'
import { getState, useStore } from './state/store'

const log = (...a: unknown[]): void => console.log('[selftest]', ...a)
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Developer check run with `--selftest=<soundfont>|<outDir>`; never runs in normal use. */
export async function runSelftest(arg: string): Promise<void> {
  const [sfPath, outDir, realSong, mode] = arg.split('|')
  if (realSong) {
    await realSongCheck(sfPath, outDir, realSong, mode)
    window.keyfall.selftestDone()
    return
  }
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
      // pitch by hand: move the sung note up a tone, and check the tuned audio went with it
      {
        const [clipNotes] = vocalNotes(getState().song, trackId)
        const note = clipNotes?.notes[0]
        log('pitch edit: notes found', clipNotes?.notes.length, note ? `first ${note.sung.toFixed(2)} -> ${note.target}` : '')
        if (clipNotes && note) {
          getState().set({ pitchEdit: true, activeAudioId: trackId })
          setNoteEdit({ trackId, clipId: clipNotes.clipId, takeId: clipNotes.takeId, start: note.start * 0.01, end: note.end * 0.01 }, note.target + 2)
          await processAll(getState().song)
          const t = getState().song.audioTracks.find((x) => x.id === trackId)!
          const a = clipAudio(getState().song, t, t.clips[0])!
          log('pitch edit: edited note now', a.notes?.[0]?.target, 'edited', a.notes?.[0]?.edited, '· sounds at', median(detectPitch(a.pcm, rate)).toFixed(1), 'Hz (B3 = 246.9)')
          // the hidden window doesn't repaint, so draw the stage straight into a canvas of our own
          const cv = document.createElement('canvas')
          cv.width = 1280
          cv.height = 720
          const map = tempoMap(getState().song)
          const start = map.tickToSec(t.clips[0].tick)
          const layer = { color: t.color, clips: vocalNotes(getState().song, trackId), drag: null, hover: { clipId: clipNotes.clipId, start: note.start } }
          drawScene(cv.getContext('2d')!, { song: getState().song, width: 1280, height: 720, time: start - 0.3, pxPerSec: 200, keyboardHeight: 140, vocals: vocalLines(getState().song), vocalNotes: layer })
          const png = await new Promise<Blob>((r) => cv.toBlob((b) => r(b!), 'image/png'))
          await window.keyfall.writeFile(`${outDir}/stage-pitch-edit.png`, new Uint8Array(await png.arrayBuffer()))
          getState().set({ pitchEdit: false })
          getState().undo()
          // timing by hand: the word moves 100 ms earlier
          const before = tempoMap(getState().song).tickToSec(t.clips[0].tick)
          const allNotes = clipNotes.notes.map((x) => ({ start: x.start * 0.01, end: x.end * 0.01 }))
          const moved = moveVocalWord(trackId, clipNotes.clipId, allNotes, (note.start + note.end) * 0.005, -0.1)
          const after = getState().song.audioTracks.find((x) => x.id === trackId)!.clips
          log('timing edit: moved', moved.toFixed(3), 's · clips', after.length, '· starts', before.toFixed(3), '->', tempoMap(getState().song).tickToSec(after[0].tick).toFixed(3))
          getState().undo()
          // following the song: a Melody (to sing) line on B3 under the take, and the take follows it
          {
            const s0 = getState().song
            const clip0 = s0.audioTracks.find((x) => x.id === trackId)!.clips[0]
            getState().apply((s) => ({ ...s, tracks: [...s.tracks, { ...newTrack(s, 'Melody (to sing)'), role: 'melody', silent: true, notes: [{ id: newId(), pitch: 59, tick: clip0.tick, dur: s.ppq * 8, vel: 90 }] }] }))
            const t1 = getState().song.audioTracks.find((x) => x.id === trackId)!
            updateAudioTrack(trackId, { tune: { ...t1.tune, mode: 'reference', voice: 'melody' } })
            await processAll(getState().song)
            const t2 = getState().song.audioTracks.find((x) => x.id === trackId)!
            const a2 = clipAudio(getState().song, t2, t2.clips[0])!
            log('follow the song: sung', a2.notes?.[0]?.sung.toFixed(2), '-> target', a2.notes?.[0]?.target, '(melody line B3 = 59) · sounds at', median(detectPitch(a2.pcm, rate)).toFixed(1), 'Hz')
            getState().undo()
            getState().undo()
          }
        }
      }
      const packed = await packProject(getState().song)
      const back = unpackProject(packed)
      log('project file', (packed.length / 1024).toFixed(0), 'KB · reopened vocal tracks', back.audioTracks.length, 'clips', back.audioTracks[0]?.clips.length, 'take found', !!getTake(back.audioTracks[0]?.clips[0]?.takes[0] ?? ''))
      await exportAudio('wav', `${outDir}/selftest-vocals.wav`)
      log('export with vocals:', getState().toast?.text)
      // every track as its own WAV, read back: each should run the full song, and the vocal sit near the notes' level
      await exportAllTracks('wav', outDir)
      log('stems:', getState().toast?.text)
      // the export button on a track, clicked the way a person would: its menu must open on screen
      getState().set({ drawerOpen: true, drawerTab: 'mixer' })
      await wait(400)
      const exportBtn = document.querySelector<HTMLButtonElement>('.mix-row .track-export .icon-btn')
      exportBtn?.click()
      await wait(200)
      const menu = document.querySelector('.track-export-menu')
      const box = menu?.getBoundingClientRect()
      const onScreen = !!box && box.width > 0 && box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight
      log('track export button:', exportBtn ? 'found' : 'missing', '· menu', menu ? `open at ${Math.round(box!.left)},${Math.round(box!.top)} (${onScreen ? 'on screen' : 'OFF SCREEN'})` : 'did not open', '· items', menu ? [...menu.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ') : '')
      await window.keyfall.selftestCapture(`${outDir}/window-track-export.png`)
      exportBtn?.click()
      getState().set({ drawerOpen: false })

      // the Radio comms effect: a tone through it comes out, narrowed and within full scale
      {
        const off = new OfflineAudioContext(2, 48000, 48000)
        const osc = off.createOscillator()
        osc.frequency.value = 220
        osc.type = 'sawtooth'
        const lvl = off.createGain()
        lvl.gain.value = 0.3
        const chain = buildChain(off, 'radio', 0.8, 0.5)
        osc.connect(lvl).connect(chain.input)
        chain.output.connect(off.destination)
        osc.start()
        const r = (await off.startRendering()).getChannelData(0)
        let peak = 0
        let sum = 0
        let bad = 0
        for (const v of r) {
          if (!Number.isFinite(v)) bad++
          peak = Math.max(peak, Math.abs(v))
          sum += v * v
        }
        log('radio comms effect: level', (20 * Math.log10(Math.sqrt(sum / r.length) + 1e-9)).toFixed(1), 'dBFS · peak', peak.toFixed(2), '· invalid', bad)
      }

      // live autotune in Studio mode: the worklet starts on the mic without an error
      if (!getState().studio) toggleStudio()
      getState().set({ liveTune: true })
      await wait(1500)
      log('live autotune: still on', getState().liveTune, '· error toast', getState().toast?.tone === 'error' ? getState().toast?.text : 'none', '· controls shown', !!document.querySelector('#live-speed'))
      await window.keyfall.selftestCapture(`${outDir}/window-live.png`)
      toggleStudio()
      log('live autotune after closing Studio: on', getState().liveTune)
      const clean = (s: string): string => s.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim()
      const rms = (x: Float32Array): number => {
        let s = 0
        let n = 0
        for (const v of x) if (Math.abs(v) > 0.003) [s, n] = [s + v * v, n + 1]
        return n ? Math.sqrt(s / n) : 0
      }
      for (const t of [...getState().song.tracks.filter((x) => x.notes.length), ...getState().song.audioTracks]) {
        const f = await window.keyfall.readFile(`${outDir}/${clean(getState().fileName)} - ${clean(t.name)}.wav`)
        if (!f) {
          log('stem missing for', t.name)
          continue
        }
        const w = decodeWavMono(f.data)
        log(`stem ${t.name}: ${(w.pcm.length / w.rate).toFixed(1)} s · level ${(20 * Math.log10(rms(w.pcm) || 1e-9)).toFixed(1)} dBFS`)
      }

      // a track playing from another soundfont (one in the design folder), and a kit from another
      // soundfont on the drum channel
      const design = await window.keyfall.designFonts()
      const steel = design.find((f) => /steel tongue/i.test(f.name))
      const mega = design.find((f) => /megadrive/i.test(f.name))
      if (steel && mega) {
        const lh = getState().song.tracks.find((t) => t.name === 'Right hand')!
        choosePreset(lh.id, false, 0, 0, steel.path)
        const megaBytes = await readFont(mega.path)
        await engine.addFont(mega.path, megaBytes!)
        for (let i = 0; i < 50 && !placed.has(steel.path); i++) await wait(100)
        const kit = placed.get(mega.path)!.slots.get('128:0')
        await exportAllTracks('wav', outDir)
        const f = await window.keyfall.readFile(`${outDir}/${clean(getState().fileName)} - Right hand.wav`)
        const level = f ? 20 * Math.log10(rms(decodeWavMono(f.data).pcm) || 1e-9) : NaN
        const core = new SpessaSynthProcessor(48000, { eventsEnabled: false, effectsEnabled: false })
        for (const x of engine.fontsFor({ ...getState().song, tracks: [{ ...lh, font: mega.path }] })) core.soundBankManager.addSoundBank(SoundBankLoader.fromArrayBuffer(x.bytes), x.id)
        await core.processorInitialized
        core.programChange(9, kit?.program ?? 0)
        core.noteOn(9, 36, 120)
        const l = new Float32Array(24000)
        const r = new Float32Array(24000)
        for (let pos = 0; pos < 24000; pos += 128) core.process(l, r, pos, 128)
        let peak = 0
        for (const v of l) peak = Math.max(peak, Math.abs(v))
        log('other soundfonts: Right hand plays', steel.name, 'from slot', JSON.stringify(soundSlot(getState().song.tracks.find((t) => t.id === lh.id)!)), '· its stem', level.toFixed(1), 'dBFS · Megadrive kit placed at', JSON.stringify(kit), '· drum channel plays', core.midiChannels[9].preset?.name, '· kick peak', peak.toFixed(3))
        choosePreset(lh.id, false, 0, 0)
      }
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
      // a sung line: four notes a bar that fit each chord, with vibrato, vowel-like tone and short gaps
      const tunes = [[69, 72, 76, 72], [69, 72, 77, 72], [67, 72, 76, 72], [67, 71, 74, 71]]
      const sungTruth: { start: number; pitch: number }[] = []
      let ph = 0
      plan.forEach((p, b) => {
        for (let q = 0; q < 4; q++) {
          const start = lead + (b * 4 + q) * beatSec
          const pitch = tunes[p][q]
          if (sungTruth.length < 16) sungTruth.push({ start, pitch })
          const s0 = Math.floor(start * sr)
          const len = Math.floor(beatSec * 0.85 * sr)
          for (let i = 0; i < len; i++) {
            const t = i / sr
            const f = 440 * Math.pow(2, (pitch - 69 + 0.15 * Math.sin(2 * Math.PI * 5.5 * t)) / 12)
            ph += (2 * Math.PI * f) / sr
            let v = 0
            for (let h = 1; h <= 12; h++) {
              const hf = f * h
              v += Math.sin(ph * h) * (0.15 + Math.exp(-(((hf - 700) / 300) ** 2)) + 0.6 * Math.exp(-(((hf - 1200) / 350) ** 2)) + 0.3 * Math.exp(-(((hf - 2600) / 500) ** 2)))
            }
            x[s0 + i] += 0.1 * v * Math.min(1, t / 0.02, (len / sr - t) / 0.03)
          }
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

      // separate the vocals, find the sung notes, and play only the instrumental
      const tSep = performance.now()
      await separateReference()
      const after = getState().song
      const melodyTrack = after.tracks.find((tr) => tr.role === 'melody')
      const m2 = tempoMap(after)
      const refClip = after.audioTracks.find((tr) => tr.kind === 'reference')!.clips[0]
      const toAudio = (tick: number): number => m2.tickToSec(tick) - m2.tickToSec(refClip.tick) + refClip.offset
      const found = (melodyTrack?.notes ?? []).map((nn) => ({ start: toAudio(nn.tick), pitch: nn.pitch }))
      const hits = sungTruth.filter((tn) => found.some((f) => f.pitch === tn.pitch && Math.abs(f.start - tn.start) < 0.08)).length
      log('separation:', ((performance.now() - tSep) / 1000).toFixed(1), 's · stems', after.audioTracks.filter((tr) => tr.kind === 'stem').map((tr) => tr.name).join(', '), '· sung notes found', found.length, '· first 16 true notes matched', `${hits}/16`, '·', getState().toast?.text)
      listenTo('instrumental')
      log('listen to instrumental: muted', getState().song.audioTracks.filter((tr) => tr.muted).map((tr) => tr.name).join(', '))
      listenTo('song')
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

      // bringing a song in with nothing ticked adds the song and its tempo, and nothing else
      const none = { key: false, chords: false, chordPad: false, sections: false, melody: false, harmonies: false, lyrics: false, drums: false, bass: false, keys: false }
      getState().loadSong(emptySong(), 'Choices test', null)
      const before = getState().song
      await importReferenceAudio('synthetic-96bpm.wav', buf, none)
      const bare = getState().song
      log(
        'import nothing ticked: tracks',
        before.tracks.length,
        '->',
        bare.tracks.length,
        '· audio tracks',
        bare.audioTracks.map((tr) => tr.kind ?? 'vocal').join(','),
        '· chords',
        bare.chords.length,
        '· sections',
        bare.sections.length,
        '· key',
        bare.key ? keyLabel(bare.key.tonic, bare.key.minor) : 'unset',
        '· tempo',
        bare.tempos[0].bpm.toFixed(1)
      )
      // the checklist, shown while picking
      const asked = askImportChoices('Shadows Whisper Low.mp3')
      await wait(400)
      await window.keyfall.selftestCapture(`${outDir}/window-import-choices.png`)
      const dlg = document.querySelector('.vdialog.import')
      const box = dlg?.getBoundingClientRect()
      log(
        'import checklist:',
        dlg?.querySelector('h2')?.textContent,
        '· ticks',
        [...(dlg?.querySelectorAll('input[type=checkbox]') ?? [])].map((i) => `${i.id.replace('import-', '')}${(i as HTMLInputElement).checked ? '✓' : ''}${(i as HTMLInputElement).disabled ? '(off)' : ''}`).join(' '),
        '· size',
        box && `${Math.round(box.width)}×${Math.round(box.height)} in ${window.innerWidth}×${window.innerHeight}`
      )
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      log('import checklist: Esc cancels ->', await asked)
    }

    // a loop played freely at 96 BPM in a 120 BPM song, starting 3.2 s in: fit it to 4 bars
    {
      const s = emptySong()
      const tr = newTrack(s, 'Loop')
      const ppq = s.ppq
      const beat96 = 60 / 96
      let jitter = 3
      const wobble = (): number => ((jitter = (jitter * 16807) % 2147483647) / 2147483647 - 0.5) * 0.04
      for (let bar = 0; bar < 4; bar++) {
        const at = 3.2 + bar * 4 * beat96 + wobble()
        const len = bar === 3 ? 3.2 * beat96 : 3.9 * beat96 // the last chord let go most of a beat early
        for (const p of [48, 55, 60, 64]) tr.notes.push({ id: newId(), pitch: p + (bar % 2) * 2, tick: Math.round(at * 2 * ppq), dur: Math.round(len * 2 * ppq), vel: 80 })
      }
      getState().loadSong({ ...s, tracks: [tr] }, 'Fit test', null)
      selectAll()
      const offered = fitChoices().map((f) => `${f.bars}:${f.bpm}`)
      fitToBars(4)
      const fitted = getState().song
      const bar = ticksPerBar(fitted)
      const starts = [...new Set(fitted.tracks[0].notes.map((n) => n.tick))].map((t) => (t / bar + 1).toFixed(2))
      log('fit to bars: offered', offered.join(' '), '· tempo', fitted.tempos[0].bpm, '· chords start at bars', starts.join(' '), '· loop bars', getState().loop && `${getState().loop!.start / bar + 1}-${getState().loop!.end / bar}`, '·', getState().toast?.text)
    }

    // a beatboxed take at 100 BPM (kick on 1 and 3, snare on 2 and 4, hats on the eighths between),
    // sung 30 ms late here and there, turned into drums snapped to sixteenths
    {
      const s = { ...emptySong(), tempos: [{ tick: 0, bpm: 100 }] }
      getState().loadSong(s, 'Beatbox test', null)
      const rate = 48000
      const step = 60 / 100 / 4
      const pcm = new Float32Array(Math.round(rate * (32 * step + 1)))
      let seed = 7
      const noise = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
      const want: string[] = []
      for (let st = 0; st < 32; st++) {
        const kind = st % 8 === 0 ? 'kick' : st % 8 === 4 ? 'snare' : st % 2 === 0 ? 'hat' : ''
        if (!kind) continue
        want.push(`${kind[0]}${st}`)
        const at = Math.round((st * step + (st % 3 === 0 ? 0.03 : 0)) * rate)
        let lp = 0
        let lp2 = 0
        let prev = 0
        let ph = 0
        for (let i = 0; i < rate * 0.3 && at + i < pcm.length; i++) {
          const t = i / rate
          const n = noise()
          lp += 0.3 * (n - lp)
          lp2 += 0.08 * (n - lp2)
          let v: number
          if (kind === 'kick') {
            ph += (2 * Math.PI * (55 + 90 * Math.exp(-t / 0.03))) / rate
            v = 0.7 * Math.sin(ph) * Math.exp(-t / 0.07)
          } else if (kind === 'snare') v = 1.2 * (lp - lp2) * Math.exp(-t / 0.09)
          else v = 0.5 * (n - prev) * Math.exp(-t / 0.035)
          prev = n
          pcm[at + i] += v
        }
      }
      const takeId = addTake(pcm, rate)
      const bb = addAudioTrack('Beatbox', { kind: 'beatbox', tune: { mode: 'off', speed: 0.85, voice: 'root', centre: 57 } })
      addRecordedPasses(bb, [{ tick: 0, duration: pcm.length / rate, takeId }])
      const { convertBeatbox } = await import('./actions/beatbox')
      await convertBeatbox('1/16')
      const drums = getState().song.tracks.find((t) => t.beatbox)
      const sixteenth = getState().song.ppq / 4
      const name: Record<number, string> = { 36: 'k', 38: 's', 42: 'h', 46: 'o' }
      const got = drums?.notes.map((n) => `${name[n.pitch] ?? n.pitch}${n.tick / sixteenth}`) ?? []
      log('beatbox:', `${got.filter((g) => want.includes(g)).length}/${want.length} right`, '· extra', got.filter((g) => !want.includes(g)).join(' ') || 'none', '· missed', want.filter((w) => !got.includes(w)).join(' ') || 'none', '· channel', drums?.channel, '· take muted', getState().song.audioTracks.find((t) => t.id === bb)?.muted, '·', getState().toast?.text)
      // the timeline, showing the take's grip strip and the drums made from it
      getState().set({ timeline: true })
      await wait(1500)
      await window.keyfall.selftestCapture(`${outDir}/window-timeline-beatbox.png`)
      getState().set({ timeline: false, drawerOpen: true, drawerTab: 'beat' })
      await wait(1500)
      await window.keyfall.selftestCapture(`${outDir}/window-beatbox-panel.png`)
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

/**
 * With a third argument, runs reference mode on a real song file instead of the usual checks:
 * analysis, vocal separation and the sung notes, with a screenshot of the result. With a fourth,
 * `remake`, recreates the backing track instead of reading the lyrics, and saves it as MP3s.
 */
async function realSongCheck(sfPath: string, outDir: string, path: string, mode = ''): Promise<void> {
  const remake = mode === 'remake'
  try {
    const sf = await window.keyfall.readFile(sfPath)
    if (sf) await loadSoundfontBytes(sf.data.buffer.slice(sf.data.byteOffset, sf.data.byteOffset + sf.data.byteLength) as ArrayBuffer, sf.name, null)
    const f = await window.keyfall.readFile(path)
    if (!f) throw new Error(`cannot read ${path}`)
    await engine.init()
    const buf = await engine.ctx!.decodeAudioData(f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) as ArrayBuffer)
    getState().loadSong(emptySong(), 'Real song', null)
    const t0 = performance.now()
    if (mode === 'bass') {
      // just the bass: opening the song with only Bass ticked
      const toasts: string[] = []
      const unsub = useStore.subscribe((st, prev) => {
        if (st.toast && st.toast !== prev.toast) toasts.push(st.toast.text)
      })
      const before = getState().song.tracks.map((t) => t.name)
      await importReferenceAudio(f.name, buf, { key: false, chords: false, chordPad: false, sections: false, melody: false, harmonies: false, lyrics: false, drums: false, bass: true, keys: false })
      unsub()
      const s = getState().song
      log('bass only: done in', ((performance.now() - t0) / 1000).toFixed(1), 's · tracks', before.join(','), '->', s.tracks.map((t) => `${t.name} (${t.notes.length})`).join(', '))
      log('bass only: audio', s.audioTracks.map((t) => `${t.name}${t.muted ? ' [muted]' : ''}`).join(', '), '· chords', s.chords.length, '· sections', s.sections.length, '· key', s.key ? keyLabel(s.key.tonic, s.key.minor) : 'unset')
      log('bass only: messages', toasts.join(' || '))
      return
    }
    await importReferenceAudio(f.name, buf)
    const song = getState().song
    log('real song:', f.name, buf.duration.toFixed(1), 's · analysed in', ((performance.now() - t0) / 1000).toFixed(1), 's ·', getState().toast?.text)
    const names = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
    const bar = ticksPerBar(song)
    log('real song: tempo', song.tempos[0].bpm.toFixed(1), song.tempos.length > 1 ? `(${song.tempos.length} tempo changes)` : '', '· chords', song.chords.slice(0, 16).map((c) => `${c.root < 0 ? 'N' : names[c.root] + (c.minor ? 'm' : '')}@${(c.tick / bar + 1).toFixed(1)}`).join(' '))
    log('real song: sections', song.sections.map((x) => `${x.name}@${x.bar + 1}`).join(' '), '· drum hits', song.reference?.drums.kick.length, song.reference?.drums.snare.length, song.reference?.drums.hat.length)
    const t1 = performance.now()
    await separateReference()
    const after = getState().song
    const melody = after.tracks.find((t) => t.role === 'melody')
    const stems = after.reference?.stems
    const vocalsTake = after.audioTracks.find((t) => t.id === stems?.vocals)?.clips[0]?.takes[0]
    const instTake = after.audioTracks.find((t) => t.id === stems?.instrumental)?.clips[0]?.takes[0]
    const rms = (id?: string): string => {
      const t = id ? getTake(id) : undefined
      if (!t) return '?'
      let e = 0
      for (const v of t.pcm) e += v * v
      return Math.sqrt(e / t.pcm.length).toFixed(4)
    }
    const pitches = (melody?.notes ?? []).map((n) => n.pitch)
    log('real song: separated in', ((performance.now() - t1) / 1000).toFixed(1), 's · vocals rms', rms(vocalsTake), '· instrumental rms', rms(instTake), '· sung notes', pitches.length, pitches.length ? `(range ${Math.min(...pitches)}-${Math.max(...pitches)}, first: ${pitches.slice(0, 12).join(' ')})` : '')
    log('real song: harmony lines', after.tracks.filter((t) => t.role?.startsWith('harmony')).map((t) => `${t.name}: ${t.notes.length} notes ${t.notes.slice(0, 6).map((n) => n.pitch).join(' ')}`).join(' · ') || 'none', '·', getState().toast?.text)
    if (remake) {
      const t3 = performance.now()
      // how long each step takes, from the progress labels
      const steps: string[] = []
      let label = ''
      let since = t3
      const unsub = useStore.subscribe((st) => {
        const l = st.busy?.label.replace(/\(.*\)/, '').trim() ?? ''
        if (l === label) return
        if (label) steps.push(`${label} ${((performance.now() - since) / 1000).toFixed(1)}s`)
        label = l
        since = performance.now()
      })
      await remakeBacking()
      unsub()
      log('remake: steps', steps.join(' · '))
      const s = getState().song
      log('remake: done in', ((performance.now() - t3) / 1000).toFixed(1), 's ·', getState().toast?.text)
      for (const t of s.tracks.filter((x) => x.remake))
        log(`remake: ${t.remake} · ${t.notes.length} notes · ch ${t.channel + 1} · volume ${t.volume.toFixed(2)} · options:`, (s.reference?.remake?.[t.remake!] ?? []).map((c) => `${c.name} [${c.font.split(/[\/]/).pop()}] ${c.distance.toFixed(3)}`).join(' | '))
      log('remake: listening to', listening(s), '· audible audio', s.audioTracks.filter((x) => !x.muted).map((x) => x.name).join(', '))
      await wait(1500)
      log('remake: placed soundfonts', [...placed.keys()].map((p) => p.split(/[\/]/).pop()).join(', '), '· programs', s.tracks.filter((x) => x.remake).map((x) => `${x.remake} ${JSON.stringify(soundSlot(x))}`).join(' '))
      if (outDir) {
        await exportAudio('mp3', `${outDir}/remake-with-vocals.mp3`)
        log('remake: export', getState().toast?.text)
        const voc = s.reference?.stems?.vocals
        if (voc) updateAudioTrack(voc, { muted: true })
        await exportAudio('mp3', `${outDir}/remake-only.mp3`)
        log('remake: export', getState().toast?.text)
        // for checking the timing: the remake and the song's instrumental, each on its own
        await exportAudio('wav', `${outDir}/remake-only.wav`)
        listenTo('instrumental')
        await exportAudio('wav', `${outDir}/instrumental.wav`)
        log('remake: export', getState().toast?.text)
        getState().set({ drawerOpen: true, drawerTab: 'reference' })
        await wait(900)
        await window.keyfall.selftestCapture(`${outDir}/remake.png`)
        getState().set({ drawerTab: 'tracks' })
        await wait(900)
        await window.keyfall.selftestCapture(`${outDir}/remake-tracks.png`)
      }
      return
    }
    const t2 = performance.now()
    await findLyrics()
    const lyr = getState().song.lyrics
    const m3 = tempoMap(getState().song)
    log('real song: lyrics in', ((performance.now() - t2) / 1000).toFixed(1), 's ·', lyr.length, 'lines · first:', lyr.slice(0, 4).map((l) => `[${m3.tickToSec(l.tick).toFixed(1)}s] ${l.text}`).join(' | '))
    if (outDir) {
      const vt = vocalsTake ? getTake(vocalsTake) : undefined
      if (vt) await window.keyfall.writeFile(`${outDir}/real-vocals.wav`, takeWavFor(vt))
      getState().set({ drawerOpen: true, drawerTab: 'reference' })
      engine.seek(lyr[1] ? tempoMap(getState().song).tickToSec(lyr[1].tick) + 0.5 : 20)
      await wait(900)
      await window.keyfall.selftestCapture(`${outDir}/real-a.png`)
      await wait(900)
      await window.keyfall.selftestCapture(`${outDir}/real.png`)
    }
  } catch (err) {
    log('FAILED', err instanceof Error ? err.stack : String(err))
  }
}

function takeWavFor(t: { pcm: Float32Array; rate: number; right?: Float32Array }): Uint8Array {
  return encodeWavMono(t.pcm, t.rate, t.right)
}

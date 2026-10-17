import type { MIDIController } from 'spessasynth_core'
import { WorkletSynthesizer } from 'spessasynth_lib'
import processorUrl from 'spessasynth_lib/dist/spessasynth_processor.min.js?url'
import type { AudioClip, AudioTrack } from '../model/audio'
import { audioAudible, tempoMap, ticksPerBar, ticksPerBeat, type Song } from '../model/song'
import { toBuffer } from './takes'
import { buildChain, type Chain } from './vocalChain'
import { clipAudio } from './vocals'
import { buildEvents, CC, eventIndexAt, mixerCCs, OFF, ON, PB, PC, type EventList, type PlayEvent } from './events'

const LOOKAHEAD = 0.12 // seconds of events queued in the synth ahead of the playhead
const START_DELAY = 0.04

type Listener = () => void

/** One audio track's path to the speakers: clip sum, effects chain, level and pan. */
interface Strip {
  input: GainNode
  chain: Chain
  preset: string
  amount: number
  vol: GainNode
  pan: StereoPannerNode
}

/**
 * Owns the AudioContext, the soundfont synth and the transport clock.
 * The playhead is read every animation frame through `time()`, so it is not React state.
 */
class Engine {
  ctx: AudioContext | null = null
  synth: WorkletSynthesizer | null = null
  private master: GainNode | null = null
  private initPromise: Promise<void> | null = null

  /** Untouched copy of the loaded soundfont, used by the export worker. */
  soundfontBytes: ArrayBuffer | null = null
  /** GeneralUser GS, behind the user's soundfont: supplies drums and anything else it lacks. */
  backupBytes: ArrayBuffer | null = null

  private list: EventList = { events: [], notes: new Map(), duration: 0 }
  private song: Song | null = null
  playing = false
  private pos = 0
  private startCtx = 0
  private startPos = 0
  private schedUntil = 0
  private cursor = 0
  private timer: number | null = null
  /** Notes whose note-on has been queued but whose note-off has not. */
  private sounding = new Map<number, { ch: number; pitch: number }>()
  /** channel -> 'bank:program' last sent */
  private programs = new Map<number, string>()

  /** Keys currently held on a connected MIDI keyboard: pitch -> velocity. */
  liveKeys = new Map<number, number>()
  /** Keeps the clock running past the end of the song, so a recording isn't cut off. */
  freeRun = false
  /** Click on every beat while playing. */
  metronome = false
  /** Song time where a count-in ends; clicks always sound before it. */
  prerollEnd = -Infinity
  /** Loop region in seconds: playback jumps from its end back to its start. */
  private loop: { start: number; end: number } | null = null
  /** Clock mapping from before the latest loop jump, used until the (pre-queued) jump is reached. */
  private prev: { startCtx: number; startPos: number } | null = null
  private clicks: OscillatorNode[] = []
  private strips = new Map<number, Strip>()
  private voices: AudioBufferSourceNode[] = []
  /** Told the audio time at which a song time plays: at every start and every loop jump (for recording). */
  onAnchor: ((ctxTime: number, songTime: number) => void) | null = null
  /** Called on every scheduler tick with the song time (drives the harmony guide tone). */
  onTick: ((songTime: number) => void) | null = null
  onEnded: Listener | null = null

  init(): Promise<void> {
    this.initPromise ??= (async () => {
      const ctx = new AudioContext({ latencyHint: 'interactive' })
      await ctx.audioWorklet.addModule(processorUrl)
      const synth = new WorkletSynthesizer(ctx)
      const master = ctx.createGain()
      // a gentle limiter keeps a full mix of piano, drums and vocals out of clipping
      const limiter = ctx.createDynamicsCompressor()
      limiter.threshold.value = -3
      limiter.knee.value = 3
      limiter.ratio.value = 12
      limiter.attack.value = 0.003
      limiter.release.value = 0.15
      synth.connect(master)
      master.connect(limiter).connect(ctx.destination)
      this.ctx = ctx
      this.synth = synth
      this.master = master
      await synth.isReady
    })()
    return this.initPromise
  }

  async loadSoundfont(bytes: ArrayBuffer): Promise<void> {
    await this.init()
    this.soundfontBytes = bytes.slice(0)
    await this.synth!.soundBankManager.addSoundBank(bytes, 'main')
    this.orderBanks()
    this.programs.clear()
    if (this.song) this.applyPrograms(this.song)
  }

  /** Loads (or with null, removes) the backup soundfont that sits behind the user's one. */
  async setBackup(bytes: ArrayBuffer | null): Promise<void> {
    await this.init()
    const manager = this.synth!.soundBankManager
    if (bytes) {
      this.backupBytes = bytes.slice(0)
      await manager.addSoundBank(bytes, 'backup')
    } else if (this.backupBytes) {
      this.backupBytes = null
      await manager.deleteSoundBank('backup')
    }
    this.orderBanks()
    this.programs.clear()
    if (this.song) this.applyPrograms(this.song)
  }

  /** The user's soundfont always wins; the backup only supplies instruments it lacks. */
  private orderBanks(): void {
    if (this.soundfontBytes && this.backupBytes) this.synth!.soundBankManager.priorityOrder = ['main', 'backup']
  }

  /** Whether anything can make sound (the user's soundfont, the backup, or both). */
  get hasSound(): boolean {
    return !!(this.soundfontBytes || this.backupBytes)
  }

  setVolume(v: number): void {
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02)
  }

  get duration(): number {
    return this.list.duration
  }

  time(): number {
    if (!this.playing || !this.ctx) return this.pos
    const now = this.ctx.currentTime
    if (this.prev && now < this.startCtx) return this.prev.startPos + now - this.prev.startCtx
    return Math.max(this.startPos, this.startPos + now - this.startCtx)
  }

  get loopRegion(): { start: number; end: number } | null {
    return this.loop
  }

  setLoop(loop: { start: number; end: number } | null): void {
    this.loop = loop && loop.end - loop.start >= 0.25 ? loop : null
  }

  setSong(song: Song): void {
    const prev = this.song
    this.song = song
    this.list = buildEvents(song)
    if (this.playing) this.reconcile()
    else this.applyPrograms(song)
    if (!prev || prev.tracks !== song.tracks) this.applyMix(song)
    if (!prev || prev.audioTracks !== song.audioTracks || prev.tracks !== song.tracks) this.applyAudioMix(song)
  }

  /** `preroll` seconds are played before the current position, with clicks (a recording count-in). */
  async play(preroll = 0): Promise<void> {
    if (this.playing || !this.song) return
    await this.init()
    const ctx = this.ctx!
    await ctx.resume()
    const from = this.pos - preroll
    this.prepareChannels(from)
    this.startCtx = ctx.currentTime + START_DELAY
    this.startPos = from
    this.schedUntil = from
    this.cursor = eventIndexAt(this.list.events, from)
    this.prerollEnd = preroll > 0 ? this.pos : -Infinity
    this.prev = null
    this.playing = true
    this.clipsSpanning(from, this.startCtx)
    this.onAnchor?.(this.startCtx, from)
    this.tick()
    this.timer = window.setInterval(() => this.tick(), 25)
  }

  pause(): void {
    if (!this.playing) return
    // stopping during a count-in returns to where it was counting in to
    const t = this.time()
    this.pos = Math.max(0, t < this.prerollEnd ? this.prerollEnd : t)
    this.halt()
  }

  seek(sec: number): void {
    const was = this.playing
    if (was) this.halt()
    this.pos = Math.max(0, sec)
    if (was) void this.play()
  }

  private halt(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.playing = false
    this.prev = null
    this.prerollEnd = -Infinity
    for (const o of this.clicks) o.stop()
    this.clicks = []
    this.stopVoices(this.ctx?.currentTime ?? 0)
    const synth = this.synth
    if (!synth || !this.ctx) return
    const at = Math.max(this.ctx.currentTime, this.ctxAt(this.schedUntil))
    this.releaseAll(at)
    for (let ch = 0; ch < 16; ch++) synth.controllerChange(ch, 64 as MIDIController, 0, { time: at })
    synth.stopAll(false)
  }

  private releaseAll(at: number): void {
    for (const s of this.sounding.values()) this.synth!.noteOff(s.ch, s.pitch, { time: at })
    this.sounding.clear()
  }

  private ctxAt(songTime: number): number {
    return this.startCtx + (songTime - this.startPos)
  }

  private tick(): void {
    if (!this.playing || !this.synth || !this.ctx) return
    const ctx = this.ctx
    if (this.prev && ctx.currentTime >= this.startCtx) this.prev = null
    const horizon = (): number => this.startPos + ctx.currentTime + LOOKAHEAD - this.startCtx
    let until = horizon()
    const loop = this.loop
    // queue the jump back to the loop start ahead of time so it lands exactly on the beat
    if (loop && !this.prev && this.schedUntil <= loop.end && until >= loop.end) {
      this.scheduleTo(loop.end)
      const at = this.ctxAt(loop.end)
      this.releaseAll(at)
      this.prev = { startCtx: this.startCtx, startPos: this.startPos }
      this.startCtx = at
      this.startPos = loop.start
      this.schedUntil = loop.start
      this.cursor = eventIndexAt(this.list.events, loop.start)
      this.prepareChannels(loop.start, at)
      this.stopVoices(at)
      this.clipsSpanning(loop.start, at)
      this.onAnchor?.(at, loop.start)
      until = horizon()
    }
    this.scheduleTo(until)
    this.onTick?.(this.time())
    const ev = this.list.events
    const looping = loop !== null && this.schedUntil <= loop.end
    if (!this.freeRun && !looping && this.time() > this.list.duration + 0.3 && this.cursor >= ev.length) {
      this.pause()
      this.onEnded?.()
    }
  }

  private scheduleTo(until: number): void {
    const ev = this.list.events
    while (this.cursor < ev.length && ev[this.cursor].time < until) this.fire(ev[this.cursor++])
    this.scheduleClicks(this.schedUntil, until)
    this.clipStarts(this.schedUntil, until)
    this.schedUntil = Math.max(this.schedUntil, until)
  }

  private scheduleClicks(from: number, to: number): void {
    if (!this.song || to <= from || (!this.metronome && from >= this.prerollEnd)) return
    const map = tempoMap(this.song)
    const tpb = ticksPerBeat(this.song)
    const tpbar = Math.round(ticksPerBar(this.song))
    for (let k = Math.ceil(map.secToTick(from) / tpb - 1e-6) * tpb; ; k += tpb) {
      const sec = map.tickToSec(k)
      if (sec >= to || (!this.metronome && sec >= this.prerollEnd)) break
      if (sec < from - 1e-9) continue
      this.click(this.ctxAt(sec), ((Math.round(k) % tpbar) + tpbar) % tpbar === 0)
    }
  }

  private click(at: number, downbeat: boolean): void {
    const ctx = this.ctx!
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.value = downbeat ? 1760 : 1320
    const t = Math.max(ctx.currentTime, at)
    env.gain.setValueAtTime(0, t)
    env.gain.linearRampToValueAtTime(downbeat ? 0.55 : 0.35, t + 0.002)
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.05)
    osc.connect(env).connect(this.master!)
    osc.start(t)
    osc.stop(t + 0.06)
    this.clicks.push(osc)
    osc.onended = () => (this.clicks = this.clicks.filter((o) => o !== osc))
  }

  private fire(e: PlayEvent): void {
    const synth = this.synth!
    const opts = { time: Math.max(this.ctx!.currentTime, this.ctxAt(e.time)) }
    switch (e.kind) {
      case ON:
        if (this.sounding.has(e.id)) return
        synth.noteOn(e.ch, e.a, e.b, opts)
        this.sounding.set(e.id, { ch: e.ch, pitch: e.a })
        return
      case OFF:
        if (!this.sounding.delete(e.id)) return
        synth.noteOff(e.ch, e.a, opts)
        return
      case CC:
        synth.controllerChange(e.ch, e.a as MIDIController, e.b, opts)
        return
      case PB:
        synth.pitchWheel(e.ch, e.a, opts)
        return
      case PC:
        if (e.time > 0) {
          synth.controllerChange(e.ch, 0 as MIDIController, e.b, opts)
          synth.programChange(e.ch, e.a, opts)
        }
    }
  }

  /** The song was edited mid-playback: end notes that no longer exist and resume from the queue edge. */
  private reconcile(): void {
    const synth = this.synth!
    const at = { time: Math.max(this.ctx!.currentTime, this.ctxAt(this.schedUntil)) }
    for (const [id, s] of this.sounding) {
      const n = this.list.notes.get(id)
      const keep = n && n.audible && n.ch === s.ch && n.pitch === s.pitch && n.start <= this.schedUntil && n.end > this.schedUntil
      if (!keep) {
        synth.noteOff(s.ch, s.pitch, at)
        this.sounding.delete(id)
      }
    }
    this.cursor = eventIndexAt(this.list.events, this.schedUntil)
    this.applyPrograms(this.song!)
  }

  /**
   * Sets programs and the controller state the song would have reached at `pos`.
   * With `at` (a loop jump) the state is applied at that audio time, without a full reset.
   */
  private prepareChannels(pos: number, at?: number): void {
    const synth = this.synth
    if (!synth || !this.song) return
    if (at === undefined) {
      for (let ch = 0; ch < 16; ch++) {
        synth.controllerChange(ch, 121 as MIDIController, 0) // reset all controllers
        synth.pitchWheel(ch, 8192)
      }
      this.programs.clear()
      this.applyPrograms(this.song)
    }
    const opts = at === undefined ? undefined : { time: at }
    const last = new Map<string, PlayEvent>()
    for (const e of this.list.events) {
      if (e.time >= pos) break
      if (e.kind === CC) last.set(`c${e.ch}:${e.a}`, e)
      else if (e.kind === PB) last.set(`b${e.ch}`, e)
    }
    for (const e of last.values()) {
      if (e.kind === CC) synth.controllerChange(e.ch, e.a as MIDIController, e.b, opts)
      else synth.pitchWheel(e.ch, e.a, opts)
    }
  }

  // ---------- audio tracks ----------

  /** The strip for an audio track, rebuilding its effects chain when the preset or amount changes. */
  private strip(t: AudioTrack): Strip {
    const ctx = this.ctx!
    let s = this.strips.get(t.id)
    if (!s) {
      const input = ctx.createGain()
      const chain = buildChain(ctx, t.preset, t.amount)
      const vol = ctx.createGain()
      const pan = ctx.createStereoPanner()
      vol.gain.value = this.song && audioAudible(t, this.song) ? t.volume : 0
      pan.pan.value = t.pan
      input.connect(chain.input)
      chain.output.connect(vol).connect(pan).connect(this.master!)
      s = { input, chain, preset: t.preset, amount: t.amount, vol, pan }
      this.strips.set(t.id, s)
    } else if (s.preset !== t.preset || Math.abs(s.amount - t.amount) > 0.001) {
      // swap the chain between the clip input and the fader; playing clips carry on through it
      s.input.disconnect()
      s.chain.output.disconnect()
      s.chain = buildChain(ctx, t.preset, t.amount)
      s.input.connect(s.chain.input)
      s.chain.output.connect(s.vol)
      s.preset = t.preset
      s.amount = t.amount
    }
    return s
  }

  private applyAudioMix(song: Song): void {
    if (!this.ctx || !this.master) return
    const now = this.ctx.currentTime
    for (const t of song.audioTracks) {
      const s = this.strip(t)
      s.vol.gain.setTargetAtTime(audioAudible(t, song) ? t.volume : 0, now, 0.02)
      s.pan.pan.setTargetAtTime(t.pan, now, 0.02)
    }
    for (const [id, s] of this.strips) {
      if (song.audioTracks.some((t) => t.id === id)) continue
      s.pan.disconnect()
      this.strips.delete(id)
    }
  }

  private clipStarts(from: number, to: number): void {
    const song = this.song
    if (!song?.audioTracks.length || to <= from) return
    const map = tempoMap(song)
    for (const t of song.audioTracks)
      for (const c of t.clips) {
        const s = map.tickToSec(c.tick)
        if (s >= from && s < to) this.startClip(t, c, this.ctxAt(s), 0)
      }
  }

  /** Starts clips already under way at song time `pos`, part-way through, at audio time `at`. */
  private clipsSpanning(pos: number, at: number): void {
    const song = this.song
    if (!song?.audioTracks.length) return
    const map = tempoMap(song)
    for (const t of song.audioTracks)
      for (const c of t.clips) {
        const s = map.tickToSec(c.tick)
        if (s < pos && s + c.duration > pos) this.startClip(t, c, at, pos - s)
      }
  }

  private startClip(t: AudioTrack, c: AudioClip, at: number, into: number): void {
    const ctx = this.ctx
    const audio = this.song && ctx ? clipAudio(this.song, t, c) : null
    if (!ctx || !audio) return
    const when = Math.max(ctx.currentTime, at)
    const skip = into + (when - at)
    const dur = c.duration - skip
    if (dur <= 0.01) return
    const src = ctx.createBufferSource()
    src.buffer = toBuffer(ctx, audio.pcm, audio.rate)
    const g = ctx.createGain()
    // fades, measured from the clip's own start and end
    const fadeIn = Math.max(0.005, c.fadeIn)
    const fadeOut = Math.max(0.005, c.fadeOut)
    g.gain.setValueAtTime(Math.min(1, skip / fadeIn), when)
    if (skip < fadeIn) g.gain.linearRampToValueAtTime(1, when + fadeIn - skip)
    const outAt = when + Math.max(0, dur - fadeOut)
    g.gain.setValueAtTime(1, outAt)
    g.gain.linearRampToValueAtTime(0, when + dur)
    src.connect(g).connect(this.strip(t).input)
    src.start(when, c.offset + skip, dur)
    this.voices.push(src)
    src.onended = () => (this.voices = this.voices.filter((v) => v !== src))
  }

  private stopVoices(at: number): void {
    for (const v of this.voices) {
      try {
        v.stop(at)
      } catch {
        // already stopped
      }
    }
    this.voices = []
  }

  /** Sends every track's mixer settings straight to the synth, so changes are heard immediately. */
  private applyMix(song: Song): void {
    const synth = this.synth
    if (!synth) return
    for (const t of song.tracks) for (const [num, val] of mixerCCs(t)) synth.controllerChange(t.channel, num as MIDIController, val)
  }

  private applyPrograms(song: Song): void {
    const synth = this.synth
    if (!synth) return
    for (const t of song.tracks) {
      const id = `${t.bank}:${t.program}`
      if (this.programs.get(t.channel) === id) continue
      synth.controllerChange(t.channel, 0 as MIDIController, t.bank)
      synth.programChange(t.channel, t.program)
      this.programs.set(t.channel, id)
    }
  }


  // ---------- auditioning ----------

  previewNote(ch: number, pitch: number, vel = 100, length = 0.3): void {
    void this.init().then(() => {
      const ctx = this.ctx!
      void ctx.resume()
      this.synth!.noteOn(ch, pitch, vel)
      this.synth!.noteOff(ch, pitch, { time: ctx.currentTime + length })
    })
  }

  noteOn(ch: number, pitch: number, vel: number): void {
    if (!this.synth || !this.ctx) return
    void this.ctx.resume()
    this.synth.noteOn(ch, pitch, vel)
  }

  noteOff(ch: number, pitch: number): void {
    this.synth?.noteOff(ch, pitch)
  }

  controller(ch: number, num: number, val: number): void {
    this.synth?.controllerChange(ch, num as MIDIController, val)
  }
}

export const engine = new Engine()

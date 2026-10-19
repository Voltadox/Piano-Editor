import type { TuneEdit } from '../audio/pitch'

/** Recorded audio in a song: vocal tracks made of clips, each clip holding one or more takes. */

export type VocalPreset = 'clean' | 'dreamy' | 'underwater' | 'tape' | 'haze' | 'radio'

/** Which line a harmony voice follows, built from the piano's chords. */
export type GuideVoice = 'root' | 'third' | 'fifth' | 'octave' | 'melody' | 'above' | 'below'

export interface Tune {
  /** off, snap to the song's key, follow a chord-tone guide line, or follow the song's own vocal lines */
  mode: 'off' | 'key' | 'guide' | 'reference'
  /** 0 natural, glides between notes .. 1 instant, the hard stepped sound */
  speed: number
  voice: GuideVoice
  /** register of the guide line: pitch around which it is placed */
  centre: number
}

/** The song's own vocal lines, found when its vocals were separated (the rest are chord tones). */
export const SONG_LINES: GuideVoice[] = ['melody', 'above', 'below']
export const isSongLine = (v: GuideVoice): boolean => SONG_LINES.includes(v)

/** A track's autotune mode. Older songs followed the song's lines from the chord mode; that's the song mode now. */
export const tuneMode = (t: Tune): Tune['mode'] => (t.mode === 'guide' && isSongLine(t.voice) ? 'reference' : t.mode)

export interface AudioClip {
  id: number
  /** where the clip starts in the song */
  tick: number
  /** seconds into the take where the clip begins */
  offset: number
  /** seconds */
  duration: number
  /** every pass recorded here; `active` is the one that plays */
  takes: string[]
  active: number
  fadeIn: number
  fadeOut: number
  /** notes moved by hand after autotune, per take id */
  edits?: Record<string, TuneEdit[]>
}

export interface AudioTrack {
  id: number
  /** vocal (default): tuned and effected; reference or stem: played exactly as it is */
  kind?: 'vocal' | 'reference' | 'stem'
  name: string
  color: string
  volume: number
  pan: number
  muted: boolean
  solo: boolean
  preset: VocalPreset
  /** how much of the preset: 0 dry .. 1 full */
  amount: number
  tune: Tune
  /** semitones of formant shift: negative deeper and darker, positive lighter and airier */
  formant: number
  /** semitones of pitch transposition */
  transpose: number
  /** small detune in cents, keeps stacked harmonies from sounding copy-pasted */
  detune: number
  clips: AudioClip[]
}

export const VOCAL_PRESETS: { id: VocalPreset; name: string; hint: string }[] = [
  { id: 'clean', name: 'Clean', hint: 'a touch of room, nothing else' },
  { id: 'dreamy', name: 'Dreamy', hint: 'big plate reverb and a slow, dark delay' },
  { id: 'underwater', name: 'Underwater', hint: 'muffled low-pass with a slow chorus' },
  { id: 'tape', name: 'Lo-fi tape', hint: 'warm saturation, wobble and a narrow band' },
  { id: 'haze', name: 'Haze', hint: 'washed-out reverb with doubled, widened voices' },
  { id: 'radio', name: 'Radio comms', hint: 'a crackly squad radio, like in-game voice chat (think Arc Raiders)' }
]

export const DEFAULT_TUNE: Tune = { mode: 'key', speed: 0.85, voice: 'root', centre: 57 }

export function newAudioTrack(id: number, name: string, color: string): AudioTrack {
  return {
    id,
    name,
    color,
    volume: 0.85,
    pan: 0,
    muted: false,
    solo: false,
    preset: 'dreamy',
    amount: 0.6,
    tune: { ...DEFAULT_TUNE },
    formant: 0,
    transpose: 0,
    detune: 0,
    clips: []
  }
}

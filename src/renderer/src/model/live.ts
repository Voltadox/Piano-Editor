import type { VocalPreset } from './audio'

/** Settings for live autotune on the mic in Studio mode, kept between sessions. */
export interface LiveSettings {
  /** what the voice is tuned to: the key, the notes held on the keyboard, or the song's melody */
  snap: 'key' | 'chords' | 'song'
  /** 0 natural .. 1 hard, as on vocal tracks */
  speed: number
  /** semitones */
  transpose: number
  /** semitones of tone (formant) shift */
  formant: number
  preset: VocalPreset
  amount: number
  volume: number
  /** play the tuned voice on your own speakers in Studio mode (off: sing without hearing it come back late) */
  monitor: boolean
  /** how low the voice goes: the tuner waits three periods of the lowest note, so a higher voice can run closer behind */
  range: VoiceRange
  /** 0..1: how much of what you hear is your own voice straight from the mic (no delay) rather than the tuned one */
  direct: number
}

export type VoiceRange = 'low' | 'mid' | 'high'

/** The lowest note each range tunes cleanly (Hz), and the delay that costs. */
export const VOICE_RANGES: { id: VoiceRange; name: string; lowest: number; hint: string }[] = [
  { id: 'low', name: 'Low voice', lowest: 95, hint: 'Down to G2 · about 32 ms behind' },
  { id: 'mid', name: 'Mid voice', lowest: 130, hint: 'Down to C3 · about 23 ms behind' },
  { id: 'high', name: 'High voice', lowest: 175, hint: 'Down to F3 · about 17 ms behind' }
]

export const lowestOf = (r: VoiceRange): number => (VOICE_RANGES.find((v) => v.id === r) ?? VOICE_RANGES[0]).lowest

/** A raw mic is far quieter than the tuned voice (which the tuner brings up), so the direct voice gets a lift. */
export const DIRECT_LIFT = 2.5

export const DEFAULT_LIVE: LiveSettings = { snap: 'key', speed: 0.7, transpose: 0, formant: 0, preset: 'clean', amount: 0.4, volume: 0.9, monitor: true, range: 'low', direct: 0 }

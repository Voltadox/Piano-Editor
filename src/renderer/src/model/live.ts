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
}

export const DEFAULT_LIVE: LiveSettings = { snap: 'key', speed: 0.7, transpose: 0, formant: 0, preset: 'clean', amount: 0.4, volume: 0.9 }

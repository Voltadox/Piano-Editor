/** Settings for the Keyfall mic: your voice and what Keyfall plays, sent to a virtual cable as one microphone. */
export interface MicOutSettings {
  on: boolean
  /** your real microphone ('' = the Windows default) */
  micId: string
  /** the output the mix is sent to ('' = the first virtual cable found) */
  sinkId: string
  /** your voice's level, 0..2 */
  voice: number
  /** the piano's (everything Keyfall plays) level, 0..2 */
  piano: number
  muted: boolean
  /** let Chromium's noise suppression clean up the mic */
  clean: boolean
  /** autotune the voice on its way out, with live autotune's settings (tune to, retune, pitch, tone, effect) */
  tune: boolean
}

export const DEFAULT_MIC_OUT: MicOutSettings = { on: false, micId: '', sinkId: '', voice: 1, piano: 0.8, muted: false, clean: false, tune: false }

export type MicOutStatus =
  | { state: 'off' }
  | { state: 'starting' }
  /** `sink` is the output's name, `mic` the real mic's */
  | { state: 'on'; sink: string; mic: string }
  /** no-cable: nothing to send to; error: something else went wrong (message says what) */
  | { state: 'no-cable' }
  | { state: 'error'; message: string }

/** VB-CABLE's playback side, whatever it has been renamed to: Windows keeps the driver's name in brackets. */
export const isCableOut = (label: string): boolean => /VB-Audio Virtual Cable|CABLE[^()]*Input/i.test(label)
/** VB-CABLE's recording side: never a mic to send from (it would feed back into itself). */
export const isCableIn = (label: string): boolean => /VB-Audio Virtual Cable|CABLE[^()]*Output/i.test(label)

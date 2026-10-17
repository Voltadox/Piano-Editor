/** How the stage looks, in the editor and in exported videos. */
export interface Theme {
  background: 'solid' | 'gradient' | 'image'
  /** solid colour, or the top of the gradient */
  bg: string
  /** bottom of the gradient */
  bg2: string
  imagePath: string | null
  /** 0..1 darkening laid over a background image so notes stay readable */
  imageDim: number
  /** keyboard rail, and the colour of notes played live */
  accent: string
  /** 0 square .. 1 fully rounded note ends */
  roundness: number
  /** 0 off .. 1.5 strong glow where notes meet the keys */
  glow: number
  sparks: boolean
  /** beat and bar lines in exported videos (the editor always shows them) */
  beatLines: boolean
}

export const DEFAULT_THEME: Theme = {
  background: 'solid',
  bg: '#0a0c14',
  bg2: '#1b1640',
  imagePath: null,
  imageDim: 0.55,
  accent: '#7c8cff',
  roundness: 0.4,
  glow: 1,
  sparks: true,
  beatLines: true
}

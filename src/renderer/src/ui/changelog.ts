/** What changed in each version, newest first. Shown once after an update, and from Help. */
export interface Release {
  version: string
  date: string
  notes: string[]
}

export const CHANGELOG: Release[] = [
  {
    version: '0.2.2',
    date: '19 October 2026',
    notes: ['Fixed: the export button on a track did nothing. Its menu (MIDI, MP3, WAV) was opening off the edge of the window; it now opens beside the button.']
  },
  {
    version: '0.2.1',
    date: '19 October 2026',
    notes: [
      'Fix the timing of your singing: while editing vocals on the stage, drag a sung note up or down to move its whole word earlier or later. The silence it moves into is trimmed away, and it never cuts into the next word.',
      'Clearer tuned vocals: the pitch shifter no longer dulls the treble (the slight muffle), and the Tone control resamples more cleanly.',
      'Fewer playback blips: when a take finishes tuning, only the clips whose sound actually changed are swapped in.'
    ]
  },
  {
    version: '0.2.0',
    date: '19 October 2026',
    notes: [
      'Autotune works note by note: it finds each note you sing and picks one target for it, so it no longer veers off when you come in a little early or late. Retune now sets how much of your own vibrato and slides you keep.',
      'Edit pitch on the stage (Vocals tab): drag a sung note sideways to move it, hold Alt to bend it freely, double-click to put it back.',
      'Vocals are brought to a proper level and gently compressed, so they no longer sit under everything.',
      'Better sync: the Dreamy echo follows the tempo, the stage draws what you hear when you hear it, and clips can be nudged 10 ms at a time.',
      'Export any single track (MIDI, MP3 or WAV), or every track into a folder as stems that line up.',
      'Click a track in the Tracks tab to select all of its notes.',
      'Help and FAQ (F1), and this version checker.'
    ]
  },
  {
    version: '0.1.0',
    date: '17 October 2026',
    notes: ['Reference mode: import a song, separate its vocals, notes to sing, harmonies and lyrics.']
  }
]

/** Compares dotted version numbers: negative when a is older than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

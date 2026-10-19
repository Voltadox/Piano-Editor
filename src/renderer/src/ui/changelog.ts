/** What changed in each version, newest first. Shown once after an update, and from Help. */
export interface Release {
  version: string
  date: string
  notes: string[]
}

export const CHANGELOG: Release[] = [
  {
    version: '0.5.0',
    date: '19 October 2026',
    notes: [
      'Choose what opening a song brings in: tick the key, chord names, the Chords pad, sections, the melody and harmonies to sing, lyrics, or the drums, bass and keys as MIDI. Nothing you leave unticked is added, so you can take just the bass of a song.',
      'Recreate just some parts of the backing track: tick Drums, Bass or Keys under Backing track. The parts you already have stay as they are.',
      'Fit to bars: select a loop you played without a click, right-click and pick 4 bars (or 1, 2, 8…). Keyfall sets the tempo you played at and moves the bar lines so the loop fills them exactly, without changing how it sounds.'
    ]
  },
  {
    version: '0.4.0',
    date: '19 October 2026',
    notes: [
      'Recreate a song\'s backing track as MIDI: in the Reference tab, Recreate the backing track splits the instrumental into drums, bass and everything else, and writes each as a track you can edit (drum hits, the bass line, the chords and lines on top), in time with the song.',
      'Each part is played by the closest-sounding preset in your soundfonts. Every soundfont in the design folder, your soundfont list and GeneralUser GS is tried. Pick from the next-closest sounds under Backing track.',
      'Listen to now has Remake: the recreated backing with the song\'s vocals.',
      'Tracks can each play from a different soundfont: pick one per track in the Tracks tab. Exports render them all.',
      'Optional: recreate the backing automatically whenever you open a song.'
    ]
  },
  {
    version: '0.3.0',
    date: '19 October 2026',
    notes: [
      'Live autotune: in Studio mode, tick Autotune my mic live and your voice is tuned as you sing, mixed with the piano (about 30 ms behind). Tune to the key, to the chord you’re holding on the keyboard, or to the reference song’s melody. Made for streaming: capture Keyfall in OBS and the piano and tuned voice come through together.',
      'Voice effects live: Pitch (±12 semitones), Tone, any vocal preset and a level.',
      'New Radio comms effect: a crackly squad-radio voice, like in-game chat. Live and on recorded vocals.',
      'Fixed: the note beside Export all tracks spilled off the side of the Mixer.'
    ]
  },
  {
    version: '0.2.4',
    date: '19 October 2026',
    notes: [
      'Less static: a gentle gate keeps mic hiss down between phrases instead of turning it up with your voice, takes are boosted by at most +18 dB, and peaks no longer go past full scale (which crackled).',
      'Fewer cut-outs: short dropouts in the middle of a sung sound (from a mic noise gate chattering) are filled in.',
      'If your mic keeps cutting itself to silence in quiet moments, Keyfall tells you after recording and where to turn that off.'
    ]
  },
  {
    version: '0.2.3',
    date: '19 October 2026',
    notes: [
      'New autotune mode, Song: each note you sing goes to the note the reference song’s singer sang there (from its separated vocals). Songs with harmonies can follow a harmony line instead. The modes are now Off · Key · Chords · Song, with a line under them saying what the chosen one does.',
      'New vocal tracks start on Song once the song’s vocals are separated.'
    ]
  },
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

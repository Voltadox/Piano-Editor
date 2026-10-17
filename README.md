# Keyfall

A falling-notes MIDI editor. Open a `.mid`, play it through any `.sf2`/`.sf3` soundfont, and edit notes directly on the Synthesia-style view.

Built with TypeScript, React, Electron, [SpessaSynth](https://github.com/spessasus/spessasynth_lib) (soundfont synth), and [Mediabunny](https://mediabunny.dev) (video export).

## Running

```sh
npm install        # first time only
npm run dev        # run with live reload while developing
npm run build      # production build into out/
npm start          # run the production build
npm run dist       # build a Windows installer into release/
npm run typecheck
```

## Using it

### The studio panel (T)

The panel on the right has five tabs:

- **Tracks:** instruments (the loaded soundfont's own presets, with bank and program), colours, mute/solo.
- **Mixer:** level, pan and reverb for every note track, level/pan/effect for vocals, and the master level. A limiter keeps the mix out of clipping.
- **Vocals:** pick a microphone, record takes (with a loop on, every pass is kept as a take; switch between them per clip, or split a clip at the playhead to use different takes in each half). Each vocal track has:
  - **Autotune:** to the song's key (detected from the notes, or set by you), or *Follow chords*, which aims the voice at the root, third or fifth of whatever chord the piano is playing. *Retune* runs from natural glides to the hard, stepped sound.
  - **Voice character:** tone (deeper ↔ airier, without changing pitch), pitch in semitones, and a few cents of detune.
  - **Effect presets:** Clean, Dreamy, Underwater, Lo-fi tape and Haze, each with an amount.
  - **Harmony stack:** pick voices (root, third, fifth, octave) and a register, then record one pass per voice over the loop. A soft guide tone plays each voice's note from the piano's chords so you can hum on key (use headphones). Each voice gets its own track, pan and detune.
  - The tuned melody is drawn as a line over the keys it sings, in the editor and in videos.
- **Beat:** generate an original drum part in a style (lo-fi, boom bap, trap, ballad, pop, house, rock, jazz, reggaeton, cinematic) at a tempo you choose. Kicks follow your bass notes, hats follow how busy the piano is, with fills every four bars and crashes into new phrases. *Try another* gives a new variation. Edit patterns on the step grid (Shift+click for a soft hit), choose which pattern plays in each bar, and add starter patterns.
- **Sections:** mark Intro/Verse/Chorus… at the playhead's bar, then duplicate, delete or reorder sections; notes, pedal, drums and vocals move with them.

Songs with vocals, a beat or sections are saved as **.keyfall** files (a zip of the song and its recorded takes). MIDI files keep only the notes. Exports (WAV, MP3, video) include the tuned vocals with their effects.

**Backgrounds:** the picture button next to the soundfont menu has eight dark, calm 4K photos (from Unsplash, credited in the menu), a *Fade* slider, or your own image.


- **Open a MIDI file:** Ctrl+O, or drag it onto the window.
- **Soundfonts:** open the soundfont menu in the top bar and choose *Add soundfonts…* (pick several at once), or drop `.sf2`/`.sf3` files anywhere. Switch between them from the same menu; the pencil renames one, the × takes it off the list (the file stays where it is). The last one used is reloaded next time.
- **Tracks** (T): colour, name, instrument, drum kit, mute/solo, add or delete tracks. New notes go into the highlighted track.
- **Record:** plug in a USB MIDI keyboard (the keyboard icon turns green), press R. Recording counts in first (set the count-in from the arrow next to the metronome), and the view runs upward so what you play grows out of the keys. Notes and sustain/soft pedal moves go into the active track when you stop. With a loop on, recording starts at the top of the loop and each pass adds to the take.
- **Left and right hand:** each take is split by hand into *Left hand* and *Right hand* tracks (reused if they exist). Turn it off from the arrow next to the metronome.
- **Sustain pedal on a selection:** select notes (Ctrl+A for everything), right-click, and tick *Sustain pedal*. The pedal changes at each bar line so chords don't blur; untick to remove it.
- **Even out velocity:** the keyboard icon's menu pulls what you play toward one level (gently, strongly, or all the same), for both what you hear and what is recorded.
- **Studio mode** (S): what you play rises from the keys. Tick *Suggest chords* in its panel to see the key and chord you're playing and chords that fit. Click a suggestion to hear it; Shift+click adds it at the playhead. The first suggestion is marked on the keyboard.
- **Metronome** (K) and **loop** (L): with notes selected, L loops their bars; Shift+drag on the overview strip sets a loop anywhere.
- **Velocity lane** (Shift+V): drag across it to set how loud notes are — the selected notes, or the active track when nothing is selected.
- **Export:** WAV, MP3, or video (Ctrl+E). The video dialog previews the frame at the playhead and sets the style (falling or rising notes), size (720p, 1080p, 4K, vertical for Shorts/Reels), 30 or 60 fps, a title card with artist and caption, and the look: solid, gradient or image background, accent colour, note roundness, glow and key-hit sparks. The look also applies in the editor.
- **Autosave:** unsaved changes are copied every 30 seconds. If Keyfall closes without saving, it offers the copy back next time.
- **Recent files:** the arrow next to the open button.

### Mouse

| Action | Select tool (V) | Draw tool (D) |
| --- | --- | --- |
| Add a note | Double-click empty space | Click, drag up to set length |
| Move | Drag a note | Drag a note |
| Resize | Drag a note's top edge (end) or bottom edge (start) | same |
| Delete | Right-click a note | Right-click a note |
| Select | Click; Ctrl/Shift+click adds; drag empty space to box-select | |

Hold **Alt** while dragging to ignore the snap grid. Scroll to scrub through time, Ctrl+scroll to zoom. Click the keys at the bottom to hear them. Click or drag the overview strip at the top to jump around the song.

### Keyboard

| Key | Action |
| --- | --- |
| Space | Play / pause |
| Home / End | Jump to start / end |
| ← / → | Nudge selection by one grid step (no selection: move one beat, Shift = one bar) |
| ↑ / ↓ | Transpose selection a semitone (Shift = octave) |
| Q / Shift+Q | Quantize starts / starts and ends (selection, or the whole song if nothing is selected) |
| Delete | Delete selection |
| Ctrl+A / C / X / V | Select all / copy / cut / paste at the playhead |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+S / Ctrl+Shift+S | Save / save as |
| Ctrl+N / Ctrl+O | New / open |
| R | Record |
| K | Metronome on/off |
| L | Loop on/off (with a selection: loop its bars) |
| S | Studio mode |
| Ctrl+E | Export video |
| Ctrl+Shift+A / Ctrl+Shift+P | Select the active track / every note of the same pitch |
| Ctrl+I / Ctrl+L | Invert the selection / select notes inside the loop |
| Shift+V | Velocity lane |
| T | Toggle the track drawer |
| M | Mute the active track |
| + / − | Zoom |

## Project layout

```
src/main/          Electron main process: window, file dialogs, file IO
src/preload/       The small API the UI uses to reach the main process
src/renderer/src/
  model/           Song data, tempo map, MIDI read/write
  state/           Editor store (undo/redo, selection) and edit operations
  audio/           Live playback engine, MIDI keyboard input, offline render worker
  view/            Falling-notes drawing and mouse editing
  ui/              Transport bar, track drawer, overview strip, overlays
  actions/         Open/save, soundfont loading, export, transport controls
```

For development checks, `npx electron . --selftest="<soundfont.sf2>|<output folder>"` loads a soundfont, plays briefly, round-trips the song through MIDI, runs WAV, MP3 and video exports (falling and rising) into the folder, and checks looping, chord detection, Studio mode and recording into a new song, logging the results to the terminal. Debug runs use their own settings folder, so they never touch your real settings or autosave.

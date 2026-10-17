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

- **Open a MIDI file:** Ctrl+O, or drag it onto the window.
- **Load a soundfont:** use the *Load soundfont* button, or drop a `.sf2`/`.sf3` anywhere. The last one is reloaded automatically next time.
- **Tracks** (T): colour, name, instrument, drum kit, mute/solo, add or delete tracks. New notes go into the highlighted track.
- **Record:** plug in a USB MIDI keyboard (the keyboard icon turns green), press R. Notes are recorded into the active track when you stop.
- **Export:** WAV, MP3, or a falling-notes video (MP4, 60 fps; 1080p, 720p, or vertical for Shorts/Reels).

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

For development checks, `npx electron . --selftest="<soundfont.sf2>|<output folder>"` loads a soundfont, plays briefly, round-trips the song through MIDI, and runs WAV, MP3 and video exports into the folder, logging the results to the terminal.

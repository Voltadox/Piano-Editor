/**
 * The Help guide: sections of questions and answers. In answers, a blank line starts a new
 * paragraph, lines starting with "- " become a list, and `Ctrl+S` style spans are shown as keys.
 */

export interface HelpEntry {
  q: string
  a: string
  /** a two-column table (key or action, what it does) shown under the answer */
  table?: [string, string][]
  /** the table's first column is keys */
  keys?: boolean
}

export interface HelpSection {
  id: string
  title: string
  entries: HelpEntry[]
}

export const HELP: HelpSection[] = [
  {
    id: 'start',
    title: 'Getting started',
    entries: [
      {
        q: 'What is Keyfall?',
        a: 'Keyfall is a falling-notes MIDI editor. Open a MIDI file, play it through any soundfont, and edit the notes right on the Synthesia-style stage. You can also record from a USB keyboard, sing and autotune vocals, build a beat, line a song up with a reference recording and export audio or video.'
      },
      {
        q: 'How do I open a MIDI file?',
        a: 'Press `Ctrl+O`, click the folder button in the top bar, or drag a `.mid` file onto the window. The small arrow next to the folder button lists recent files.'
      },
      {
        q: 'Why is there already a song when I start?',
        a: 'That is the demo, so there is something to play straight away. Press `Space` to hear it, or `Ctrl+N` for an empty song.'
      },
      {
        q: 'How do I add a soundfont?',
        a: 'Open the soundfont menu in the top bar (the music-note button with the soundfont name) and choose Add soundfonts…. You can pick several at once, or drop `.sf2` / `.sf3` files anywhere on the window. Switch between them from the same menu; the pencil renames one and the × takes it off the list (the file itself stays where it is). The last one you used loads again next time.'
      },
      {
        q: 'I have no soundfont. Will anything play?',
        a: 'Yes. Keyfall ships with GeneralUser GS, so songs play even before you add your own soundfont.'
      },
      {
        q: 'What does "Fill missing instruments and drums" do?',
        a: 'Your soundfont always plays first. With this ticked (in the soundfont menu), GeneralUser GS sits behind it and supplies drums and any instrument your soundfont doesn\'t have. Untick it if you only want to hear your own soundfont.'
      },
      {
        q: 'How do I find my way around the screen?',
        a: '- Top bar: files, undo, transport (play, record, metronome, loop, Studio mode), tempo and time signature, tools, snap, zoom, volume, soundfont, background, MIDI keyboard, export, velocity lane and the side panel.\n- Overview strip: the whole song at a glance. Click or drag it to jump around.\n- Stage: the falling notes and the keyboard.\n- Side panel (`T`): Reference, Tracks, Mixer, Vocals, Beat and Sections tabs.'
      }
    ]
  },
  {
    id: 'play',
    title: 'Playing and getting around',
    entries: [
      {
        q: 'How do I play, pause and jump around?',
        a: '`Space` plays and pauses. `Home` and `End` jump to the start and end. With nothing selected, `←` / `→` move one beat (`Shift` for a bar). Scroll on the stage to scrub through time, or click and drag the overview strip at the top.'
      },
      {
        q: 'How do I zoom?',
        a: '`Ctrl`+scroll on the stage, the zoom slider in the top bar, or `+` and `−`.'
      },
      {
        q: 'How do I loop part of a song?',
        a: 'Select some notes and press `L` to loop their bars. To loop anywhere, `Shift`+drag on the overview strip. `L` (or the loop button) turns the loop on and off. `Ctrl+L` selects the notes inside the loop.'
      },
      {
        q: 'How do I turn on the metronome or a count-in?',
        a: 'Press `K` or click the metronome button. The arrow next to it sets the count-in before recording: none, one bar or two bars.'
      },
      {
        q: 'Can I slow a song down to practise?',
        a: 'Yes. In the Reference tab, Practice sets 50–90% speed. Notes and audio slow down without changing pitch. The audio is stretched once per speed, so the first time takes a moment. Vocal takes always record at full speed, so set it back before recording.'
      },
      {
        q: 'How do I change the tempo or time signature?',
        a: 'Type a new BPM in the tempo box in the top bar and press Enter, and pick the time signature from the menu beside it. A * after BPM means the file has tempo changes; the box sets the starting tempo.'
      },
      {
        q: 'Can I hear notes by clicking the keys?',
        a: 'Yes. Click the keys at the bottom of the stage to hear them, and drag across them to play a run.'
      }
    ]
  },
  {
    id: 'edit',
    title: 'Editing notes',
    entries: [
      {
        q: 'What is the difference between the Select and Draw tools?',
        a: 'Select (`V`) is for picking, moving and resizing notes; double-click empty space to add one. Draw (`D`) adds a note wherever you click; drag up to set its length. Both tools move, resize and delete notes the same way.',
        table: [
          ['Add a note', 'Select: double-click empty space · Draw: click, drag up to set length'],
          ['Move', 'Drag a note'],
          ['Resize', 'Drag a note\'s top edge (end) or bottom edge (start)'],
          ['Delete', 'Right-click a note'],
          ['Select', 'Click; Ctrl/Shift+click adds; drag empty space to box-select'],
          ['Ignore the snap grid', 'Hold Alt while dragging']
        ]
      },
      {
        q: 'What are all the keyboard shortcuts?',
        a: 'Here is the full list. Shortcuts don\'t fire while you are typing in a text box.',
        keys: true,
        table: [
          ['Space', 'Play / pause'],
          ['Home / End', 'Jump to start / end'],
          ['← / →', 'Nudge selection by one grid step (no selection: move one beat, Shift = one bar)'],
          ['↑ / ↓', 'Transpose selection a semitone (Shift = octave)'],
          ['Q / Shift+Q', 'Quantize starts / starts and ends (selection, or the whole song)'],
          ['Delete', 'Delete selection'],
          ['Ctrl+A / C / X / V', 'Select all / copy / cut / paste at the playhead'],
          ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
          ['Ctrl+S / Ctrl+Shift+S', 'Save / save as'],
          ['Ctrl+N / Ctrl+O', 'New / open'],
          ['R', 'Record'],
          ['K', 'Metronome on/off'],
          ['L', 'Loop on/off (with a selection: loop its bars)'],
          ['S', 'Studio mode'],
          ['V / D', 'Select tool / Draw tool'],
          ['Ctrl+E', 'Export video'],
          ['Ctrl+Shift+A / Ctrl+Shift+P', 'Select the active track / every note of the same pitch'],
          ['Ctrl+I / Ctrl+L', 'Invert the selection / select notes inside the loop'],
          ['Shift+V', 'Velocity lane'],
          ['T', 'Toggle the side panel'],
          ['M', 'Mute the active track'],
          ['+ / −', 'Zoom'],
          ['Esc', 'Stop and clear the selection'],
          ['F1 or ?', 'Open this guide']
        ]
      },
      {
        q: 'How does the snap grid work?',
        a: 'The magnet menu in the top bar sets the grid that notes snap to when you add, move or resize them (or Off). Hold `Alt` while dragging to ignore it for one move.'
      },
      {
        q: 'How do I quantize?',
        a: '`Q` lines note starts up with the snap grid; `Shift+Q` does starts and ends. It works on the selection, or on the whole song if nothing is selected. Both are also in the Edit menu.'
      },
      {
        q: 'How do I select lots of notes quickly?',
        a: '- `Ctrl+A` selects everything.\n- Click a track in the Tracks tab to select all of its notes.\n- `Ctrl+Shift+P` picks every note of the same pitch as the selected ones, in the same track.\n- `Ctrl+L` selects the notes inside the loop; `Ctrl+I` inverts the selection.\n- Drag across empty space to box-select; hold `Ctrl` or `Shift` to add to what is already selected.'
      },
      {
        q: 'How do I change how loud notes are?',
        a: 'Open the velocity lane (`Shift+V` or the bars button) and drag across it. It sets the selected notes, or the whole active track when nothing is selected.'
      },
      {
        q: 'What is in the right-click menu?',
        a: 'Right-click a selected note to open it: Sustain pedal, Quantize starts, Up / Down an octave, Select same pitch and Delete. Right-clicking a note that isn\'t selected deletes it.'
      },
      {
        q: 'How do I add the sustain pedal?',
        a: 'Select notes (`Ctrl+A` for everything), right-click and tick Sustain pedal. The pedal changes at each bar line so chords don\'t blur; untick it to take it away.'
      },
      {
        q: 'Can I undo anything?',
        a: 'Almost everything you change in the song: notes, tracks, mixer moves, vocal clips, pitch edits, beats and sections. `Ctrl+Z` undoes and `Ctrl+Y` redoes. A whole drag counts as one step.'
      }
    ]
  },
  {
    id: 'tracks',
    title: 'Tracks',
    entries: [
      {
        q: 'How do I select every note in a track at once?',
        a: 'Open the Tracks tab (`T`) and click the track. All of its notes are selected and it becomes the active track, so you can transpose them with `↑` / `↓`, move them, quantize, change their velocity in the lane or delete them in one go. `Ctrl`+click or `Shift`+click another track to add its notes too. `Ctrl+Shift+A` selects the active track\'s notes from anywhere.'
      },
      {
        q: 'What is the highlighted (active) track?',
        a: 'New notes you add or record go into the highlighted track. Clicking a note on the stage also makes its track active.'
      },
      {
        q: 'How do I change a track\'s instrument?',
        a: 'Use the instrument menu on the track in the Tracks tab. It lists the loaded soundfont\'s own presets with their bank and program, plus its drum kits. You can also click a preset in the soundfont menu to put it on the active track.'
      },
      {
        q: 'How do I rename, recolour, mute or solo a track?',
        a: 'Click the name to type a new one. Click the colour swatch or one of the palette dots to recolour it. M mutes and S solos; `M` on the keyboard mutes the active track.'
      },
      {
        q: 'How do I add or delete tracks?',
        a: 'Add track sits at the bottom of the Tracks tab. The bin button deletes a track; `Ctrl+Z` brings it back.'
      },
      {
        q: 'What are the "(to sing)" tracks?',
        a: 'When you separate the vocals of a reference song, the notes it sings become Melody (to sing), and any harmonies become Harmony above / below (to sing). They fall on the keys but don\'t make a sound. Hide or show them from the Reference tab.'
      }
    ]
  },
  {
    id: 'record',
    title: 'Recording from a MIDI keyboard',
    entries: [
      {
        q: 'How do I record what I play?',
        a: 'Plug in a USB MIDI keyboard (the keyboard icon in the top bar turns green) and press `R`. Recording counts in first, and the view runs upward so what you play grows out of the keys. Press `R` or `Space` to stop. Notes and sustain / soft pedal go into the active track.'
      },
      {
        q: 'My keyboard isn\'t detected.',
        a: 'Keyboards are picked up automatically when plugged in. Check the cable, try another USB port, and close other music apps that might be holding on to it. The keyboard icon\'s menu shows which inputs Keyfall can see.'
      },
      {
        q: 'Why did my take end up in two tracks?',
        a: 'Each take is split by hand into Left hand and Right hand tracks (reused if they exist). Turn this off with Split into left and right hand in the arrow menu next to the metronome.'
      },
      {
        q: 'How does recording work with a loop?',
        a: 'With a loop on, recording starts at the top of the loop and each pass adds to the take, so you can build a part up layer by layer.'
      },
      {
        q: 'Can I even out how hard I play?',
        a: 'The keyboard icon\'s menu has Even out velocity: As played, Gentle, Strong or All the same, plus the Level they are pulled toward. It changes both what you hear and what is recorded.'
      }
    ]
  },
  {
    id: 'studio',
    title: 'Studio mode and chord ideas',
    entries: [
      {
        q: 'What is Studio mode?',
        a: 'Press `S`. What you play on your keyboard rises from the keys like a live trail, which is handy for jamming and working things out.'
      },
      {
        q: 'How do chord suggestions work?',
        a: 'Tick Suggest chords in the Studio panel. It shows the key and chord you are playing and chords that fit after it. Click a suggestion to hear it; `Shift`+click adds it at the playhead. The first suggestion is marked on the keyboard.'
      }
    ]
  },
  {
    id: 'reference',
    title: 'Reference songs',
    entries: [
      {
        q: 'What does the Reference tab do?',
        a: 'Open one of your demos or a song you are learning (MP3, WAV, M4A…) with Open a song…. Keyfall listens for its tempo, bar lines, key, chords, sections and drum hits, then lines your song up with it: the tempo map follows its downbeats, chord names appear on the left of the stage, a muted Chords pad can play them, and sections are marked.'
      },
      {
        q: 'The bars are twice as long (or short) as they should be.',
        a: 'Use ×2 or ÷2 next to Tempo in the Reference tab to fix half or double time.'
      },
      {
        q: 'How do I fix a wrong chord?',
        a: 'Click a chord name on the left of the stage to change it. Add a change at the playhead adds a new one. Everything that follows chords (Follow chords autotune, harmony guides, Studio suggestions) uses this chord lane.'
      },
      {
        q: 'How do I separate the vocals?',
        a: 'Click Separate the vocals. It splits the song into vocal and instrumental tracks with an MDX-Net model (Kim_Vocal_2). The first time downloads the separator (67 MB); a three-minute song takes about a minute. The sung notes become the Melody (to sing) track.'
      },
      {
        q: 'Can I sing over just the instrumental?',
        a: 'Yes. After separating, Listen to switches between Full song, Instrumental (a backing track) and Vocals.'
      },
      {
        q: 'How do I see whether I\'m singing the right note?',
        a: 'Tick Show my pitch on the keys. A marker shows the note you are singing, green when you\'re on the song\'s note (in any octave) and amber with how many cents off when you\'re not.'
      },
      {
        q: 'Does it find harmonies?',
        a: 'Separating also listens for notes sung alongside the lead (with Spotify\'s Basic Pitch) and writes them as Harmony above / below (to sing). Record over the song\'s harmonies then records one loop pass per line, with a guide tone.'
      },
      {
        q: 'How do the lyrics work?',
        a: 'Find the lyrics reads the words from the separated vocal (Whisper, about 80 MB, downloaded once) and shows them karaoke-style over the stage. Each line starts on a sung note. If a word is wrong, fix it in the list in the Reference tab. Videos can show the lyrics too.'
      },
      {
        q: 'Can it make a beat that matches the song?',
        a: 'Yes. In the Reference tab, generate a beat in a style that follows the song\'s kicks and its busy and quiet parts, or copy the song\'s own groove into the step sequencer to edit.'
      }
    ]
  },
  {
    id: 'vocals',
    title: 'Vocals',
    entries: [
      {
        q: 'How do I record my voice?',
        a: 'Open the Vocals tab, choose your microphone under Input, click Check level and aim for the bar to reach about two thirds when you sing. Add a vocal track if you don\'t have one, then click Record a take. It counts in, then records until you stop (`Space`). Wear headphones so the song doesn\'t leak into the mic.'
      },
      {
        q: 'How do takes and loops work?',
        a: 'With a loop on, every pass is kept as another take of the same clip. In the Clips list, ‹ and › pick which take plays.'
      },
      {
        q: 'Can I use the start of one take and the end of another?',
        a: 'Yes. Put the playhead where you want the change and click Split at playhead. Both halves keep every take, so each half can play a different one.'
      },
      {
        q: 'What is the harmony stack?',
        a: 'Pick voices (root, third, fifth, octave up, plus the song\'s harmony lines when a reference has them) and a register, then record one pass per voice over the loop. A soft guide tone plays each voice\'s note so you can hum on key; set its volume with Guide. Each voice gets its own track, pan and detune so the stack spreads out. With no loop set, it loops four bars from the playhead.'
      },
      {
        q: 'What do the effect presets sound like?',
        a: '- Clean: a touch of room, nothing else.\n- Dreamy: big plate reverb and a slow, dark echo (timed to the song\'s tempo).\n- Underwater: muffled low-pass with a slow chorus.\n- Lo-fi tape: warm saturation, wobble and a narrow band.\n- Haze: washed-out reverb with doubled, widened voices.\n\nAmount blends from nearly dry to the full effect.'
      },
      {
        q: 'What do Tone, Pitch and Detune do?',
        a: 'Under Voice character: Tone moves the voice deeper or airier without changing the note. Pitch transposes in semitones. Detune shifts by a few cents, which keeps stacked harmonies from sounding pasted.'
      },
      {
        q: 'What is the line drawn over the keys?',
        a: 'That is your tuned vocal melody, drawn over the keys it sings, in the track\'s colour. It shows in the editor and in videos.'
      }
    ]
  },
  {
    id: 'autotune',
    title: 'Autotune',
    entries: [
      {
        q: 'How does autotune decide which note to land on?',
        a: 'It first finds each note you sing: where your voice holds roughly one pitch, and where it clearly moves to the next. Then it picks one target for each whole note, so it doesn\'t wander halfway through one.\n\n- To the key: the nearest note in the song\'s key (detected from the notes, or the key you set).\n- Follow chords: the guide line\'s note that overlaps most of what you sang. The guide is the line chosen under Sing the: the song\'s Melody or harmony lines from a reference, or the root, third, fifth or octave of the chord lane.\n\nIt keeps the octave you sing in, so singing a song an octave lower than the original works.'
      },
      {
        q: 'What does the Retune slider do?',
        a: 'Natural keeps your vibrato, scoops and slides and just centres each note on its target. Hard snaps straight to the note and flattens it, for the stepped, robotic sound. In between keeps some of your movement and glides between notes.'
      },
      {
        q: 'Which mode should I use?',
        a: 'With a separated reference song, use Follow chords → Melody. It aims at exactly what the original singer sang. Without one, To the key is the safe choice. Follow chords with root, third or fifth is best for harmony parts.'
      },
      {
        q: 'Autotune picks the wrong note sometimes.',
        a: '- Check the key (To the key) or the chord lane (Follow chords). Most wrong notes come from a wrong key or chord.\n- With Follow chords → Melody, check the Melody (to sing) notes line up with the song; you can edit them like any notes.\n- Fix individual notes by hand: see Editing vocal pitch by hand below.'
      },
      {
        q: 'What does "tuning…" mean next to Vocal tracks?',
        a: 'Takes are autotuned in the background after recording and whenever you change a setting. Until a take is ready you hear it untuned; it switches over by itself.'
      },
      {
        q: 'Can I turn autotune off for a track?',
        a: 'Set Mode to Off. Voice character (tone, pitch, detune) and the effect still apply.'
      }
    ]
  },
  {
    id: 'pitch-edit',
    title: 'Editing vocal pitch by hand',
    entries: [
      {
        q: 'How do I move a sung note myself?',
        a: 'In the Vocals tab, click Edit pitch on the stage. Each note of the selected vocal track shows as a bar over the keys. Drag a bar left or right to move it to another note; it snaps to semitones.'
      },
      {
        q: 'How do I bend a note by less than a semitone?',
        a: 'Hold `Alt` while dragging a note. It moves freely, in cents, instead of snapping to the keys.'
      },
      {
        q: 'How do I undo a pitch edit or go back to the autotune?',
        a: 'Double-click the note, or right-click it and choose to put it back to the autotune. `Ctrl+Z` also undoes edits one at a time.'
      },
      {
        q: 'Can I leave one note exactly as I sang it?',
        a: 'Yes. Right-click the note and choose Leave as sung. Autotune skips it and the rest of the take stays tuned.'
      },
      {
        q: 'How do I get back to editing piano notes?',
        a: 'Press `Esc` or click the Edit pitch on the stage button again. While pitch editing is on, clicks on the stage edit vocal notes rather than MIDI notes.'
      },
      {
        q: 'Are my pitch edits saved?',
        a: 'Yes. They are saved in the .keyfall file with the take they belong to, and included in exports.'
      }
    ]
  },
  {
    id: 'sync',
    title: 'Timing and sync',
    entries: [
      {
        q: 'My vocal takes land late (or early).',
        a: 'Every audio setup adds a little delay between the speakers, your ears and the microphone. Keyfall measures most of it, and the Timing slider in the Vocals tab corrects the rest: raise it if takes land late, lower it if they land early. It applies to new takes.'
      },
      {
        q: 'How do I fix the timing of a take I\'ve already recorded?',
        a: 'In the Clips list, use the −10 ms and +10 ms buttons to nudge that clip earlier or later until it sits with the music.'
      },
      {
        q: 'Should I use Bluetooth headphones?',
        a: 'Wired headphones are much better for recording. Bluetooth adds a lot of delay, and it can change from day to day, so takes drift out of place. Use the same device for listening and recording if you can.'
      },
      {
        q: 'The echo on my vocals sounds out of time.',
        a: 'The Dreamy preset\'s echo follows the song\'s tempo. If it still sounds off, check that the tempo (BPM) is right, or lower Amount or choose Clean.'
      },
      {
        q: 'The falling notes don\'t match what I hear.',
        a: 'Check the tempo map: with a reference, use ×2 / ÷2 if the bars are the wrong length. Wired headphones or speakers also keep the picture and sound closer together than Bluetooth.'
      }
    ]
  },
  {
    id: 'mix',
    title: 'Mixing',
    entries: [
      {
        q: 'Where do I set levels and panning?',
        a: 'The Mixer tab has level, pan and reverb for every note track, level, pan and effect amount for vocals, and the master level. Mute and solo are there too.'
      },
      {
        q: 'Why doesn\'t my mix clip when everything is loud?',
        a: 'A limiter on the master keeps the mix out of clipping, live and in exports. If things sound squashed, turn a few tracks down instead.'
      },
      {
        q: 'My vocals are quieter than everything else. What can I do?',
        a: 'Keyfall now evens this out for you: each take is brought to a standard vocal level when it\'s tuned (measured on the parts where you sing, so pauses don\'t count), and a gentle compressor keeps loud and soft phrases together so the voice sits up in the mix. If it still needs more or less, use the vocal\'s Level in the Mixer tab, or turn the Effect amount down, since big reverbs push a voice back.'
      }
    ]
  },
  {
    id: 'beat',
    title: 'Beat',
    entries: [
      {
        q: 'How do I make a drum beat?',
        a: 'In the Beat tab, pick a style (lo-fi, boom bap, trap, ballad, pop, house, rock, jazz, reggaeton, cinematic) and a tempo, then Generate. Kicks follow your bass notes, hats follow how busy the piano is, with fills every four bars and crashes into new phrases. Try another gives a new variation.'
      },
      {
        q: 'How do I edit the beat?',
        a: 'Click steps on the grid to add or remove hits; `Shift`+click adds a soft hit. Choose which pattern plays in each bar, add starter patterns, copy a pattern, set the swing, and add bars with +4 bars.'
      }
    ]
  },
  {
    id: 'sections',
    title: 'Sections',
    entries: [
      {
        q: 'What are sections for?',
        a: 'Mark Intro, Verse, Chorus and so on at the playhead\'s bar, then duplicate, delete or reorder whole sections. Notes, pedal, drums and vocals move with them.'
      },
      {
        q: 'What is the difference between deleting a section and removing its marker?',
        a: 'The bin deletes the section and its bars, so the song gets shorter. The × removes just the name and leaves the music alone.'
      }
    ]
  },
  {
    id: 'files',
    title: 'Saving and files',
    entries: [
      {
        q: 'Should I save as .keyfall or .mid?',
        a: 'Songs with vocals, a beat, sections or a reference are saved as .keyfall files, a zip of the song and its recorded takes. MIDI files keep only the notes, which is best for sharing with other music apps.'
      },
      {
        q: 'What happens if Keyfall closes without saving?',
        a: 'Unsaved changes are copied every 30 seconds. If Keyfall closes without saving, it offers the copy back the next time you open it.'
      },
      {
        q: 'Where are my recent files?',
        a: 'The arrow next to the open button lists songs you have opened or saved. Clear list empties it.'
      },
      {
        q: 'Do my takes take up a lot of space?',
        a: 'Each take is written to disk as soon as it is recorded, so a crash can\'t lose it, and it goes into the .keyfall file when you save. Long sessions with many loop passes make bigger files; delete clips you don\'t need.'
      }
    ]
  },
  {
    id: 'export',
    title: 'Exporting',
    entries: [
      {
        q: 'How do I export audio?',
        a: 'Export in the top bar, then WAV (lossless) or MP3 (256 kbps). Exports include the tuned vocals with their effects, the beat and every audible track.'
      },
      {
        q: 'Can I export just one track, or the separated stems?',
        a: 'Yes. Every track has a download button: in the Mixer tab (which lists all of them, including the reference song and its vocal and instrumental stems), on each card in the Tracks tab, and next to a vocal track\'s name in the Vocals tab.\n- Note tracks: MIDI, MP3 or WAV.\n- Vocals, the reference and stems: MP3 or WAV.\n\nA track exports on its own even if it\'s muted, with its own level, pan and effects (vocals tuned). Notes to sing, which are silent in Keyfall, are played in the export.'
      },
      {
        q: 'How do I export every track at once?',
        a: 'Click Export all tracks… at the bottom of the Mixer tab (or use Export in the top bar) and choose a folder:\n- Note tracks as MIDI, audio as MP3.\n- All as MP3 stems.\n- All as WAV stems (lossless).\n\nFiles are named after the song and track. Every audio file starts at the top of the song and runs its full length, so they line up when you drop them into another program together.'
      },
      {
        q: 'Do I need a soundfont to export tracks?',
        a: 'For MIDI, no. MP3 and WAV of note tracks are played through the loaded soundfont, so load one first. Vocals, the reference and stems export without one.'
      },
      {
        q: 'How do I make a video?',
        a: 'Press `Ctrl+E` (or Export → Video…). The dialog previews the frame at the playhead (press `Space` to play it) and sets:\n- Style: falling or rising notes.\n- Size: 720p, 1080p, 4K, or vertical for Shorts / Reels.\n- Frame rate: 30 or 60 fps.\n- A title card with title, artist and caption, and optional lyrics.\n- The look: solid, gradient or image background, accent colour, note roundness, glow and key-hit sparks.'
      },
      {
        q: 'Does the video look change the editor too?',
        a: 'Yes. The look you set in the video dialog also applies on the stage. Reset look puts it back.'
      },
      {
        q: 'Why does the video dialog ask for a soundfont?',
        a: 'Videos are rendered with their sound, so a soundfont has to be loaded first.'
      }
    ]
  },
  {
    id: 'look',
    title: 'Backgrounds and look',
    entries: [
      {
        q: 'How do I change the background?',
        a: 'The picture button next to the soundfont menu has eight dark, calm photos (credited in the menu), a Fade slider to set how far they sit behind the notes, Your own image…, or No image (plain colour).'
      }
    ]
  },
  {
    id: 'trouble',
    title: 'Troubleshooting',
    entries: [
      {
        q: 'I can\'t hear anything.',
        a: '- Check the volume slider in the top bar and your system volume.\n- Make sure the tracks aren\'t muted, or that a solo isn\'t silencing them (Tracks or Mixer tab).\n- Make sure a soundfont is loaded, or tick Fill missing instruments and drums in the soundfont menu.\n- Click once on the window; sound starts after your first click or key press.'
      },
      {
        q: 'The soundfont menu says "Loading…" for a long time.',
        a: 'Big soundfonts take a few seconds to read. If it never finishes, choose the soundfont again from the menu, or remove it and add it back. A damaged file won\'t load; try another one.'
      },
      {
        q: 'The drums are silent.',
        a: 'Many piano soundfonts have no drum kit. Tick Fill missing instruments and drums so GeneralUser GS supplies them, or choose a kit in the track\'s instrument menu.'
      },
      {
        q: 'Keyfall can\'t find my microphone.',
        a: 'Check that the mic is plugged in and chosen under Input in the Vocals tab. In Windows, open Settings → Privacy & security → Microphone and make sure microphone access, and access for desktop apps, are on. Close other apps that might be using the mic, then click Check level again.'
      },
      {
        q: 'My recording is too quiet or distorted.',
        a: 'Watch the level meter: aim for about two thirds when you sing. Adjust the mic\'s gain in Windows sound settings or on your audio interface. Keyfall records the mic as it is, with no automatic gain or noise suppression, then brings each take to a standard vocal level when it tunes it, so a slightly quiet take is fine; a distorted one can\'t be fixed afterwards.'
      },
      {
        q: 'Separating the vocals is slow.',
        a: 'The first time also downloads the 67 MB model. After that, a three-minute song takes about a minute. It runs on the graphics card when it can and falls back to the processor, which is slower. Keep Keyfall open until it finishes.'
      },
      {
        q: 'The lyrics have wrong words.',
        a: 'Speech recognition isn\'t perfect, especially with effects-heavy vocals. Click a line in the Lyrics list in the Reference tab and type the right words, or click Read them again.'
      },
      {
        q: 'The notes to sing don\'t match the singer.',
        a: 'They are worked out from the separated vocal, so breathy or heavily processed singing can trip it up. Edit, add or delete the notes in the Melody (to sing) track like any other notes, or click Separate again.'
      },
      {
        q: 'A take I recorded is missing after opening a song.',
        a: 'Takes live inside the .keyfall file. If a song was copied without its file, or saved as .mid, the takes can\'t be found and Keyfall tells you how many are missing.'
      },
      {
        q: 'Something else went wrong.',
        a: 'Try `Ctrl+Z` first. Keyfall autosaves every 30 seconds, so restarting it is safe: it offers the last copy back.'
      }
    ]
  }
]

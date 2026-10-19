import { useEffect, useState } from 'react'
import { readFont } from '../actions/remake'
import { BUILTIN_FONT, fontName, placed, readPresets, type FontPreset } from '../audio/fontSlots'
import { DRUM_CHANNEL, type Track } from '../model/song'
import { choosePreset } from '../state/edit'
import { useStore } from '../state/store'

/**
 * Picking a track's sound from any soundfont in the collection, not just the main one: the design
 * folder, the soundfont list and the built-in GeneralUser GS.
 */

let collection: Promise<string[]> | null = null
const presetCache = new Map<string, Promise<FontPreset[]>>()

function designFonts(): Promise<string[]> {
  collection ??= window.keyfall.designFonts().then((list) => list.map((f) => f.path))
  return collection
}

function presetsOf(path: string): Promise<FontPreset[]> {
  const known = placed.get(path)?.presets
  if (known) return Promise.resolve(known)
  let p = presetCache.get(path)
  if (!p) {
    p = readFont(path).then((b) => (b ? readPresets(b) : []))
    presetCache.set(path, p)
  }
  return p
}

/** Which soundfont a track plays from: the main one, or another from the collection. */
export function FontChoice({ track }: { track: Track }): React.JSX.Element {
  const library = useStore((s) => s.sfLibrary)
  const sfName = useStore((s) => s.sfName)
  const [design, setDesign] = useState<string[]>([])
  useEffect(() => {
    void designFonts().then(setDesign)
  }, [])
  const paths = [...new Set([...design, ...library.map((e) => e.path), BUILTIN_FONT, ...(track.font ? [track.font] : [])])].filter((p) => !/\.dls$/i.test(p))
  return (
    <select
      id={`font-${track.id}`}
      className="select grow"
      value={track.font ?? ''}
      title="The soundfont this track plays from"
      aria-label="Soundfont"
      onChange={async (e) => {
        const path = e.target.value
        if (!path) return choosePreset(track.id, track.channel === DRUM_CHANNEL, 0, track.channel === DRUM_CHANNEL ? 0 : track.program)
        // start on the new soundfont's first instrument (or its first kit, for a drum track)
        const list = await presetsOf(path)
        const first = list.find((p) => p.drum === (track.channel === DRUM_CHANNEL)) ?? list[0]
        if (first) choosePreset(track.id, first.drum, first.bank, first.program, path)
      }}
    >
      <option value="">{`Main soundfont${sfName ? ` (${sfName})` : ''}`}</option>
      {paths.map((p) => (
        <option key={p} value={p}>
          {fontName(p)}
        </option>
      ))}
    </select>
  )
}

/** The presets of the soundfont a track plays from (when it isn't the main one). */
export function FontPresets({ track }: { track: Track & { font: string } }): React.JSX.Element {
  const [list, setList] = useState<FontPreset[] | null>(null)
  useEffect(() => {
    let live = true
    void presetsOf(track.font).then((l) => live && setList(l))
    return () => {
      live = false
    }
  }, [track.font])
  const value = `${track.bank}:${track.program}`
  return (
    <select
      id={`program-${track.id}`}
      className="select grow"
      value={value}
      title={`Presets in ${fontName(track.font)}`}
      aria-label="Instrument"
      onChange={(e) => {
        const p = list?.find((x) => `${x.bank}:${x.program}` === e.target.value)
        if (p) choosePreset(track.id, p.drum, p.bank, p.program, track.font)
      }}
    >
      {!list?.some((p) => `${p.bank}:${p.program}` === value) && <option value={value}>{list ? 'Not in this soundfont' : 'Loading…'}</option>}
      {list && list.some((p) => !p.drum) && (
        <optgroup label="Instruments">
          {list.filter((p) => !p.drum).map((p) => (
            <option key={`${p.bank}:${p.program}`} value={`${p.bank}:${p.program}`}>
              {p.name}
            </option>
          ))}
        </optgroup>
      )}
      {list && list.some((p) => p.drum) && (
        <optgroup label="Drum kits">
          {list.filter((p) => p.drum).map((p) => (
            <option key={`${p.bank}:${p.program}`} value={`${p.bank}:${p.program}`}>
              {p.name}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  )
}

/** Every drum kit in the collection: the main soundfont's, then each other soundfont's. */
export function KitChoice({ track }: { track: Track }): React.JSX.Element {
  const library = useStore((s) => s.sfLibrary)
  const sfName = useStore((s) => s.sfName)
  const main = useStore((s) => s.sfPresets).filter((p) => p.drum)
  const [kits, setKits] = useState<{ font: string; list: FontPreset[] }[]>([])
  useEffect(() => {
    let live = true
    void designFonts()
      .then((design) => {
        const paths = [...new Set([...design, ...library.map((e) => e.path), BUILTIN_FONT])].filter((p) => !/\.dls$/i.test(p))
        return Promise.all(paths.map(async (font) => ({ font, list: (await presetsOf(font)).filter((p) => p.drum) })))
      })
      .then((all) => live && setKits(all.filter((k) => k.list.length)))
    return () => {
      live = false
    }
  }, [library])
  const value = `${track.font ?? ''}|${track.bank}:${track.program}`
  const known = [...main.map((p) => `|${p.bank}:${p.program}`), ...kits.flatMap((k) => k.list.map((p) => `${k.font}|${p.bank}:${p.program}`))]
  return (
    <select
      id={`kit-${track.id}`}
      className="select grow"
      value={value}
      title="The drum kit this track plays, from any of your soundfonts"
      aria-label="Drum kit"
      onChange={(e) => {
        const [font, preset] = e.target.value.split('|')
        const [bank, program] = preset.split(':').map(Number)
        choosePreset(track.id, true, bank, program, font || undefined)
      }}
    >
      {!known.includes(value) && <option value={value}>{track.font ? `Kit in ${fontName(track.font)}` : `Standard kit${sfName ? ` (${sfName})` : ''}`}</option>}
      {main.length > 0 && (
        <optgroup label={`Main soundfont${sfName ? ` (${sfName})` : ''}`}>
          {main.map((p) => (
            <option key={`m${p.bank}:${p.program}`} value={`|${p.bank}:${p.program}`}>{p.name}</option>
          ))}
        </optgroup>
      )}
      {kits.map((k) => (
        <optgroup key={k.font} label={fontName(k.font)}>
          {k.list.map((p) => (
            <option key={`${p.bank}:${p.program}`} value={`${k.font}|${p.bank}:${p.program}`}>{p.name}</option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

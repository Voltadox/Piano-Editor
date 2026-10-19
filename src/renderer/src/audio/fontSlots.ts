import { family } from '../model/remake'
import type { Track } from '../model/song'

/**
 * Tracks can play presets from soundfonts other than the main one (a recreated song picks each
 * part's sound from the whole collection). Every such soundfont is loaded next to the main one with
 * its presets moved to bank and program numbers nothing else uses, written straight into its preset
 * headers; a track keeps the preset's own numbers and is played through its slot.
 */

export interface FontPreset {
  name: string
  /** bank select MSB, plus 128 for a General MIDI drum kit */
  bank: number
  program: number
  /** a drum kit: General MIDI kits (bank 128) and anything named like one */
  drum: boolean
}

export interface Slot {
  bank: number
  program: number
}

/** The preset headers (`phdr`) of an SF2/SF3 file: byte offset and record count, or null. */
function presetHeaders(bytes: ArrayBuffer): { at: number; count: number } | null {
  const v = new DataView(bytes)
  const tag = (o: number): string => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3))
  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'sfbk') return null
  let o = 12
  while (o + 12 <= bytes.byteLength) {
    const size = v.getUint32(o + 4, true)
    if (tag(o) === 'LIST' && tag(o + 8) === 'pdta') {
      let p = o + 12
      const end = o + 8 + size
      while (p + 8 <= end) {
        const len = v.getUint32(p + 4, true)
        if (tag(p) === 'phdr') return { at: p + 8, count: Math.floor(len / 38) - 1 }
        p += 8 + len + (len & 1)
      }
      return null
    }
    o += 8 + size + (size & 1)
  }
  return null
}

/** The presets a soundfont holds, in file order (DLS files aren't read: they return none). */
export function readPresets(bytes: ArrayBuffer): FontPreset[] {
  const h = presetHeaders(bytes)
  if (!h) return []
  const v = new DataView(bytes)
  const out: FontPreset[] = []
  for (let i = 0; i < h.count; i++) {
    const r = h.at + i * 38
    let name = ''
    for (let k = 0; k < 20; k++) {
      const c = v.getUint8(r + k)
      if (!c) break
      name += String.fromCharCode(c)
    }
    const program = v.getUint16(r + 20, true)
    // bank select MSB in the low 7 bits, 128 for a drum kit (and LSB above, ignored here)
    const w = v.getUint16(r + 22, true)
    const kit = (w & 128) > 0
    out.push({ name: name.trim(), bank: (w & 127) + (kit ? 128 : 0), program, drum: kit || family(name, program, false, false) === 'drums' })
  }
  return out
}

/** A copy of the soundfont with each preset (in file order) renumbered to its slot. */
function renumber(bytes: ArrayBuffer, slots: Slot[]): ArrayBuffer {
  const out = bytes.slice(0)
  const h = presetHeaders(out)
  if (!h) return out
  const v = new DataView(out)
  slots.forEach((s, i) => {
    v.setUint16(h.at + i * 38 + 20, s.program, true)
    v.setUint16(h.at + i * 38 + 22, s.bank, true)
  })
  return out
}

export const slotKey = (bank: number, program: number): string => `${bank}:${program}`

export interface PlacedFont {
  path: string
  /** 'bank:program' as the soundfont numbers it -> where it plays */
  slots: Map<string, Slot>
  presets: FontPreset[]
  /** each preset's slot, in file order */
  order: Slot[]
}

/** The soundfont as the synth loads it: a copy with every preset renumbered to its slot. */
export const renumbered = (p: PlacedFont, original: ArrayBuffer): ArrayBuffer => renumber(original, p.order)

/**
 * Places a soundfont's presets in free slots: drum kits as General MIDI kits (bank 128) under
 * program numbers no other kit uses, so they play on the drum channel, and everything else in high
 * banks (127 downward) where main soundfonts rarely put anything. `taken` holds the slots already
 * used and is updated.
 */
export function placeFont(path: string, original: ArrayBuffer, taken: Set<string>): PlacedFont | null {
  const presets = readPresets(original)
  if (!presets.length) return null
  let melodic = { bank: 127, program: 0 }
  const nextMelodic = (): Slot | null => {
    while (melodic.bank >= 1) {
      const s = { ...melodic }
      melodic = melodic.program === 127 ? { bank: melodic.bank - 1, program: 0 } : { bank: melodic.bank, program: melodic.program + 1 }
      if (!taken.has(slotKey(s.bank, s.program))) return s
    }
    return null
  }
  const nextDrum = (): Slot | null => {
    for (let p = 127; p >= 0; p--) if (!taken.has(slotKey(128, p))) return { bank: 128, program: p }
    return null
  }
  const slots = new Map<string, Slot>()
  const order: Slot[] = []
  for (const p of presets) {
    const s = p.drum ? nextDrum() : nextMelodic()
    if (!s) return null
    taken.add(slotKey(s.bank, s.program))
    slots.set(slotKey(p.bank, p.program), s)
    order.push(s)
  }
  return { path, slots, presets, order }
}

/** Slots used by a soundfont as it is (the main one and the backup keep their numbers). */
export function slotsOf(bytes: ArrayBuffer | null): string[] {
  // the drum channel picks a kit by program alone, so every kit holds its program in bank 128
  return bytes ? readPresets(bytes).map((p) => slotKey(p.bank >= 128 ? 128 : p.bank, p.program)) : []
}

/** Where each placed soundfont's presets play, by path. Filled by the engine. */
export const placed = new Map<string, PlacedFont>()

/** The bank and program to send for a track: its preset's slot if it plays from another soundfont. */
export function soundSlot(t: Pick<Track, 'font' | 'bank' | 'program'>): Slot {
  const s = t.font ? placed.get(t.font)?.slots.get(slotKey(t.bank, t.program)) : undefined
  return s ?? { bank: t.bank & 127, program: t.program }
}

/** GeneralUser GS, the soundfont that comes with Keyfall, standing in for a path. */
export const BUILTIN_FONT = 'builtin:GeneralUser GS'

export const fontName = (path: string): string =>
  (path === BUILTIN_FONT ? 'GeneralUser GS' : (path.split(/[\\/]/).pop() ?? path))
    .replace(/\.(sf2|sf3|sfogg|dls)$/i, '')
    .replace(/[_]+/g, ' ')
    .trim()

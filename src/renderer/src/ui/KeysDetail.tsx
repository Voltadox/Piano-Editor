import { FULL_DETAIL, KEYS_LEVELS } from '../model/remake'
import { Field, Slider } from './controls'

/** How much of what was heard the remade keys play, from a beginner's part to everything. */
export function KeysDetail({ id, value, onChange }: { id: string; value: number; onChange: (level: number) => void }): React.JSX.Element {
  const level = KEYS_LEVELS[Math.max(0, Math.min(FULL_DETAIL, value))]
  return (
    <>
      <Field label="Keys detail">
        <Slider id={id} value={value} min={0} max={FULL_DETAIL} step={1} title="Less is often more: fewer notes sit under the song instead of over it" onChange={onChange} />
        <span className="num-out keys-level">{level.name}</span>
      </Field>
      <p className="drawer-hint tight">{level.hint}.</p>
    </>
  )
}

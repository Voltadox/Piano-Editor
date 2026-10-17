import { getState } from '../state/store'

/** A range slider whose whole drag is a single undo step. */
export function Slider(props: {
  id: string
  value: number
  min: number
  max: number
  step?: number
  title?: string
  className?: string
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <input
      id={props.id}
      className={props.className ?? 'range'}
      type="range"
      min={props.min}
      max={props.max}
      step={props.step ?? 0.01}
      value={props.value}
      title={props.title}
      onPointerDown={() => getState().beginGesture()}
      onPointerUp={() => getState().endGesture()}
      onChange={(e) => props.onChange(Number(e.target.value))}
    />
  )
}

/** A row of mutually exclusive text buttons. */
export function Choice<T extends string | number>(props: { value: T; options: { value: T; label: string; title?: string }[]; onChange: (v: T) => void; label: string }): React.JSX.Element {
  return (
    <div className="seg text" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={String(o.value)} title={o.title} className={o.value === props.value ? 'on' : ''} aria-pressed={o.value === props.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="prow">
      <span className="plabel">{label}</span>
      <div className="pctl">{children}</div>
    </div>
  )
}

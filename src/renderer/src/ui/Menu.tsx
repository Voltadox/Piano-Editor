import { useEffect, useRef, useState } from 'react'

/** A button that opens a dropdown; `children` gets a wrapper that closes the menu before running an item. */
export function Menu(props: {
  trigger: React.ReactNode
  title?: string
  className?: string
  align?: 'left' | 'right'
  children: (run: (fn: () => void) => () => void) => React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const run = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }
  return (
    <div className="menu-wrap" ref={ref}>
      <button className={props.className ?? 'btn'} title={props.title} onClick={() => setOpen(!open)} aria-expanded={open}>
        {props.trigger}
      </button>
      {open && (
        <div className={`menu${props.align === 'left' ? ' left' : ''}`} role="menu">
          {props.children(run)}
        </div>
      )}
    </div>
  )
}

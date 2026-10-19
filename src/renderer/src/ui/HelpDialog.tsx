import { useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { HELP, type HelpEntry } from './helpContent'
import * as I from './icons'
import { VersionLine } from './VersionCheck'

/** Whether the guide is open. Kept here so the guide stays self-contained. */
export const useHelp = create<{ open: boolean; set: (open: boolean) => void }>()((set) => ({
  open: false,
  set: (open) => set({ open })
}))

export const openHelp = (): void => useHelp.getState().set(true)

const plain = (s: string): string => s.replace(/`/g, '').toLowerCase()

/** Text with `key` spans shown as keys. */
function Inline({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(/(`[^`]+`)/)
  return <>{parts.map((p, i) => (p.startsWith('`') && p.endsWith('`') ? <kbd key={i}>{p.slice(1, -1)}</kbd> : p))}</>
}

/** An answer: paragraphs, "- " lists, and an optional two-column table. */
function Answer({ e }: { e: HelpEntry }): React.JSX.Element {
  const blocks = e.a.split('\n\n')
  return (
    <div className="help-a">
      {blocks.map((b, i) => {
        const lines = b.split('\n')
        const list = lines.filter((l) => l.startsWith('- '))
        const lead = lines.filter((l) => !l.startsWith('- ')).join(' ')
        return (
          <div key={i}>
            {lead && <p><Inline text={lead} /></p>}
            {list.length > 0 && (
              <ul>
                {list.map((l, j) => <li key={j}><Inline text={l.slice(2)} /></li>)}
              </ul>
            )}
          </div>
        )
      })}
      {e.table && (
        <table className="help-table">
          <tbody>
            {e.table.map(([k, v]) => (
              <tr key={k}>
                <td>{e.keys ? k.split(' / ').map((x, i) => <span key={i}>{i > 0 && ' / '}<kbd>{x}</kbd></span>) : k}</td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** Keys that open the guide from anywhere (outside text boxes): F1 and ?. */
function useHelpKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      const typing = !!el && (el.tagName === 'TEXTAREA' || el.isContentEditable || (el.tagName === 'INPUT' && !['range', 'color', 'checkbox'].includes((el as HTMLInputElement).type)) || el.tagName === 'SELECT')
      const { open, set } = useHelp.getState()
      if (open) {
        // while the guide is open, keys stay with it rather than editing the song behind it
        if (e.key === 'Escape' || e.key === 'F1') {
          e.preventDefault()
          set(false)
        }
        e.stopImmediatePropagation()
        return
      }
      if (e.key === 'F1' || (e.key === '?' && !typing && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        set(true)
      }
    }
    // capture, so it runs before the editor's own shortcuts
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

/** The Help guide: every section's questions, searchable, with a section list on wide windows. */
export function HelpDialog(): React.JSX.Element | null {
  useHelpKeys()
  const open = useHelp((s) => s.open)
  const set = useHelp((s) => s.set)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const body = useRef<HTMLDivElement>(null)

  const q = query.trim().toLowerCase()
  const sections = useMemo(() => {
    if (!q) return HELP
    const words = q.split(/\s+/)
    return HELP.map((s) => ({
      ...s,
      entries: s.entries.filter((e) => {
        const hay = plain(`${s.title} ${e.q} ${e.a} ${(e.table ?? []).flat().join(' ')}`)
        return words.every((w) => hay.includes(w))
      })
    })).filter((s) => s.entries.length)
  }, [q])
  const count = sections.reduce((n, s) => n + s.entries.length, 0)

  if (!open) return null
  const close = (): void => set(false)
  const toggle = (id: string): void =>
    setExpanded((x) => {
      const next = new Set(x)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const jump = (id: string): void => body.current?.querySelector(`#help-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <div className="busy-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="vdialog help" role="dialog" aria-label="Help and FAQ">
        <div className="vhead">
          <h2>Help and FAQ</h2>
          <div className="help-search">
            <input
              id="help-search"
              className="text-in"
              autoFocus
              placeholder="Search the guide, e.g. autotune, latency, loop"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search the guide"
            />
            {q && <span className="meta">{count} answer{count === 1 ? '' : 's'}</span>}
          </div>
          <button className="icon-btn" title="Close (Esc)" onClick={close}><I.IconClose size={16} /></button>
        </div>
        <VersionLine onWhatsNew={close} />
        <div className="help-body">
          <nav className="help-nav" aria-label="Sections">
            {sections.map((s) => (
              <button key={s.id} onClick={() => jump(s.id)}>
                {s.title}
                <span className="meta">{s.entries.length}</span>
              </button>
            ))}
          </nav>
          <div className="help-main" ref={body}>
            {sections.length === 0 && <p className="help-empty">Nothing matches “{query}”. Try a shorter word, like “vocal” or “export”.</p>}
            {sections.map((s) => (
              <section key={s.id} id={`help-${s.id}`} className="help-section">
                <h3>{s.title}</h3>
                {s.entries.map((e) => {
                  const id = `${s.id}:${e.q}`
                  // searching opens every match so the answers can be read straight away
                  const isOpen = !!q || expanded.has(id)
                  return (
                    <div key={id} className={`help-item${isOpen ? ' open' : ''}`}>
                      <button className="help-q" aria-expanded={isOpen} onClick={() => toggle(id)}>
                        <I.IconChevron size={14} />
                        <span>{e.q}</span>
                      </button>
                      {isOpen && <Answer e={e} />}
                    </div>
                  )
                })}
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

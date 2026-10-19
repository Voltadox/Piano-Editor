import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { loadPref, savePref } from '../state/prefs'
import { getState } from '../state/store'
import { CHANGELOG, compareVersions } from './changelog'
import * as I from './icons'

type UpdateInfo = Awaited<ReturnType<typeof window.keyfall.checkUpdates>>

/** The running version, what a check found, and whether "What's new" is showing. */
export const useVersion = create<{ version: string; whatsNew: boolean; checking: boolean; result: string | null; set: (p: Partial<{ version: string; whatsNew: boolean; checking: boolean; result: string | null }>) => void }>()((set) => ({
  version: '',
  whatsNew: false,
  checking: false,
  result: null,
  set: (p) => set(p)
}))

/** What a check means for this copy, in a sentence, and whether something newer exists. */
function describe(u: UpdateInfo): { text: string; newer: boolean } {
  if (u.project && compareVersions(u.project, u.current) > 0)
    return { text: `Your project folder has Keyfall ${u.project}, but this app is ${u.current}. Rebuild it to update: run npm run pack in the project folder.`, newer: true }
  if (u.latest && compareVersions(u.latest, u.current) > 0)
    return { text: `Keyfall ${u.latest} is on GitHub (this is ${u.current}). Pull the latest changes and rebuild with npm run pack.`, newer: true }
  if (!u.latest && u.error) return { text: `This is Keyfall ${u.current}. Couldn't reach GitHub to compare (${u.error}).`, newer: false }
  return { text: `Keyfall ${u.current} is up to date.`, newer: false }
}

/** Checks for a newer version; quiet says nothing unless one is found. */
export async function checkForUpdates(quiet = false): Promise<void> {
  const v = useVersion.getState()
  if (v.checking) return
  v.set({ checking: true })
  try {
    const d = describe(await window.keyfall.checkUpdates())
    useVersion.getState().set({ result: d.text })
    if (!quiet || d.newer) getState().notify(d.text)
  } catch (err) {
    const text = `Couldn't check for updates. ${err instanceof Error ? err.message : ''}`
    useVersion.getState().set({ result: text })
    if (!quiet) getState().notify(text, 'error')
  } finally {
    useVersion.getState().set({ checking: false })
  }
}

/**
 * Learns the running version at startup. The first time a new version opens, "What's new" shows, so
 * it's plain the update arrived; a quiet check for anything newer follows a few seconds later.
 */
function useStartupVersion(): void {
  useEffect(() => {
    let timer = 0
    void window.keyfall.appVersion().then((version) => {
      useVersion.getState().set({ version })
      const seen = loadPref<string | null>('lastVersion', null)
      if (seen !== version) {
        savePref('lastVersion', version)
        if (CHANGELOG.some((r) => r.version === version)) useVersion.getState().set({ whatsNew: true })
      }
      // not during the developer self-test, which runs without a network to speak of
      void window.keyfall.selftest().then((t) => {
        if (!t) timer = window.setTimeout(() => void checkForUpdates(true), 5000)
      })
    })
    return () => clearTimeout(timer)
  }, [])
}

/** "What's new" after an update (or from Help), listing each version's changes. */
export function WhatsNewDialog(): React.JSX.Element | null {
  useStartupVersion()
  const { version, whatsNew, set } = useVersion()
  const [all, setAll] = useState(false)
  useEffect(() => {
    if (!whatsNew) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault()
        e.stopImmediatePropagation()
        set({ whatsNew: false })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [whatsNew, set])
  if (!whatsNew) return null
  const shown = all ? CHANGELOG : [CHANGELOG.find((r) => r.version === version) ?? CHANGELOG[0]]
  const close = (): void => set({ whatsNew: false })
  return (
    <div className="busy-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="vdialog whats-new" role="dialog" aria-label="What's new">
        <div className="vhead">
          <h2>What’s new in Keyfall {version}</h2>
          <button className="icon-btn" title="Close (Esc)" onClick={close}><I.IconClose size={16} /></button>
        </div>
        <div className="whats-new-body">
          {shown.map((r) => (
            <section key={r.version}>
              {all && <h3>{r.version} <span className="meta">{r.date}</span></h3>}
              <ul>
                {r.notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </section>
          ))}
        </div>
        <div className="whats-new-foot">
          {!all && CHANGELOG.length > 1 && <button className="btn" onClick={() => setAll(true)}>Earlier versions</button>}
          <button className="btn primary" onClick={close}>Got it</button>
        </div>
      </div>
    </div>
  )
}

/** The version line in Help: the running version, a check for updates, and "What's new". */
export function VersionLine({ onWhatsNew }: { onWhatsNew: () => void }): React.JSX.Element {
  const { version, checking, result, set } = useVersion()
  return (
    <div className="version-line">
      <span className="meta">Keyfall {version || '…'}</span>
      <button className="btn small-btn" disabled={checking} onClick={() => void checkForUpdates()}>
        {checking ? 'Checking…' : 'Check for updates'}
      </button>
      <button
        className="btn small-btn"
        onClick={() => {
          onWhatsNew()
          set({ whatsNew: true })
        }}
      >
        What’s new
      </button>
      {result && <span className="meta version-result">{result}</span>}
    </div>
  )
}

import { useStore, type DrawerTab } from '../state/store'
import { BeatPanel } from './BeatPanel'
import { MixerPanel } from './MixerPanel'
import { SectionsPanel } from './SectionsPanel'
import { TracksPanel } from './TrackDrawer'
import { VocalsPanel } from './VocalsPanel'
import * as I from './icons'

const TABS: { id: DrawerTab; label: string }[] = [
  { id: 'tracks', label: 'Tracks' },
  { id: 'mixer', label: 'Mixer' },
  { id: 'vocals', label: 'Vocals' },
  { id: 'beat', label: 'Beat' },
  { id: 'sections', label: 'Sections' }
]

/** The studio panel on the right: tracks, mixer, vocals, beat and sections. */
export function Drawer(): React.JSX.Element {
  const open = useStore((s) => s.drawerOpen)
  const tab = useStore((s) => s.drawerTab)
  const set = useStore((s) => s.set)
  return (
    <aside className={`drawer${open ? ' open' : ''}`} aria-hidden={!open}>
      <div className="drawer-head">
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => set({ drawerTab: t.id })}>
              {t.label}
            </button>
          ))}
        </div>
        <button className="icon-btn" title="Close (T)" onClick={() => set({ drawerOpen: false })}><I.IconClose size={16} /></button>
      </div>
      <div className="drawer-body">
        {open && tab === 'tracks' && <TracksPanel />}
        {open && tab === 'mixer' && <MixerPanel />}
        {open && tab === 'vocals' && <VocalsPanel />}
        {open && tab === 'beat' && <BeatPanel />}
        {open && tab === 'sections' && <SectionsPanel />}
      </div>
    </aside>
  )
}

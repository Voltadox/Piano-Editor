type P = { size?: number }

const svg = (d: React.ReactNode, size = 18): React.JSX.Element => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
)

export const IconPlay = ({ size }: P) => svg(<path d="M7 5v14l12-7z" fill="currentColor" stroke="none" />, size)
export const IconPause = ({ size }: P) => svg(<><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" /></>, size)
export const IconStart = ({ size }: P) => svg(<><path d="M6 5v14" /><path d="M19 5v14L9 12z" fill="currentColor" stroke="none" /></>, size)
export const IconRecord = ({ size }: P) => svg(<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />, size)
export const IconNew = ({ size }: P) => svg(<><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" /><path d="M14 3v5h5" /><path d="M12 11v6M9 14h6" /></>, size)
export const IconOpen = ({ size }: P) => svg(<><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>, size)
export const IconSave = ({ size }: P) => svg(<><path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M7 3v5h8V3" /><rect x="7" y="13" width="10" height="6" rx="1" /></>, size)
export const IconUndo = ({ size }: P) => svg(<><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></>, size)
export const IconRedo = ({ size }: P) => svg(<><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></>, size)
export const IconSelect = ({ size }: P) => svg(<path d="M5 3l14 8-6 2-2 6z" />, size)
export const IconPencil = ({ size }: P) => svg(<><path d="M4 20l4-1L19 8l-3-3L5 16z" /><path d="M14 7l3 3" /></>, size)
export const IconTracks = ({ size }: P) => svg(<><path d="M4 6h16M4 12h16M4 18h10" /></>, size)
export const IconExport = ({ size }: P) => svg(<><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>, size)
export const IconSoundfont = ({ size }: P) => svg(<><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>, size)
export const IconMidi = ({ size }: P) => svg(<><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 6v7M10 6v7M14 6v7M18 6v7" /></>, size)
export const IconVolume = ({ size }: P) => svg(<><path d="M4 9h4l5-4v14l-5-4H4z" /><path d="M16 9a4 4 0 0 1 0 6" /></>, size)
export const IconTrash = ({ size }: P) => svg(<><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" /></>, size)
export const IconPlus = ({ size }: P) => svg(<path d="M12 5v14M5 12h14" />, size)
export const IconClose = ({ size }: P) => svg(<path d="M6 6l12 12M18 6 6 18" />, size)
export const IconMagnet = ({ size }: P) => svg(<><path d="M6 4v8a6 6 0 0 0 12 0V4" /><path d="M6 8h4M14 8h4" /></>, size)
export const IconMetronome = ({ size }: P) => svg(<><path d="M9 3h6l4 18H5z" /><path d="M12 15l5-8" /><path d="M7 17h10" /></>, size)
export const IconLoop = ({ size }: P) => svg(<><path d="M17 2l3 3-3 3" /><path d="M4 11V9a4 4 0 0 1 4-4h12" /><path d="M7 22l-3-3 3-3" /><path d="M20 13v2a4 4 0 0 1-4 4H4" /></>, size)
export const IconVelocity = ({ size }: P) => svg(<><path d="M4 20V14M9 20V8M14 20v-9M19 20V4" /></>, size)
export const IconChevron = ({ size }: P) => svg(<path d="m6 9 6 6 6-6" />, size)

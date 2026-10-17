import { useEffect, useRef, useState } from 'react'
import { engine } from '../audio/engine'
import { DEFAULT_VIDEO, drawVideoFrame, exportVideo, presetFor, VIDEO_LEAD, VIDEO_PRESETS, type VideoSettings } from '../actions/export'
import { pickBackgroundImage, setTheme } from '../actions/look'
import { loadPref, savePref } from '../state/prefs'
import { getState, useStore } from '../state/store'
import { DEFAULT_THEME, type Theme } from '../view/theme'
import * as I from './icons'

const PREVIEW_MAX_W = 560
const PREVIEW_MAX_H = 420

/** Live preview of the exported frame at the playhead, drawn at the real export layout and scaled down. */
function Preview({ settings }: { settings: VideoSettings }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const preset = presetFor(settings)
  const k = Math.min(PREVIEW_MAX_W / preset.width, PREVIEW_MAX_H / preset.height)
  const cssW = Math.round(preset.width * k)
  const cssH = Math.round(preset.height * k)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  useEffect(() => {
    const canvas = ref.current!
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)
    const ctx = canvas.getContext('2d', { alpha: false })!
    let raf = 0
    const frame = (): void => {
      const st = getState()
      ctx.setTransform(k * dpr, 0, 0, k * dpr, 0, 0)
      drawVideoFrame(ctx, {
        song: st.song,
        settings: settingsRef.current,
        theme: st.theme,
        bgImage: st.bgImage,
        fileName: st.fileName,
        width: preset.width,
        height: preset.height,
        ts: engine.time() + VIDEO_LEAD
      })
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [cssW, cssH, k, preset.width, preset.height])

  return <canvas ref={ref} className="preview" style={{ width: cssW, height: cssH }} />
}

function Seg<T extends string | number>(props: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }): React.JSX.Element {
  return (
    <div className="seg text" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={String(o.value)} className={o.value === props.value ? 'on' : ''} aria-pressed={o.value === props.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="vrow">
      <span className="vlabel">{label}</span>
      <div className="vctl">{children}</div>
    </div>
  )
}

export function VideoDialog(): React.JSX.Element | null {
  const open = useStore((s) => s.videoOpen)
  const theme = useStore((s) => s.theme)
  const fileName = useStore((s) => s.fileName)
  const sfName = useStore((s) => s.sfName ?? (s.backupLoaded ? 'GeneralUser GS' : null))
  const [v, setV] = useState<VideoSettings>(() => loadPref('video', DEFAULT_VIDEO))
  if (!open) return null

  const update = (patch: Partial<VideoSettings>): void => {
    const next = { ...v, ...patch }
    setV(next)
    savePref('video', next)
  }
  const look = (patch: Partial<Theme>): void => setTheme(patch)
  const close = (): void => getState().set({ videoOpen: false })
  const imageName = theme.imagePath?.split(/[\\/]/).pop()

  return (
    <div className="busy-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="vdialog" role="dialog" aria-label="Export video">
        <div className="vhead">
          <h2>Export video</h2>
          <button className="icon-btn" title="Close (Esc)" onClick={close}><I.IconClose size={16} /></button>
        </div>
        <div className="vbody">
          <div className="vpreview">
            <Preview settings={v} />
            <p className="vhint">Preview at the playhead. Press Space to play it; the title card shows at the start of the song.</p>
          </div>
          <div className="vcontrols">
            <div className="vsection">Video</div>
            <Row label="Style">
              <Seg label="Style" value={v.style} onChange={(style) => update({ style })} options={[{ value: 'falling', label: 'Falling notes' }, { value: 'rising', label: 'Rising notes' }]} />
            </Row>
            <Row label="Size">
              <select id="vsize" className="select grow" value={v.size} onChange={(e) => update({ size: e.target.value })}>
                {VIDEO_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </Row>
            <Row label="Frame rate">
              <Seg label="Frame rate" value={v.fps} onChange={(fps) => update({ fps })} options={[{ value: 60, label: '60 fps' }, { value: 30, label: '30 fps' }]} />
            </Row>

            <div className="vsection">
              <label className="check">
                <input id="vtitlecard" type="checkbox" checked={v.titleCard} onChange={(e) => update({ titleCard: e.target.checked })} /> Title card
              </label>
            </div>
            {v.titleCard && (
              <>
                <Row label="Title">
                  <input id="vtitle" className="text-in" value={v.title} placeholder={fileName} onChange={(e) => update({ title: e.target.value })} />
                </Row>
                <Row label="Artist">
                  <input id="vartist" className="text-in" value={v.artist} placeholder="Optional" onChange={(e) => update({ artist: e.target.value })} />
                </Row>
                <Row label="Caption">
                  <input id="vcaption" className="text-in" value={v.caption} placeholder="e.g. Slow tutorial" onChange={(e) => update({ caption: e.target.value })} />
                </Row>
              </>
            )}

            <div className="vsection">
              Look <span className="vnote">also used in the editor</span>
            </div>
            <Row label="Background">
              <Seg
                label="Background"
                value={theme.background}
                onChange={(background) => (background === 'image' && !getState().bgImage ? void pickBackgroundImage() : look({ background }))}
                options={[{ value: 'solid', label: 'Solid' }, { value: 'gradient', label: 'Gradient' }, { value: 'image', label: 'Image' }]}
              />
            </Row>
            {theme.background !== 'image' && (
              <Row label="Colours">
                <input id="vbg" type="color" className="color-in" value={theme.bg} title="Background" onChange={(e) => look({ bg: e.target.value })} />
                {theme.background === 'gradient' && (
                  <input id="vbg2" type="color" className="color-in" value={theme.bg2} title="Gradient bottom" onChange={(e) => look({ bg2: e.target.value })} />
                )}
              </Row>
            )}
            {theme.background === 'image' && (
              <>
                <Row label="Image">
                  <button className="btn" onClick={() => void pickBackgroundImage()}>Choose…</button>
                  <span className="vfile" title={theme.imagePath ?? ''}>{imageName}</span>
                </Row>
                <Row label="Darken">
                  <input id="vdim" className="range" type="range" min={0} max={0.9} step={0.01} value={theme.imageDim} onChange={(e) => look({ imageDim: Number(e.target.value) })} />
                </Row>
              </>
            )}
            <Row label="Accent">
              <input id="vaccent" type="color" className="color-in" value={theme.accent} title="Keyboard rail and live notes" onChange={(e) => look({ accent: e.target.value })} />
            </Row>
            <Row label="Roundness">
              <input id="vround" className="range" type="range" min={0} max={1} step={0.01} value={theme.roundness} onChange={(e) => look({ roundness: Number(e.target.value) })} />
            </Row>
            <Row label="Glow">
              <input id="vglow" className="range" type="range" min={0} max={1.5} step={0.01} value={theme.glow} onChange={(e) => look({ glow: Number(e.target.value) })} />
            </Row>
            <Row label="Effects">
              <label className="check">
                <input id="vsparks" type="checkbox" checked={theme.sparks} onChange={(e) => look({ sparks: e.target.checked })} /> Sparks
              </label>
              <label className="check">
                <input id="vbeats" type="checkbox" checked={theme.beatLines} onChange={(e) => look({ beatLines: e.target.checked })} /> Beat lines
              </label>
            </Row>
            <button className="btn reset" onClick={() => look({ ...DEFAULT_THEME, imagePath: theme.imagePath })}>Reset look</button>
          </div>
        </div>
        <div className="vfoot">
          {!sfName && <span className="vwarn">Load a soundfont first. Videos are rendered through it.</span>}
          <span className="grow" />
          <button className="btn" onClick={close}>Cancel</button>
          <button
            className="btn primary"
            disabled={!sfName}
            onClick={() => {
              close()
              void exportVideo(v)
            }}
          >
            <I.IconExport /> Export {presetFor(v).label.split(' (')[0]} · {v.fps} fps
          </button>
        </div>
      </div>
    </div>
  )
}

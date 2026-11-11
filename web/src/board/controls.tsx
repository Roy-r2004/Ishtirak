import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'

export type Tone = 'green' | 'amber' | 'red'

/** An indicator lamp with an engraved label. The state is always in words too (never colour alone). */
export function Lamp({ tone, lit, label, detail, testId }: { tone: Tone; lit: boolean; label: string; detail?: string; testId?: string }) {
  return <span className="lamp-item" data-testid={testId} data-lit={lit} data-tone={tone}>
    <span className="lamp" data-tone={tone} data-lit={lit} aria-hidden="true" />
    <span className="lamp-text"><span className="lamp-label">{label}</span>{detail && <span className="lamp-detail">{detail}</span>}</span>
    <span className="sr">{lit ? ', lit' : ', not lit'}</span>
  </span>
}

/** A breaker lever: moves up for on. It always shows the OBSERVED state; while an action is in flight it rests halfway. */
export function Lever({ on, busy, label, caption, onToggle, disabled, testId, title }: { on: boolean; busy?: boolean; label: string; caption: string; onToggle: () => void; disabled?: boolean; testId?: string; title?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} title={title} className="lever" data-on={on} data-busy={!!busy} disabled={disabled} onClick={onToggle} data-testid={testId}>
    <span className="lever-caption" aria-hidden="true">{caption}</span>
    <span className="lever-slot" aria-hidden="true"><span className="lever-handle" /></span>
  </button>
}

/** A push button under a hinged cover: lift the cover first, then press. The cover closes again after a few seconds or after the press. */
export function GuardedButton({ label, pressLabel, caption, running, disabled, reason, onPress, coverTestId, pressTestId, describedBy }: { label: string; pressLabel?: string; caption: string; running?: boolean; disabled?: boolean; reason?: string; onPress: () => void; coverTestId?: string; pressTestId?: string; describedBy?: string }) {
  const [open, setOpen] = useState(false), pressRef = useRef<HTMLButtonElement>(null), coverRef = useRef<HTMLButtonElement>(null), id = useId()
  useEffect(() => { if (!open) return; const t = setTimeout(() => setOpen(false), 7000); return () => clearTimeout(t) }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useEffect(() => { if (open) pressRef.current?.focus({ preventScroll: true }) }, [open])
  const close = () => { if (document.activeElement === pressRef.current) coverRef.current?.focus({ preventScroll: true }); setOpen(false) }
  const keys = (e: KeyboardEvent) => { if (e.key === 'Escape' && open) { e.stopPropagation(); close() } }
  return <div className="guard" data-open={open} data-running={!!running} data-locked={!!disabled} onKeyDown={keys}>
    <button ref={pressRef} id={id} type="button" className="guard-press" disabled={disabled || !open} aria-label={pressLabel ?? `Run ${label}`} aria-describedby={describedBy} data-testid={pressTestId} onClick={() => { onPress(); setOpen(false) }}>
      <span className="guard-press-cap" aria-hidden="true">{running ? 'Running' : caption}</span>
    </button>
    <button ref={coverRef} type="button" className="guard-cover" aria-expanded={open} aria-controls={id} disabled={disabled} title={reason} data-testid={coverTestId} onClick={() => open ? close() : setOpen(true)}>
      <span className="sr">{open ? `Close the cover over ${label}` : `Lift the cover over ${label}`}</span>
    </button>
  </div>
}

export type RotaryOption<T extends string | number> = { value: T; label: string; aria?: string; testId?: string; hint?: string }
/** A rotary selector switch. The labels are real radio buttons; the knob turns to point at the selected one. */
export function Rotary<T extends string | number>({ label, value, options, onPick, disabled, layout, describedBy, testId }: { label: string; value: T | null; options: RotaryOption<T>[]; onPick: (v: T) => void; disabled?: boolean; layout: 'sides' | 'arc'; describedBy?: string; testId?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const index = options.findIndex(o => o.value === value), n = options.length
  const spread = layout === 'sides' ? 52 : 46
  const angle = index < 0 ? 0 : n === 1 ? 0 : -spread + (2 * spread) * index / (n - 1)
  const move = (e: KeyboardEvent, from: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = (from + step + n) % n
    refs.current[next]?.focus(); onPick(options[next].value)
  }
  const knob = <span className="knob" aria-hidden="true" data-unset={index < 0} style={{ '--angle': `${angle}deg` } as CSSProperties}><span className="knob-pointer" /></span>
  const buttons = options.map((o, i) => <button key={String(o.value)} ref={el => { refs.current[i] = el }} type="button" role="radio" aria-label={o.aria} aria-checked={i === index} tabIndex={i === index || (index < 0 && i === 0) ? 0 : -1} className="rotary-opt" data-selected={i === index} data-testid={o.testId} data-value={String(o.value)} disabled={disabled} title={o.hint} onClick={() => onPick(o.value)} onKeyDown={e => move(e, i)}>{o.label}</button>)
  return <div className={`rotary rotary-${layout}`} role="radiogroup" aria-label={label} aria-describedby={describedBy} data-testid={testId}>
    {layout === 'sides' ? <>{buttons[0]}{knob}{buttons.slice(1)}</> : <><span className="rotary-row">{buttons}</span>{knob}</>}
  </div>
}

/** A slide fader (a native range input, so the keyboard works) with a printed scale. */
export function Fader({ id, label, value, min, max, step, onChange, disabled, readout, marks }: { id: string; label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; disabled?: boolean; readout: string; marks: string[] }) {
  return <div className="fader-wrap">
    <label className="fader-label" htmlFor={id}><span>{label}</span><strong className="fader-readout">{readout}</strong></label>
    <input id={id} className="fader" type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={e => onChange(Number(e.target.value))} aria-valuetext={readout} />
    <span className="fader-marks" aria-hidden="true">{marks.map(m => <span key={m}>{m}</span>)}</span>
  </div>
}

/** An engraved plate. `tone` marks alarm plates; otherwise it is plain laminate. */
export function Plate({ children, tone, className = '', ...rest }: { children: ReactNode; tone?: 'alarm' | 'notice' | 'paper'; className?: string } & Record<string, unknown>) {
  return <div className={`plate ${tone ? `plate-${tone}` : ''} ${className}`} {...rest}>{children}</div>
}

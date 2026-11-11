import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Tone } from './console-logic'

/** Status symbols: the shape says the state even without colour. ok = ringed tick, warn = triangle, fault = crossed square, off = ringed dash. */
export function Glyph({ tone, x, y }: { tone: Tone; x?: number; y?: number }) {
  return <svg className="glyph" data-tone={tone} width="14" height="14" viewBox="0 0 14 14" x={x} y={y} aria-hidden="true" focusable="false">
    {tone === 'ok' && <><circle cx="7" cy="7" r="5.75" /><path d="M4.2 7.2l2 2 3.6-4" /></>}
    {tone === 'warn' && <><path d="M7 1.6L13 12.4H1z" /><path d="M7 5.6v3.2M7 10.4v.1" /></>}
    {tone === 'fault' && <><rect x="1.5" y="1.5" width="11" height="11" /><path d="M4.6 4.6l4.8 4.8M9.4 4.6l-4.8 4.8" /></>}
    {tone === 'off' && <><circle cx="7" cy="7" r="5.75" /><path d="M4.6 7h4.8" /></>}
  </svg>
}

/** A symbol and its words. The words are always there; colour only reinforces them. */
export function Status({ tone, label, detail, testId, lit }: { tone: Tone; label: string; detail?: string; testId?: string; lit?: boolean }) {
  return <span className="status" data-tone={tone} data-testid={testId} data-lit={lit}><Glyph tone={tone} /><span>{label}{detail && <small> {detail}</small>}</span></span>
}

export type SegOption<T extends string | number> = { value: T; label: string; aria?: string; testId?: string; hint?: string }
/** A segmented control built as a radio group: one tab stop, arrow keys move and select, every option is a real button with a state. */
export function Segmented<T extends string | number>({ label, value, options, onPick, disabled, describedBy, testId, className = '' }: { label: string; value: T | null; options: SegOption<T>[]; onPick: (v: T) => void; disabled?: boolean; describedBy?: string; testId?: string; className?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const index = options.findIndex(o => o.value === value), n = options.length
  const move = (e: KeyboardEvent, from: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = (from + step + n) % n
    refs.current[next]?.focus(); onPick(options[next].value)
  }
  return <div className={`segmented ${className}`} role="radiogroup" aria-label={label} aria-describedby={describedBy} data-testid={testId}>
    {options.map((o, i) => <button key={String(o.value)} ref={el => { refs.current[i] = el }} type="button" role="radio" aria-label={o.aria} aria-checked={i === index} tabIndex={i === index || (index < 0 && i === 0) ? 0 : -1} className="seg" data-selected={i === index} data-testid={o.testId} data-value={String(o.value)} disabled={disabled} title={o.hint} onClick={() => onPick(o.value)} onKeyDown={e => move(e, i)}>{o.label}</button>)}
  </div>
}

/** An on/off switch with its state in words. */
export function Switch({ on, label, onText = 'On', offText = 'Off', onToggle, disabled, busy, testId, title }: { on: boolean; label: string; onText?: string; offText?: string; onToggle: () => void; disabled?: boolean; busy?: boolean; testId?: string; title?: string }) {
  return <button type="button" role="switch" aria-checked={on} className="switch" data-on={on} data-busy={!!busy} disabled={disabled} title={title} onClick={onToggle} data-testid={testId}>
    <span className="switch-track" aria-hidden="true"><i /></span><span className="switch-label">{label}</span><span className="switch-state">{on ? onText : offText}</span>
  </button>
}

/**
 * A control that asks before it acts. The first press arms it and shows an inline question with Confirm and Cancel;
 * Confirm runs the action, Cancel or Escape backs out, and an armed control disarms itself after eight seconds.
 * The Confirm button is always in the document (hidden until armed) so scripts and tests find it at rest.
 * With confirm={false} the first press acts at once.
 */
export function TwoStep({ children, question, onConfirm, confirm = true, confirmLabel = 'Confirm', disabled, reason, className = 'btn', armTestId, confirmTestId, cancelTestId, armProps, promptClass = 'prompt-row' }: {
  children: ReactNode; question: string; onConfirm: () => void; confirm?: boolean; confirmLabel?: string; disabled?: boolean; reason?: string; className?: string
  armTestId?: string; confirmTestId?: string; cancelTestId?: string; armProps?: Record<string, unknown>; promptClass?: string
}) {
  const [armed, setArmed] = useState(false), armRef = useRef<HTMLButtonElement>(null), confirmRef = useRef<HTMLButtonElement>(null), was = useRef(false), id = useId()
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 8000); return () => clearTimeout(t) }, [armed])
  useEffect(() => { if (disabled) setArmed(false) }, [disabled])
  useEffect(() => { if (armed) confirmRef.current?.focus({ preventScroll: true }); else if (was.current) armRef.current?.focus({ preventScroll: true }); was.current = armed }, [armed])
  const keys = (e: KeyboardEvent) => { if (e.key === 'Escape' && armed) { e.stopPropagation(); setArmed(false) } }
  return <span className="twostep" data-armed={armed} onKeyDown={keys}>
    <button ref={armRef} type="button" className={className} hidden={armed} disabled={disabled} title={reason} aria-expanded={confirm ? armed : undefined} aria-controls={confirm ? id : undefined} data-testid={armTestId} {...armProps} onClick={() => { if (confirm) setArmed(true); else onConfirm() }}>{children}</button>
    <span id={id} className={`prompt ${promptClass}`} role="group" aria-label="Confirmation" hidden={!armed}>
      <span className="prompt-text">{question}</span>
      <span className="prompt-actions">
        <button ref={confirmRef} type="button" className="btn btn-primary" disabled={!armed || disabled} data-testid={confirmTestId} onClick={() => { setArmed(false); onConfirm() }}>{confirmLabel}</button>
        <button type="button" className="btn" data-testid={cancelTestId} onClick={() => setArmed(false)}>Cancel</button>
      </span>
    </span>
  </span>
}

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { num, time, type Grid, type Point } from '../data'
import { nearestIndex, niceMax, scale, tracePath, visibleSamples, yTicks, type Range } from './chart-math'

type Series = 'granted' | 'demand' | 'served'
const SERIES: { key: Series; label: string; word: string }[] = [
  { key: 'granted', label: 'Reserved', word: 'solid heavy line, stepped' },
  { key: 'demand', label: 'Requested', word: 'dashed line' },
  { key: 'served', label: 'Served', word: 'brass line' },
]
const W = 560, H = 212, L = 44, RIGHT = 14, T = 12, B = 28

/** The telemetry history as a strip chart on ruled paper. Real polled observations only; when data stops the paper keeps moving and the pens stay lifted. */
export function Recorder({ grid, onClose }: { grid: Grid; onClose: () => void }) {
  const [range, setRange] = useState<Range>(90), [visible, setVisible] = useState<Record<Series, boolean>>({ granted: true, demand: true, served: true }), [cursor, setCursor] = useState<number | null>(null)
  const uid = useId().replace(/:/g, ''), closeRef = useRef<HTMLButtonElement>(null), plot = useRef<SVGSVGElement>(null)
  useEffect(() => { closeRef.current?.focus({ preventScroll: true }) }, [])
  const samples = useMemo(() => visibleSamples(grid.history, range), [grid.history, range])
  const capacity = grid.cluster?.capacity_amps ?? null
  const max = niceMax(samples.flatMap(p => [p.demand, p.served, p.granted]), capacity)
  const t0 = samples[0]?.at ?? 0, t1 = grid.stale ? Math.max(grid.now, samples.at(-1)?.at ?? 0) : samples.at(-1)?.at ?? 1
  const px = (at: number) => scale(at, t0, t1 === t0 ? t0 + 1 : t1, L, W - RIGHT), py = (v: number) => scale(v, 0, max, H - B, T)
  const xs = samples.map(p => px(p.at))
  const latest = samples.at(-1)
  const idx = cursor === null ? -1 : Math.min(cursor, samples.length - 1)
  const at: Point | undefined = idx >= 0 ? samples[idx] : latest
  const pointer = (e: PointerEvent<SVGSVGElement>) => { const box = e.currentTarget.getBoundingClientRect(); setCursor(nearestIndex(xs, (e.clientX - box.left) / box.width * W)) }
  const keys = (e: KeyboardEvent) => {
    if (!samples.length) return
    const cur = cursor ?? samples.length - 1
    if (e.key === 'ArrowLeft') { e.preventDefault(); setCursor(Math.max(0, cur - 1)) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setCursor(Math.min(samples.length - 1, cur + 1)) }
    else if (e.key === 'Home') { e.preventDefault(); setCursor(0) }
    else if (e.key === 'End') { e.preventDefault(); setCursor(null) }
  }
  const status = grid.stale ? 'No fresh data' : latest ? 'Recording' : 'Waiting for data'
  return <section className="tray" id="recorder-tray" aria-labelledby={`${uid}-t`} data-testid="recorder" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
    <header className="tray-head">
      <h2 id={`${uid}-t`} className="plate engraved">Chart recorder</h2>
      <span className="tray-status" data-stale={grid.stale}>{status}</span>
      <div className="pushes" role="group" aria-label="Samples shown">{([30, 90] as const).map(n => <button key={n} type="button" className="push" aria-pressed={range === n} onClick={() => setRange(n)}>{n} samples</button>)}</div>
      <button ref={closeRef} type="button" className="push push-close" onClick={onClose} data-testid="recorder-close">Push in</button>
    </header>
    <div className="paper">
      {samples.length < 2 ? <p className="paper-empty" role="status"><strong>{samples.length ? 'First observation received.' : 'Waiting for telemetry.'}</strong> The trace starts after a second real observation. {samples.length} of 2 received.</p> :
        <svg ref={plot} className="chart" viewBox={`0 0 ${W} ${H}`} tabIndex={0} role="group" aria-label="Telemetry strip chart. Use the left and right arrow keys to read each sample." onPointerMove={pointer} onPointerLeave={() => setCursor(null)} onKeyDown={keys} onBlur={() => setCursor(null)} data-testid="recorder-chart">
          {yTicks(max).map(v => <g key={v}><line x1={L} x2={W - RIGHT} y1={py(v)} y2={py(v)} className={v % 100 === 0 ? 'rule rule-major' : 'rule'} /><text x={L - 8} y={py(v)} className="axis" textAnchor="end" dominantBaseline="central">{v}</text></g>)}
          {[0, 1, 2, 3].map(i => { const at = t0 + (t1 - t0) * i / 3; return <text key={i} x={px(at)} y={H - 8} className="axis" textAnchor={i === 0 ? 'start' : i === 3 ? 'end' : 'middle'}>{time(at)}</text> })}
          {capacity !== null && <g><line x1={L} x2={W - RIGHT} y1={py(capacity)} y2={py(capacity)} className="chart-limit" /><text x={W - RIGHT - 4} y={py(capacity) - 6} className="limit-label" textAnchor="end">{num(capacity)} A limit</text></g>}
          {visible.demand && <path d={tracePath(xs, samples.map(p => py(p.demand)))} className="pen pen-demand" />}
          {visible.served && <path d={tracePath(xs, samples.map(p => py(p.served)))} className="pen pen-served" />}
          {visible.granted && <path d={tracePath(xs, samples.map(p => py(p.granted)), true)} className="pen pen-granted" />}
          {grid.stale && <rect x={xs[xs.length - 1]} y={T} width={Math.max(0, W - RIGHT - xs[xs.length - 1])} height={H - B - T} className="chart-gap"><title>No fresh data since the last sample</title></rect>}
          {idx >= 0 && cursor !== null && <line x1={xs[idx]} x2={xs[idx]} y1={T} y2={H - B} className="cursor" />}
        </svg>}
    </div>
    <dl className="tray-reads" aria-live="off">
      <div className="tray-time"><dt>{cursor === null ? 'Latest' : 'Sample'}</dt><dd>{at ? time(at.at) : '—'}</dd></div>
      {SERIES.map(s => <div key={s.key}><dt><button type="button" className={`legend legend-${s.key}`} aria-pressed={visible[s.key]} onClick={() => setVisible(v => ({ ...v, [s.key]: !v[s.key] }))}><i aria-hidden="true" />{s.label}<span className="sr"> trace, {s.word}</span></button></dt><dd>{at ? num(at[s.key], 1) : '—'}<small> A</small></dd></div>)}
    </dl>
    <p className="tray-foot">{samples.length} real {samples.length === 1 ? 'sample' : 'samples'} since this page opened. Nothing is filled in between polls.</p>
  </section>
}

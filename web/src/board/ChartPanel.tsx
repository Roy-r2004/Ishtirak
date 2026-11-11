import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { num, time, type Grid, type Point } from '../data'
import { nearestIndex, niceMax, scale, tracePath, visibleSamples, yTicks, type Range } from './chart-math'
import { useSize } from './use-motion'

type Series = 'granted' | 'demand' | 'served'
const SERIES: { key: Series; label: string; word: string }[] = [
  { key: 'granted', label: 'Reserved', word: 'solid blue stepped line' },
  { key: 'demand', label: 'Requested', word: 'dashed line' },
  { key: 'served', label: 'Served', word: 'solid graphite line' },
]
const L = 40, RIGHT = 10, T = 10, B = 22

/** Telemetry history as a line chart. Real polled observations only: nothing is interpolated or filled in, and when data stops the line stops. */
export function ChartPanel({ grid, onClose }: { grid: Grid; onClose: () => void }) {
  const [range, setRange] = useState<Range>(90), [visible, setVisible] = useState<Record<Series, boolean>>({ granted: true, demand: true, served: true }), [cursor, setCursor] = useState<number | null>(null)
  const uid = useId().replace(/:/g, ''), closeRef = useRef<HTMLButtonElement>(null), [area, size] = useSize<HTMLDivElement>()
  useEffect(() => { closeRef.current?.focus({ preventScroll: true }) }, [])
  const samples = useMemo(() => visibleSamples(grid.history, range), [grid.history, range])
  const capacity = grid.cluster?.capacity_amps ?? null
  const W = Math.max(0, size.width), H = Math.max(0, size.height), drawable = W > 160 && H > 70
  const max = niceMax(samples.flatMap(p => [p.demand, p.served, p.granted]), capacity, 40)
  const t0 = samples[0]?.at ?? 0, t1 = grid.stale ? Math.max(grid.now, samples.at(-1)?.at ?? 0) : samples.at(-1)?.at ?? 1
  const px = (at: number) => scale(at, t0, t1 === t0 ? t0 + 1 : t1, L, W - RIGHT), py = (v: number) => scale(v, 0, max, H - B, T)
  const xs = samples.map(p => px(p.at))
  const latest = samples.at(-1)
  const idx = cursor === null ? -1 : Math.min(cursor, samples.length - 1)
  const at: Point | undefined = idx >= 0 ? samples[idx] : latest
  const pointer = (e: PointerEvent<SVGSVGElement>) => { const box = e.currentTarget.getBoundingClientRect(); setCursor(nearestIndex(xs, e.clientX - box.left)) }
  const keys = (e: KeyboardEvent) => {
    if (!samples.length) return
    const cur = cursor ?? samples.length - 1
    if (e.key === 'ArrowLeft') { e.preventDefault(); setCursor(Math.max(0, cur - 1)) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setCursor(Math.min(samples.length - 1, cur + 1)) }
    else if (e.key === 'Home') { e.preventDefault(); setCursor(0) }
    else if (e.key === 'End') { e.preventDefault(); setCursor(null) }
  }
  const status = grid.stale ? 'No fresh data' : latest ? 'Recording' : 'Waiting for data'
  return <section className="chart" aria-labelledby={`${uid}-t`} data-testid="recorder" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
    <header className="chart-bar">
      <h3 id={`${uid}-t`} className="col-title">Reserved, requested and served amps</h3>
      <span className="chart-status" data-stale={grid.stale}>{status}</span>
      <div className="segmented" role="group" aria-label="Samples shown">{([30, 90] as const).map(n => <button key={n} type="button" className="seg" aria-pressed={range === n} data-selected={range === n} onClick={() => setRange(n)}>{n} samples</button>)}</div>
      <button ref={closeRef} type="button" className="btn" onClick={onClose} data-testid="recorder-close">Hide chart</button>
    </header>
    <div className="chart-body">
      <div className="chart-area" ref={area}>
        {samples.length < 2 ? <p className="empty" role="status"><strong>{samples.length ? 'First observation received.' : 'Waiting for telemetry.'}</strong> The line starts after a second real observation. {samples.length} of 2 received.</p> : drawable &&
          <svg className="chart-svg" width={W} height={H} tabIndex={0} role="group" aria-label="Telemetry line chart. Use the left and right arrow keys to read each sample." onPointerMove={pointer} onPointerLeave={() => setCursor(null)} onKeyDown={keys} onBlur={() => setCursor(null)} data-testid="recorder-chart">
            {yTicks(max, 40).map(v => <g key={v}><line x1={L} x2={W - RIGHT} y1={py(v)} y2={py(v)} className="c-grid" /><text x={L - 6} y={py(v)} className="c-axis" textAnchor="end" dominantBaseline="central">{v}</text></g>)}
            {[0, 1, 2, 3].map(i => { const a = t0 + (t1 - t0) * i / 3; return <text key={i} x={px(a)} y={H - 6} className="c-axis" textAnchor={i === 0 ? 'start' : i === 3 ? 'end' : 'middle'}>{time(a)}</text> })}
            {capacity !== null && <g><line x1={L} x2={W - RIGHT} y1={py(capacity)} y2={py(capacity)} className="c-limit" /><text x={W - RIGHT - 4} y={py(capacity) - 6} className="c-limit-label" textAnchor="end">{num(capacity)} A limit</text></g>}
            {visible.demand && <path d={tracePath(xs, samples.map(p => py(p.demand)))} className="pen pen-demand" />}
            {visible.served && <path d={tracePath(xs, samples.map(p => py(p.served)))} className="pen pen-served" />}
            {visible.granted && <path d={tracePath(xs, samples.map(p => py(p.granted)), true)} className="pen pen-granted" />}
            {grid.stale && <rect x={xs[xs.length - 1]} y={T} width={Math.max(0, W - RIGHT - xs[xs.length - 1])} height={H - B - T} className="c-gap"><title>No fresh data since the last sample</title></rect>}
            {idx >= 0 && cursor !== null && <line x1={xs[idx]} x2={xs[idx]} y1={T} y2={H - B} className="c-cursor" />}
          </svg>}
      </div>
      <dl className="chart-reads" aria-live="off">
        <div><dt>{cursor === null ? 'Latest' : 'Sample'}</dt><dd className="mono">{at ? time(at.at) : '—'}</dd></div>
        {SERIES.map(s => <div key={s.key}><dt><button type="button" className={`series series-${s.key}`} aria-pressed={visible[s.key]} onClick={() => setVisible(v => ({ ...v, [s.key]: !v[s.key] }))}><i aria-hidden="true" />{s.label}<span className="sr"> trace, {s.word}</span></button></dt><dd className="mono">{at ? num(at[s.key], 1) : '—'}<small> A</small></dd></div>)}
        <p className="muted">{samples.length} real {samples.length === 1 ? 'sample' : 'samples'} since this page opened. Nothing is filled in between polls.</p>
      </dl>
    </div>
  </section>
}

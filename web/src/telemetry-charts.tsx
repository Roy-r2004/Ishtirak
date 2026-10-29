import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts'
import './telemetry-charts.css'

export type TelemetryPoint = { at: number; demand: number; served: number; granted: number }
type TelemetryChartProps = { points: TelemetryPoint[]; capacity: number; stale: boolean }
type Series = 'demand' | 'served' | 'granted'

const SERIES: { key: Series; label: string; color: string }[] = [
  { key: 'served', label: 'Served', color: '#0d9e81' },
  { key: 'demand', label: 'Requested', color: '#5b7ee1' },
  { key: 'granted', label: 'Reserved', color: '#8491a3' },
]
const formatValue = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 1 })
const formatTime = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export function TelemetryChart({ points, capacity, stale }: TelemetryChartProps) {
  const [range, setRange] = useState<30 | 90>(90)
  const [visible, setVisible] = useState<Record<Series, boolean>>({ demand: true, served: true, granted: true })
  const [width, setWidth] = useState(0)
  const chartRef = useRef<HTMLDivElement>(null)
  const id = useId().replace(/:/g, '')
  const available = useMemo(() => points.filter(point =>
    Number.isFinite(point.at) && Number.isFinite(point.demand) && Number.isFinite(point.served) && Number.isFinite(point.granted)
  ).slice().sort((a, b) => a.at - b.at).slice(-90), [points])
  const samples = useMemo(() => available.slice(-range), [available, range])
  const latest = available.at(-1)
  const safeCapacity = Number.isFinite(capacity) && capacity >= 0 ? capacity : undefined
  const peak = samples.length ? Math.max(...samples.map(point => point.demand)) : undefined
  const ceiling = Math.max(safeCapacity ?? 0, ...samples.flatMap(point => [point.demand, point.served, point.granted]), 1)

  useEffect(() => {
    const element = chartRef.current
    if (!element) return
    const update = () => setWidth(Math.floor(element.getBoundingClientRect().width))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <section className="tc-panel" aria-labelledby={`${id}-title`}>
      <div className="tc-heading-row">
        <div>
          <div className="tc-title-row">
            <h2 id={`${id}-title`}>Power telemetry</h2>
            <span className={`tc-status${stale ? ' tc-status-stale' : ''}`}><span />{stale ? 'Stale data' : latest ? 'Live' : 'Awaiting data'}</span>
          </div>
          <p className="tc-subtitle">Observed demand and delivered capacity over time</p>
        </div>
        <div className="tc-range" role="group" aria-label="Telemetry sample range">
          {([30, 90] as const).map(count => <button key={count} type="button" aria-pressed={range === count} onClick={() => setRange(count)}>{count} samples</button>)}
        </div>
      </div>

      <div className="tc-summary" aria-label="Latest observed values">
        {SERIES.map(series => <div className="tc-metric" key={series.key}>
          <span className="tc-metric-label"><i style={{ background: series.color }} />{series.label}</span>
          <strong>{latest ? formatValue(latest[series.key]) : '—'}<span> A</span></strong>
        </div>)}
        <div className="tc-metric tc-capacity-metric">
          <span className="tc-metric-label">Generator capacity</span>
          <strong>{safeCapacity === undefined ? '—' : formatValue(safeCapacity)}<span> A</span></strong>
        </div>
      </div>

      <div className="tc-chart" ref={chartRef}>
        {samples.length < 2 ? <div className="tc-empty" role="status">
          <span className="tc-empty-icon" aria-hidden="true">↗</span>
          <strong>{samples.length ? 'First observation received' : 'Waiting for telemetry'}</strong>
          <p>{samples.length ? 'The chart will appear after a second real observation.' : 'Live observations will appear here as meters report.'}</p>
          <span>{samples.length} of 2 observations received</span>
        </div> : width > 0 ? <ComposedChart width={width} height={282} data={samples} margin={{ top: 20, right: 13, bottom: 8, left: 0 }} accessibilityLayer>
          <defs>
            <linearGradient id={`${id}-served`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#0d9e81" stopOpacity={0.16} /><stop offset="100%" stopColor="#0d9e81" stopOpacity={0.015} /></linearGradient>
          </defs>
          <CartesianGrid stroke="#e9eef4" vertical={false} strokeDasharray="3 4" />
          <XAxis dataKey="at" type="number" domain={['dataMin', 'dataMax']} tickFormatter={formatTime} tick={{ fill: '#68778c', fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={width < 500 ? 72 : 50} tickMargin={12} />
          <YAxis domain={[0, ceiling * 1.15]} width={width < 420 ? 42 : 49} tickCount={5} tickFormatter={value => formatValue(Number(value))} tick={{ fill: '#68778c', fontSize: 11 }} axisLine={false} tickLine={false} tickMargin={8} />
          <Tooltip cursor={{ stroke: '#c7d1de', strokeDasharray: '4 4' }} content={({ active, payload }) => {
            const point = payload?.[0]?.payload as TelemetryPoint | undefined
            if (!active || !point) return null
            return <div className="tc-tooltip">
              <strong>{new Date(point.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {formatTime(point.at)}</strong>
              {SERIES.filter(series => visible[series.key]).map(series => <div key={series.key}><span><i style={{ background: series.color }} />{series.label}</span><b>{formatValue(point[series.key])} A</b></div>)}
              {safeCapacity !== undefined && <div className="tc-tooltip-capacity"><span>Capacity</span><b>{formatValue(safeCapacity)} A</b></div>}
            </div>
          }} />
          {safeCapacity !== undefined && <ReferenceLine y={safeCapacity} stroke="#c58b35" strokeDasharray="5 5" strokeWidth={1.25} />}
          {visible.served && <Area type="linear" dataKey="served" name="Served" stroke="#0d9e81" strokeWidth={2.5} fill={`url(#${id}-served)`} isAnimationActive={false} dot={false} activeDot={{ r: 4, stroke: '#fff', strokeWidth: 2 }} />}
          {visible.demand && <Line type="linear" dataKey="demand" name="Requested" stroke="#5b7ee1" strokeWidth={2} isAnimationActive={false} dot={false} activeDot={{ r: 4, stroke: '#fff', strokeWidth: 2 }} />}
          {visible.granted && <Line type="linear" dataKey="granted" name="Reserved" stroke="#8491a3" strokeWidth={1.5} strokeDasharray="5 4" isAnimationActive={false} dot={false} activeDot={{ r: 3, stroke: '#fff', strokeWidth: 2 }} />}
        </ComposedChart> : null}
      </div>

      <div className="tc-footer">
        <div className="tc-legend" role="group" aria-label="Visible telemetry series">
          {SERIES.map(series => <button key={series.key} type="button" aria-pressed={visible[series.key]} onClick={() => setVisible(current => ({ ...current, [series.key]: !current[series.key] }))} className={visible[series.key] ? '' : 'tc-series-hidden'}><i style={{ background: series.color }} className={series.key === 'granted' ? 'tc-dashed' : ''} />{series.label}</button>)}
          <span className="tc-capacity-key"><i />Capacity</span>
        </div>
        <span className="tc-observation-note">{samples.length} real {samples.length === 1 ? 'sample' : 'samples'}{peak !== undefined ? ` · Peak request ${formatValue(peak)} A` : ''}</span>
      </div>
    </section>
  )
}

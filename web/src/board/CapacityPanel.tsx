import { useCallback, useId, useMemo, useRef } from 'react'
import { num, time, type Grid } from '../data'
import { percent, fairnessScore } from '../lab/fairness'
import type { Lab } from './use-lab'
import { Status } from './controls'
import { arcPath, buildTicks, describeReading, pegged, polar, scaleStop, valueToAngle } from './dial'
import { amps, capacityFigures, coverage } from './readouts'
import { useReducedMotion, useSpring } from './use-motion'

/** Flat gauge drawing space: a half circle with its hub at the bottom centre. Drawn at this size, so its text is never scaled. */
const W = 300, H = 158, CX = 150, CY = 144, R = 104
const GAUGE = { omega: 11, zeta: 1 }
const PEAK = { omega: 8, zeta: 1 }

export function CapacityPanel({ grid, lab, chartOpen, onOpenChart }: { grid: Grid; lab: Lab; chartOpen: boolean; onOpenChart: (trigger: HTMLElement) => void }) {
  const c = grid.cluster, fresh = lab.fresh && !!c, reduced = useReducedMotion(), uid = useId().replace(/:/g, '')
  const lastValue = useRef<number | null>(null)
  if (fresh) lastValue.current = c!.granted_amps
  const shown = fresh ? c!.granted_amps : lastValue.current
  const capacity = c?.capacity_amps ?? lab.peak.capacity ?? 120, stop = scaleStop(capacity), peakValue = lab.peak.peak
  const needle = useRef<SVGGElement>(null), peakMark = useRef<SVGGElement>(null), fill = useRef<SVGPathElement>(null)
  const rotate = useCallback((el: SVGGElement | null, a: number) => el?.setAttribute('transform', `rotate(${valueToAngle(a, capacity).toFixed(2)} ${CX} ${CY})`), [capacity])
  const setFill = useCallback((a: number) => fill.current?.setAttribute('d', a > 0.05 ? arcPath(CX, CY, R, valueToAngle(0, capacity), valueToAngle(Math.min(a, capacity), capacity)) : ''), [capacity])
  useSpring(shown ?? 0, useCallback((p: number) => { rotate(needle.current, p); setFill(p) }, [rotate, setFill]), reduced, GAUGE)
  useSpring(peakValue ?? 0, useCallback((p: number) => rotate(peakMark.current, p), [rotate]), reduced, PEAK)

  const ticks = useMemo(() => buildTicks(capacity, 10, 10, 20), [capacity])
  const limitAngle = valueToAngle(capacity, capacity), a0 = valueToAngle(0, capacity), a1 = valueToAngle(stop, capacity)
  const figures = capacityFigures({ fresh, capacity: c?.capacity_amps, reserved: c?.granted_amps, buildings: grid.buildings }), partial = coverage(figures)
  const words = describeReading({ value: shown, capacity: fresh || shown !== null ? capacity : null, peak: peakValue, fresh, violations: lab.peak.violations })
  const parked = !fresh
  const noVio = lab.peak.violations === 0
  const score = c ? fairnessScore(c.wants, c.leases) : null
  const proofText = lab.peak.samples === 0
    ? 'Nothing is proven until a fresh observation arrives.'
    : noVio ? `No violation observed in ${num(lab.peak.samples)} fresh samples (limit ${num(lab.peak.capacity ?? capacity)} A).`
      : `Violation observed: ${num(lab.peak.violations)} of ${num(lab.peak.samples)} fresh samples passed ${num(lab.peak.capacity ?? capacity)} A.`
  return <section className="panel capacity" aria-labelledby={`${uid}-t`} data-testid="main-ammeter" data-fresh={fresh} data-selftest="false" data-reserved={shown ?? ''} data-capacity={capacity} data-peak={peakValue ?? ''} data-violations={lab.peak.violations}>
    <header className="panel-head"><h2 id={`${uid}-t`}>Capacity</h2><button type="button" className="btn btn-quiet" aria-expanded={chartOpen} aria-controls="chart-panel" data-testid="recorder-open" onClick={e => onOpenChart(e.currentTarget)}>Chart</button></header>
    <div className="capacity-top">
      <div className="gauge" role="meter" aria-label="Reserved amps against generator capacity" aria-valuemin={0} aria-valuemax={capacity} aria-valuenow={shown ?? undefined} aria-valuetext={words}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true" focusable="false" data-parked={parked}>
          <path d={arcPath(CX, CY, R, a0, limitAngle)} className="g-track" />
          <path d={arcPath(CX, CY, R, limitAngle, a1)} className="g-zone" />
          <path ref={fill} className="g-fill" d="" data-parked={parked} />
          {ticks.map(t => { const len = t.label !== undefined ? 12 : 7, p = polar(CX, CY, R + 8, t.angle), q = polar(CX, CY, R + 8 + len, t.angle); return <line key={t.value} x1={p.x} y1={p.y} x2={q.x} y2={q.y} className="g-tick" /> })}
          {ticks.filter(t => t.label !== undefined).map(t => { const p = polar(CX, CY, R + 30, t.angle); return <text key={t.value} x={p.x} y={p.y} className={`g-num${t.value >= capacity ? ' g-num-limit' : ''}`} textAnchor="middle" dominantBaseline="central">{t.label}</text> })}
          {(() => { const p = polar(CX, CY, R - 12, limitAngle), q = polar(CX, CY, R + 22, limitAngle); return <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} className="g-limit" /> })()}
          <g ref={peakMark} className="g-peak" data-hidden={peakValue === null}><path d={`M${CX} ${CY - R + 9}l-5 9h10z`} /></g>
          <g ref={needle} className="g-needle" data-parked={parked}><line x1={CX} y1={CY} x2={CX} y2={CY - R + 6} /></g>
          <circle cx={CX} cy={CY} r="5" className="g-hub" />
        </svg>
        {parked && <p className="gauge-stale" role="status">No fresh data</p>}
      </div>
      <div className="capacity-read">
        <div className="reading" data-testid="reading"><span className="reading-value mono">{fresh ? num(shown ?? undefined) : '—'}{fresh && <small> A</small>}</span><span className="reading-unit">{fresh ? `of ${num(capacity)} A reserved` : 'No fresh data'}</span>{!fresh && shown !== null && <span className="reading-last mono">Last {num(shown)} A{grid.lastSeen ? ` at ${time(grid.lastSeen)}` : ''}</span>}</div>
        <dl className="kv">
          <div data-testid="peak-readout"><dt>Peak</dt><dd className="mono">{peakValue === null ? '—' : `${num(peakValue)} A`}<span className="sr"> since the console opened</span></dd></div>
          <div data-testid="violations" data-count={lab.peak.violations}><dt>Violations</dt><dd className="mono" data-bad={lab.peak.violations > 0}>{lab.peak.samples ? num(lab.peak.violations) : '—'}</dd></div>
          <div data-testid="fairness" title="How evenly reserved amps are spread across the buildings that want power; 100% means equal shares."><dt>Fairness</dt><dd className="mono">{fresh ? percent(score) : '—'}</dd></div>
        </dl>
      </div>
    </div>
    <dl className="capacity-strip" aria-label="Capacity" data-testid="capacity-strip" data-fresh={fresh}>
      <div data-testid="free-readout" data-value={figures.free ?? ''}><dt>Free</dt><dd className="mono">{amps(figures.free)}</dd></div>
      <div data-testid="served-readout" data-value={figures.served ?? ''}><dt>Served{partial && <small aria-hidden="true">{figures.reporting} of {figures.total}</small>}</dt><dd className="mono">{amps(figures.served)}{partial && <span className="sr"> ({partial})</span>}</dd></div>
      <div data-testid="curtailed-readout" data-value={figures.curtailed ?? ''}><dt>Curtailed{partial && <small aria-hidden="true">{figures.reporting} of {figures.total}</small>}</dt><dd className="mono">{amps(figures.curtailed)}{partial && <span className="sr"> ({partial})</span>}</dd></div>
    </dl>
    <p className="sr" data-testid="ammeter-words">{words}{pegged(shown ?? 0, capacity) ? ' The reading is beyond the end of the scale.' : ''}</p>
    <div className="status-row" role="group" aria-label="Data and limit status">
      <Status tone={fresh ? 'ok' : 'warn'} label={fresh ? 'Fresh data' : 'No fresh data'} testId="lamp-stale" lit={!fresh} />
      <Status tone={fresh && !grid.quorum ? 'warn' : 'ok'} label={fresh && !grid.quorum ? 'Grants paused' : 'Grants active'} testId="lamp-paused" lit={fresh && !grid.quorum} />
      <Status tone={lab.peak.violations > 0 ? 'fault' : 'ok'} label={lab.peak.violations > 0 ? `Limit exceeded, ${num(lab.peak.violations)} samples` : 'Within limit'} testId="lamp-limit" lit={lab.peak.violations > 0} />
    </div>
    <p className="proof" data-testid="capacity-proof" data-state={lab.peak.samples === 0 ? 'none' : noVio ? 'safe' : 'violated'}>{proofText}<span className="sr"> This is evidence from sampled observations, not proof for unsampled instants.</span></p>
  </section>
}

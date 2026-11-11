import { useCallback, useId, useMemo, useRef } from 'react'
import { num, time, type Grid } from '../data'
import type { Lab } from './use-lab'
import { Lamp } from './controls'
import { amps, capacityFigures, coverage } from './readouts'
import { arcPath, buildTicks, clampToScale, describeReading, pegged, polar, scaleStop, valueToAngle } from './dial'
import { useReducedMotion, useSpring, type SelfTestPhase } from './use-motion'

/** Dial drawing space. The bezel is a circle whose lower part is hidden behind the readout plate; the needle pivots low in the face. */
const W = 500, H = 298, BX = 250, BY = 214, PX = 250, PY = 282, R = 206, NEEDLE = 200
const DIAL_PARAMS = { omega: 9, zeta: 0.8 }
const PEAK_PARAMS = { omega: 6, zeta: 0.9 }

function Digits({ text, lit }: { text: string; lit: boolean }) {
  return <span className="digits" data-lit={lit} aria-hidden="true">{[...text].map((c, i) => <span key={i} className="digit">{c}</span>)}</span>
}

export function Ammeter({ grid, lab, selfTest }: { grid: Grid; lab: Lab; selfTest: SelfTestPhase }) {
  const c = grid.cluster, fresh = lab.fresh && !!c, testing = selfTest !== 'done', reduced = useReducedMotion()
  const uid = useId().replace(/:/g, '')
  const lastValue = useRef<number | null>(null)
  if (fresh) lastValue.current = c!.granted_amps
  const shown = fresh ? c!.granted_amps : lastValue.current
  const capacity = c?.capacity_amps ?? lab.peak.capacity ?? 120
  const stop = scaleStop(capacity)
  const peakValue = lab.peak.peak
  const target = selfTest === 'up' ? stop : selfTest === 'down' ? 0 : shown ?? 0
  const needle = useRef<SVGGElement>(null), peakNeedle = useRef<SVGGElement>(null)
  const place = useCallback((el: SVGGElement | null, amps: number) => el?.setAttribute('transform', `translate(${PX} ${PY}) rotate(${valueToAngle(amps, capacity).toFixed(2)})`), [capacity])
  useSpring(target, useCallback((p: number) => place(needle.current, p), [place]), reduced, DIAL_PARAMS)
  useSpring(peakValue ?? 0, useCallback((p: number) => place(peakNeedle.current, p), [place]), reduced, PEAK_PARAMS)

  const ticks = useMemo(() => buildTicks(capacity), [capacity])
  const limitAngle = valueToAngle(capacity, capacity), stopAngle = valueToAngle(stop, capacity)
  const words = describeReading({ value: shown, capacity: fresh || shown !== null ? capacity : null, peak: peakValue, fresh, violations: lab.peak.violations })
  const parked = !fresh && !testing
  const readout = testing ? '88' : fresh ? num(shown ?? undefined) : '—'
  const noVio = lab.peak.violations === 0
  const figures = capacityFigures({ fresh, capacity: c?.capacity_amps, reserved: c?.granted_amps, buildings: grid.buildings }), partial = coverage(figures)
  const proofText = lab.peak.samples === 0
    ? 'Nothing is proven until a fresh observation arrives.'
    : noVio
      ? `No violation observed in ${num(lab.peak.samples)} fresh samples (limit ${num(lab.peak.capacity ?? capacity)} A).`
      : `Violation observed: ${num(lab.peak.violations)} of ${num(lab.peak.samples)} fresh samples passed ${num(lab.peak.capacity ?? capacity)} A.`
  return <section className="ammeter" aria-labelledby={`${uid}-t`} data-testid="main-ammeter" data-fresh={fresh} data-selftest={testing} data-reserved={shown ?? ''} data-capacity={capacity} data-peak={peakValue ?? ''} data-violations={lab.peak.violations}>
    <header className="plate-head"><h2 id={`${uid}-t`} className="plate engraved">Generator</h2></header>
    <div className="bezel-wrap">
      <div className="bezel">
        <div className="meter-face" role="meter" aria-label="Main ammeter, reserved amps" aria-valuemin={0} aria-valuemax={capacity} aria-valuenow={shown ?? undefined} aria-valuetext={words}>
        <svg viewBox={`0 0 ${W} ${H}`} className="dial" aria-hidden="true" focusable="false" data-parked={parked}>
          <defs>
            <radialGradient id={`${uid}-face`} cx="50%" cy="38%" r="75%"><stop offset="0" stopColor="#F6F0DD" /><stop offset=".7" stopColor="var(--ivory)" /><stop offset="1" stopColor="#D9D0B6" /></radialGradient>
            <linearGradient id={`${uid}-mirror`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff" /><stop offset=".5" stopColor="#B9BBB5" /><stop offset="1" stopColor="#F2F2EE" /></linearGradient>
            <radialGradient id={`${uid}-hub`} cx="35%" cy="30%" r="80%"><stop offset="0" stopColor="#E7CE8C" /><stop offset=".55" stopColor="var(--brass)" /><stop offset="1" stopColor="#6E5320" /></radialGradient>
            <pattern id={`${uid}-hatch`} width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><rect width="9" height="9" fill="none" /><path d="M0 0V9" stroke="var(--plate)" strokeWidth="2.2" opacity=".16" /></pattern>
            <filter id={`${uid}-shadow`} x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="3" dy="5" stdDeviation="2.5" floodColor="#000" floodOpacity=".28" /></filter>
          </defs>
          <circle cx={BX} cy={BY} r={214} className="dial-bezel" />
          <circle cx={BX} cy={BY} r={199} className="dial-lip" />
          <circle cx={BX} cy={BY} r={194} fill={`url(#${uid}-face)`} />
          <path d={arcPath(PX, PY, R + 10, valueToAngle(0, capacity), stopAngle)} className="dial-mirror" stroke={`url(#${uid}-mirror)`} />
          <path d={arcPath(PX, PY, R, valueToAngle(0, capacity), limitAngle)} className="dial-arc" />
          <path d={arcPath(PX, PY, R, limitAngle, stopAngle)} className="dial-red" />
          {ticks.map(t => { const len = t.kind === 'major' ? 22 : t.kind === 'mid' ? 15 : 9, a = polar(PX, PY, R, t.angle), b = polar(PX, PY, R - len, t.angle); return <line key={t.value} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`tick tick-${t.kind}`} /> })}
          {ticks.filter(t => t.label !== undefined).map(t => { const p = polar(PX, PY, R - 46, t.angle); return <text key={t.value} x={p.x} y={p.y} className={`dial-num ${t.value >= capacity ? 'dial-num-limit' : ''}`} textAnchor="middle" dominantBaseline="central">{t.label}</text> })}
          {(() => { const a = polar(PX, PY, R - 30, limitAngle), b = polar(PX, PY, R + 14, limitAngle); return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="dial-limit" /> })()}
          <text x={PX} y={50} className="dial-legend" textAnchor="middle">Amperes reserved</text>
          <g className="dial-keys" aria-hidden="true">
            <g transform="translate(78 244)"><line x1="0" y1="0" x2="26" y2="0" className="key-needle" /><text x="34" y="0" className="dial-key" dominantBaseline="central">Now</text></g>
            <g transform="translate(78 272)"><line x1="0" y1="0" x2="26" y2="0" className="key-peak" /><text x="34" y="0" className="dial-key" dominantBaseline="central">Peak</text></g>
          </g>
          <g ref={peakNeedle} className="needle-peak" data-hidden={peakValue === null || testing}>
            <path d={`M0 16V${-(R + 8)}`} className="peak-line" />
            <path d={`M0 ${-(R + 8)}l8 -11h-16z`} className="peak-flag" />
          </g>
          <g ref={needle} className="needle" data-parked={parked} filter={`url(#${uid}-shadow)`}>
            <path d={`M-4.5 0L-0.8 ${-NEEDLE}H0.8L4.5 0V30H-4.5Z`} className="needle-body" />
            <rect x="-7" y="24" width="14" height="26" rx="2" className="needle-weight" />
          </g>
          <circle cx={PX} cy={PY} r="15" fill={`url(#${uid}-hub)`} className="hub" />
          <circle cx={PX} cy={PY} r="5" className="hub-screw" />
          {parked && <g className="dial-veil"><rect x="0" y="0" width={W} height={H} fill={`url(#${uid}-hatch)`} clipPath="circle(194px at 250px 214px)" /></g>}
          <circle cx={BX} cy={BY} r={194} className="dial-glass" fill="none" />
        </svg>
        </div>
        {parked && <div className="dial-stale" role="status"><strong>No fresh data</strong><span className="sr">The needle is parked at the last reading.</span></div>}
      </div>
      <div className="readout" data-testid="reading">
        <div className="readout-main">
          <Digits text={readout} lit={fresh || testing} />
          <span className="readout-unit"><span>{testing ? 'Self-test' : fresh ? `of ${num(capacity)} A` : 'No fresh data'}</span>{!fresh && !testing && shown !== null && <small>Last {num(shown)} A{grid.lastSeen ? ` at ${time(grid.lastSeen)}` : ''}</small>}</span>
        </div>
        <dl className="readout-side">
          <div data-testid="peak-readout"><dt>Peak</dt><dd>{peakValue === null ? '—' : `${num(peakValue)} A`}<span className="sr"> since the board opened</span></dd></div>
          <div data-testid="violations" data-count={lab.peak.violations}><dt>Violations</dt><dd data-bad={lab.peak.violations > 0}>{lab.peak.samples ? num(lab.peak.violations) : '—'}</dd></div>
        </dl>
      </div>
    </div>
    <p className="sr" data-testid="ammeter-words">{words}{pegged(shown ?? 0, capacity) ? ' The needle is pressed against its stop.' : ''}</p>
    <dl className="capacity-strip" aria-label="Capacity" data-testid="capacity-strip" data-fresh={fresh}>
      <div data-testid="free-readout" data-value={figures.free ?? ''}><dt>Free</dt><dd>{amps(figures.free)}</dd></div>
      <div data-testid="served-readout" data-value={figures.served ?? ''}><dt>Served{partial && <small aria-hidden="true">{figures.reporting} of {figures.total}</small>}</dt><dd>{amps(figures.served)}{partial && <span className="sr"> ({partial})</span>}</dd></div>
      <div data-testid="curtailed-readout" data-value={figures.curtailed ?? ''}><dt>Curtailed{partial && <small aria-hidden="true">{figures.reporting} of {figures.total}</small>}</dt><dd>{amps(figures.curtailed)}{partial && <span className="sr"> ({partial})</span>}</dd></div>
    </dl>
    <div className="annunciator" role="group" aria-label="Meter lamps">
      <Lamp tone="green" lit={fresh || testing} label="Fresh data" />
      <Lamp tone="amber" lit={!fresh || testing} label="No fresh data" testId="lamp-stale" />
      <Lamp tone="amber" lit={(fresh && !grid.quorum) || testing} label="Grants paused" testId="lamp-paused" />
      <Lamp tone="red" lit={lab.peak.violations > 0 || testing} label="Limit exceeded" testId="lamp-limit" detail={lab.peak.violations > 0 ? `${num(lab.peak.violations)} samples` : undefined} />
    </div>
    <p className="proof" data-testid="capacity-proof" data-state={lab.peak.samples === 0 ? 'none' : noVio ? 'safe' : 'violated'}>{proofText}<span className="sr"> This is evidence from sampled observations, not proof for unsampled instants.</span></p>
  </section>
}

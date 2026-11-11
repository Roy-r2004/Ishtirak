import { useEffect, useId, useRef, useState } from 'react'
import { num, type Grid } from '../data'
import { Segmented, Switch } from './controls'

/** The meter simulator and the two services a failure test would otherwise stop: PostgreSQL and the MQTT broker. */
export function Simulation({ grid }: { grid: Grid }) {
  const uid = useId().replace(/:/g, ''), enabled = !!grid.data?.demo_enabled
  const [count, setCount] = useState(50), [factor, setFactor] = useState(1), initialized = useRef(false)
  useEffect(() => { if (grid.data?.meters.data && !initialized.current) { setCount(grid.data.meters.data.meter_count); setFactor(grid.data.meters.data.demand_factor); initialized.current = true } }, [grid.data])
  const busy = !enabled || !!grid.busy
  const meters = grid.data?.meters.data, dbOn = !!grid.cluster?.postgres_connected, brokerOn = !!meters?.mqtt_connected
  return <div className="sim" data-testid="sim">
    <section className="sim-col" aria-label="Meter simulator">
      <h3 className="col-title">Meters</h3>
      <Segmented label="Household meters" value={count} options={[10, 50, 200].map(n => ({ value: n, label: String(n), aria: `${n} meters`, testId: `meters-${n}` }))} onPick={setCount} disabled={busy} testId="meters-rotary" />
      <div className="slider">
        <label htmlFor={`${uid}-f`}><span>Demand multiplier</span><strong className="mono">{factor.toFixed(1)}×</strong></label>
        <input id={`${uid}-f`} type="range" min={0} max={3} step={0.1} value={factor} disabled={busy} onChange={e => setFactor(Number(e.target.value))} aria-valuetext={`${factor.toFixed(1)} times`} />
        <span className="slider-marks mono" aria-hidden="true"><span>0×</span><span>1×</span><span>2×</span><span>3×</span></span>
      </div>
      <button type="button" className="btn btn-primary" disabled={busy} aria-label="Apply simulation" data-testid="sim-apply" onClick={() => void grid.post('/api/meters/config', { meter_count: count, demand_factor: factor }, 'simulation')}>{grid.busy === 'simulation' ? 'Applying' : 'Apply'}</button>
    </section>
    <section className="sim-col" aria-label="Simulator status">
      <h3 className="col-title">Simulator</h3>
      <dl className="kv">
        <div><dt>Active meters</dt><dd className="mono" data-testid="active-meters">{num(meters?.meter_count)}</dd></div>
        <div><dt>Demand multiplier</dt><dd className="mono">{meters ? `${meters.demand_factor.toFixed(1)}×` : '—'}</dd></div>
        <div><dt>Readings published</dt><dd className="mono">{num(meters?.published_readings)}</dd></div>
      </dl>
    </section>
    <section className="sim-col" aria-label="Supporting services">
      <h3 className="col-title">Services</h3>
      <Switch on={dbOn} busy={grid.busy.endsWith('postgres')} label="PostgreSQL" testId="breaker-database" disabled={busy} onToggle={() => grid.act('postgres', dbOn ? 'stop' : 'start')} />
      <Switch on={brokerOn} busy={grid.busy.endsWith('mosquitto')} label="MQTT broker" testId="breaker-broker" disabled={busy} onToggle={() => grid.act('mosquitto', brokerOn ? 'stop' : 'start')} />
      <p className="muted">Stopping a service shows how the system behaves without it. Start it again to restore normal operation.</p>
    </section>
  </div>
}

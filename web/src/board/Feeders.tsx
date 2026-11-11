import { names, districts, num, type Grid } from '../data'
import { fairnessScore, percent, shareRows } from '../lab/fairness'
import { Lamp, Lever, type Tone } from './controls'
import { describeTiers, tierSegments, tiersOf } from './tiers'

const MW = 250, TRACK_Y = 14, TRACK_H = 14
const x = (amps: number, scale: number) => scale > 0 ? Math.max(0, Math.min(MW, amps / scale * MW)) : 0

/** The feeder's mini meter: a ruler 0 to capacity, the reservation as a staircase of tiers, a mark for demand above it and one for the fair share below. */
function MiniMeter({ scale, demand, fair, tiers, dim }: { scale: number; demand: number | null; fair: number | null; tiers: ReturnType<typeof tiersOf>; dim: boolean }) {
  const segs = tierSegments(tiers)
  return <svg className="mini" viewBox={`0 0 ${MW} 44`} aria-hidden="true" focusable="false" data-dim={dim}>
    {Array.from({ length: Math.floor(scale / 10) + 1 }, (_, i) => i * 10).map(v => <line key={v} x1={x(v, scale)} x2={x(v, scale)} y1={TRACK_Y + TRACK_H} y2={TRACK_Y + TRACK_H + (v % 60 === 0 ? 6 : 3)} className="mini-tick" />)}
    <rect x="0" y={TRACK_Y} width={MW} height={TRACK_H} rx="2" className="mini-track" />
    {segs.map(s => <rect key={s.version} x={x(s.lo, scale)} width={Math.max(0, x(s.hi, scale) - x(s.lo, scale))} y={TRACK_Y} height={TRACK_H} className={`mini-seg mini-${s.role}`} />)}
    <line x1={MW - 1} x2={MW - 1} y1={TRACK_Y - 3} y2={TRACK_Y + TRACK_H + 3} className="mini-limit" />
    {demand !== null && <path d={`M${x(demand, scale)} ${TRACK_Y - 2}l-6 -12h12z`} className="mark-demand" />}
    {fair !== null && <path d={`M${x(fair, scale)} ${TRACK_Y + TRACK_H + 2}l-6 12h12z`} className="mark-fair" />}
  </svg>
}

export function Feeders({ grid, enabled, onOpen }: { grid: Grid; enabled: boolean; onOpen: (id: string, trigger: HTMLElement) => void }) {
  const c = grid.cluster, ids = grid.buildings.map(b => b.id)
  const rows = shareRows(ids, c?.wants, c?.leases, c?.fair_shares), score = fairnessScore(c?.wants, c?.leases)
  const capacity = c?.capacity_amps ?? 120, fairOn = grid.policy === 'fair_share'
  return <section className="feeders" aria-labelledby="feeders-title" data-testid="feeders">
    <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: 'absolute' }}><defs><pattern id="tier-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--ivory)" /><path d="M0 0V6" className="tier-hatch-line" /></pattern></defs></svg>
    <header className="plate-head">
      <h2 id="feeders-title" className="plate engraved">Feeders</h2>
      <p className="fairness" data-testid="fairness" title="How evenly reserved amps are spread across the buildings that want power; 100% means equal shares.">Fairness score <strong>{percent(score)}</strong></p>
    </header>
    <div className="feeder-row">
      {grid.buildings.map((b, i) => {
        const d = b.data, row = rows[i], lease = c?.leases.find(l => l.building_id === b.id), tiers = tiersOf(lease)
        const remaining = Math.max(0, (d?.lease_remaining_ms ?? 0) - Math.max(0, grid.now - grid.lastSeen))
        const service = `gateway-${b.id.replaceAll('_', '-')}`
        const status = !b.online ? 'Offline' : grid.stale ? 'Stale' : d?.state === 'active' ? 'Within budget' : d?.state === 'limited' ? 'Demand limited' : d?.state === 'expired' ? 'Lease expired' : 'Awaiting capacity'
        const tone: Tone = !b.online ? 'amber' : d?.state === 'expired' ? 'red' : d?.state === 'active' && !grid.stale ? 'green' : 'amber'
        const lit = b.online
        const mqttLit = b.online && !!d?.mqtt_connected
        const reserved = c ? lease?.amps ?? 0 : null
        const fair = fairOn && row?.fair != null ? row.fair : null
        const busy = grid.busy.endsWith(service)
        const name = names[b.id] ?? b.id, district = districts[b.id] ?? b.id
        const reservedAmps = reserved ?? 0
        return <article className="feeder" key={b.id} data-testid="feeder" data-building={b.id} data-state={status} data-stale={grid.stale} data-online={b.online}>
          <header className="feeder-head">
            <button type="button" className="feeder-open" onClick={e => onOpen(b.id, e.currentTarget)} data-testid="feeder-open" aria-label={`Open the inspection door for ${name}`}>
              <span className="feeder-district">{district}</span><span className="feeder-building">{name}</span>
            </button>
            <Lever on={b.online} busy={busy} label={`Gateway breaker, ${district}`} caption={b.online ? 'On' : 'Off'} testId="feeder-breaker" disabled={!enabled || !!grid.busy} title={!enabled ? 'Controls are switched off.' : grid.busy ? 'Another action is in progress.' : b.online ? 'Switch the gateway off' : 'Switch the gateway on'} onToggle={() => grid.act(service, b.online ? 'stop' : 'start')} />
          </header>
          <div className="mini-wrap" role="img" aria-label={`${district} feeder. Demand ${b.online ? `${num(d?.demand_amps, 1)} amps` : 'unknown'}. Reserved ${reserved === null ? 'unknown' : `${num(reserved)} amps`}.${fair !== null ? ` Fair share ${num(fair, 1)} amps.` : ''} ${describeTiers(tiers)}`}>
            <MiniMeter scale={capacity} demand={b.online && d ? d.demand_amps : null} fair={fair} tiers={tiers} dim={grid.stale} />
            <span className="mini-ends" aria-hidden="true"><span>0</span>{tiers.length > 1 && <span className="tier-note" data-testid="tier-note">Steps down to <strong>{num(tiers[tiers.length - 1].amps)} A</strong></span>}<span>{num(capacity)} A</span></span>
          </div>
          <dl className="feeder-reads">
            <div><dt><i className="swatch swatch-demand" aria-hidden="true" />Demand</dt><dd data-testid="feeder-demand">{b.online ? num(d?.demand_amps, 1) : '—'}<small> A</small></dd></div>
            <div><dt><i className="swatch swatch-reserved" aria-hidden="true" />Reserved</dt><dd data-testid="feeder-reserved">{reserved === null ? '—' : num(reservedAmps)}<small> A</small></dd></div>
            {fairOn ? <div><dt><i className="swatch swatch-fair" aria-hidden="true" />Fair share</dt><dd>{fair === null ? '—' : num(fair, 1)}<small> A</small></dd></div> : <div><dt>Served</dt><dd>{b.online ? num(d?.served_amps, 1) : '—'}<small> A</small></dd></div>}
          </dl>
          <div className="feeder-lamps">
            <Lamp tone={tone} lit={lit} label={status} testId="feeder-state" />
            <Lamp tone="green" lit={mqttLit} label={b.online ? (d?.mqtt_connected ? 'MQTT connected' : 'MQTT down') : 'No readings'} />
          </div>
          <dl className="feeder-foot">
            <div className={remaining > 0 && remaining < 2000 ? 'low' : ''}><dt>Lease</dt><dd>{b.online ? `${(remaining / 1000).toFixed(1)} s` : '—'}</dd></div>
            <div><dt>Pending</dt><dd>{b.online ? num(d?.pending_readings) : '—'}</dd></div>
            <div><dt>Dropped</dt><dd>{b.online ? num(d?.dropped_readings) : '—'}</dd></div>
          </dl>
        </article>
      })}
    </div>
  </section>
}

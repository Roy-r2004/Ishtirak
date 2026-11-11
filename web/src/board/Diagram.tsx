import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { districts, names, num, time, type Grid } from '../data'
import { shareRows } from '../lab/fairness'
import { Glyph, Status, TwoStep } from './controls'
import { CLUSTER_SIZE, breakerText, clusterGeometry, feederStatus, lineWeight, nodeStatus, voteSummary, wireState } from './console-logic'
import { describeTiers, tierSegments, tiersOf } from './tiers'

const wire = (amps: number | null, capacity: number): CSSProperties => ({ ['--w' as string]: `${lineWeight(amps, capacity)}px` })

/** Generator symbol: a circle with a G, as on any single-line diagram. */
function GeneratorSymbol() {
  return <svg className="sym" width="52" height="52" viewBox="0 0 52 52" aria-hidden="true" focusable="false"><circle cx="26" cy="26" r="24" /><text x="26" y="27" textAnchor="middle" dominantBaseline="central" className="sym-letter">G</text></svg>
}
/** Breaker symbol: a filled square when closed, an empty square when open. */
function BreakerSymbol({ closed }: { closed: boolean }) {
  return <svg className="sym sym-breaker" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false"><rect x="2" y="2" width="14" height="14" className={closed ? 'closed' : 'open'} /></svg>
}

/** The lease on a 0 to capacity scale: reserved tiers as a stepped bar, a mark for demand above it and one for the fair share below it. */
function Bar({ capacity, demand, fair, tiers, dim }: { capacity: number; demand: number | null; fair: number | null; tiers: ReturnType<typeof tiersOf>; dim: boolean }) {
  const pct = (a: number) => `${Math.max(0, Math.min(100, a / capacity * 100))}%`
  return <div className="bar" data-dim={dim} aria-hidden="true">
    <div className="bar-track">
      {tierSegments(tiers).map(s => <i key={s.version} className={`bar-seg bar-${s.role}`} style={{ left: pct(s.lo), width: `calc(${pct(s.hi)} - ${pct(s.lo)})` }} />)}
      <i className="bar-limit" />
    </div>
    {demand !== null && <i className="bar-mark bar-demand" style={{ left: pct(demand) }} />}
    {fair !== null && <i className="bar-mark bar-fair" style={{ left: pct(fair) }} />}
  </div>
}

function Feeder({ grid, id, capacity, enabled, onOpen }: { grid: Grid; id: string; capacity: number; enabled: boolean; onOpen: (id: string, trigger: HTMLElement) => void }) {
  const c = grid.cluster, b = grid.buildings.find(x => x.id === id)!, d = b.data
  const ids = grid.buildings.map(x => x.id), row = shareRows(ids, c?.wants, c?.leases, c?.fair_shares)[ids.indexOf(id)]
  const lease = c?.leases.find(l => l.building_id === id), tiers = tiersOf(lease)
  const remaining = Math.max(0, (d?.lease_remaining_ms ?? 0) - Math.max(0, grid.now - grid.lastSeen))
  const service = `gateway-${id.replaceAll('_', '-')}`, fairOn = grid.policy === 'fair_share'
  const status = feederStatus({ online: b.online, stale: grid.stale, state: d?.state })
  const reserved = c ? lease?.amps ?? 0 : null, fair = fairOn && row?.fair != null ? row.fair : null
  const name = names[id] ?? id, district = districts[id] ?? id
  const wireTone = wireState({ online: b.online, stale: grid.stale, reserved })
  const lock = !enabled ? 'Controls are switched off.' : grid.busy ? 'Another action is in progress.' : ''
  const busy = grid.busy.endsWith(service)
  return <article className="feeder" data-testid="feeder" data-building={id} data-state={status.label} data-stale={grid.stale} data-online={b.online}>
    <div className="drop" data-wire={wireTone} style={wire(reserved, capacity)}><span className="dim mono">{reserved === null ? '—' : `${num(reserved)} A`}</span></div>
    <div className="breaker-slot">
      <TwoStep className="breaker" question="Stop gateway?" confirm={b.online} disabled={!!lock} reason={lock || (b.online ? 'Stop the gateway' : 'Start the gateway')} armTestId="feeder-breaker" confirmTestId="feeder-breaker-confirm" cancelTestId="feeder-breaker-cancel" promptClass="prompt-pop"
        armProps={{ role: 'switch', 'aria-checked': b.online, 'aria-label': `Gateway breaker, ${district}`, 'data-busy': busy }} onConfirm={() => grid.act(service, b.online ? 'stop' : 'start')}>
        <BreakerSymbol closed={b.online} /><span className="breaker-text">{breakerText(b.online)}</span>
      </TwoStep>
    </div>
    <div className="stub" data-wire={wireTone} style={wire(reserved, capacity)} />
    <div className="meter-block">
      <div className="meter-head">
        <button type="button" className="name-link" data-testid="feeder-open" aria-label={`Open details for ${name}`} onClick={e => onOpen(id, e.currentTarget)}>{name}</button>
        <Status tone={status.tone} label={status.label} testId="feeder-state" />
      </div>
      <Bar capacity={capacity} demand={b.online && d ? d.demand_amps : null} fair={fair} tiers={tiers} dim={grid.stale} />
      <div className="bar-ends mono" aria-hidden="true"><span>0</span><span>{num(capacity)} A</span></div>
      <p className="sr">{`${district} feeder. Demand ${b.online ? `${num(d?.demand_amps, 1)} amps` : 'unknown'}. Reserved ${reserved === null ? 'unknown' : `${num(reserved)} amps`}.${fair !== null ? ` Fair share ${num(fair, 1)} amps.` : ''} ${describeTiers(tiers)}`}</p>
      <dl className="readings">
        <div><dt><i className="key key-demand" aria-hidden="true" />Demand</dt><dd className="mono" data-testid="feeder-demand">{b.online ? num(d?.demand_amps, 1) : '—'}<small> A</small></dd></div>
        <div><dt><i className="key key-reserved" aria-hidden="true" />Reserved</dt><dd className="mono" data-testid="feeder-reserved">{reserved === null ? '—' : num(reserved)}<small> A</small></dd></div>
        {fairOn ? <div><dt><i className="key key-fair" aria-hidden="true" />Fair share</dt><dd className="mono">{fair === null ? '—' : num(fair, 1)}<small> A</small></dd></div> : <div><dt>Served</dt><dd className="mono">{b.online ? num(d?.served_amps, 1) : '—'}<small> A</small></dd></div>}
      </dl>
      <p className="tier-line" data-testid="tier-note">{tiers.length > 1 ? <>Steps down to <b className="mono">{num(tiers[tiers.length - 1].amps)} A</b></> : <span aria-hidden="true">&nbsp;</span>}</p>
      <dl className="facts">
        <div className={remaining > 0 && remaining < 2000 ? 'low' : ''}><dt>Lease</dt><dd className="mono">{b.online ? `${(remaining / 1000).toFixed(1)} s` : '—'}</dd></div>
        <div><dt>Pending</dt><dd className="mono">{b.online ? num(d?.pending_readings) : '—'}</dd></div>
        <div><dt>Dropped</dt><dd className="mono">{b.online ? num(d?.dropped_readings) : '—'}</dd></div>
      </dl>
      <p className="mqtt"><Glyph tone={b.online && d?.mqtt_connected ? 'ok' : 'off'} /> {b.online ? (d?.mqtt_connected ? 'MQTT connected' : 'MQTT down') : 'No readings'}</p>
    </div>
  </article>
}

/** Counts up each time the highest applied index grows: the observable sign that a grant committed. */
function useCommitPulse(grid: Grid, fresh: boolean): number {
  const [pulse, setPulse] = useState(0), last = useRef<number | null>(null)
  const applied = Math.max(-1, ...grid.nodes.filter(n => n.online).map(n => Number(n.data?.raft?.applied_index ?? -1)))
  useEffect(() => {
    if (!fresh || applied < 0) return
    if (last.current !== null && applied > last.current) setPulse(p => p + 1)
    last.current = applied
  }, [applied, fresh])
  return pulse
}

/** The three coordinators drawn as a cluster: the leader marked, replication links between every pair, term and applied index beside each. */
function Cluster({ grid, onOpenCluster }: { grid: Grid; onOpenCluster: (trigger: HTMLElement) => void }) {
  const fresh = !grid.stale && !!grid.cluster && !!grid.data, pulse = useCommitPulse(grid, fresh), uid = useId().replace(/:/g, '')
  const reachable = grid.nodes.filter(n => n.online).length, total = grid.nodes.length
  const vote = voteSummary({ stale: grid.stale, quorum: grid.quorum, reachable, total })
  const geo = clusterGeometry(grid.nodes.map(n => n.id)), at = (id: string) => geo.nodes.find(n => n.id === id)!
  const up = (id: string) => !!grid.nodes.find(n => n.id === id)?.online
  const roleOf = (id: string) => { const n = grid.nodes.find(x => x.id === id)!; return !n.online ? 'Unreachable' : n.data?.state === 'Leader' ? 'Leader' : n.data?.state === 'Candidate' ? 'Candidate' : 'Follower' }
  return <section className="cluster" aria-labelledby={`${uid}-t`} data-testid="cluster">
    <header className="panel-head"><h2 id={`${uid}-t`}>Raft cluster</h2><button type="button" className="btn btn-quiet" aria-haspopup="dialog" data-testid="cluster-open" onClick={e => onOpenCluster(e.currentTarget)}>Cluster details</button></header>
    <svg className="cluster-svg" width={CLUSTER_SIZE.width} height={CLUSTER_SIZE.height} viewBox={`0 0 ${CLUSTER_SIZE.width} ${CLUSTER_SIZE.height}`} role="img" aria-label={`Raft cluster of ${total} coordinators with replication links between each pair. ${grid.nodes.map(n => `${n.id.replace('coordinator', 'Coordinator ')}: ${roleOf(n.id)}`).join('. ')}.`}>
      {geo.links.map(l => <path key={`${l.from}-${l.to}`} d={l.path} className="c-link" data-live={up(l.from) && up(l.to) && !grid.stale} />)}
      {geo.nodes.map(n => {
        const node = grid.nodes.find(x => x.id === n.id)!, d = node.data, role = roleOf(n.id), st = nodeStatus(role, grid.stale), num_ = n.id.replace(/\D/g, '')
        return <g key={n.id} data-testid="cluster-node" data-node={n.id} data-role={role} className="c-node" data-leader={role === 'Leader'} data-up={node.online}>
          {role === 'Leader' && <circle cx={n.x} cy={n.y} r="22" className="c-ring" />}
          <circle cx={n.x} cy={n.y} r="17" className="c-disc" />
          <text x={n.x} y={n.y + 1} textAnchor="middle" dominantBaseline="central" className="c-num">{num_}</text>
          <text x="86" y={n.y - 14} className="c-name">{`Coordinator ${num_}`}</text>
          <Glyph tone={st.tone} x={86} y={n.y - 8} />
          <text x="106" y={n.y + 3} className={`c-role c-role-${st.tone}`}>{st.label}</text>
          <text x="86" y={n.y + 24} className="c-meta">{node.online && d?.raft ? `term ${d.raft.term ?? '—'}  applied ${d.raft.applied_index ?? '—'}` : 'term —  applied —'}</text>
        </g>
      })}
    </svg>
    <div className="vote" data-testid="vote-strip" data-pulse={pulse} role="group" aria-label={`${vote.label}. ${vote.detail}`}>
      <span className="vote-boxes" aria-hidden="true">{grid.nodes.map(n => <i key={n.id} className={n.online && !grid.stale ? 'on' : ''} />)}</span>
      <Status tone={vote.tone} label={vote.label} detail={fresh ? `${reachable} of ${total}` : undefined} />
    </div>
  </section>
}

export function Diagram({ grid, enabled, onOpenBuilding, onOpenCluster }: { grid: Grid; enabled: boolean; onOpenBuilding: (id: string, trigger: HTMLElement) => void; onOpenCluster: (trigger: HTMLElement) => void }) {
  const c = grid.cluster, capacity = c?.capacity_amps ?? 120, total = c ? c.granted_amps : null, uid = useId().replace(/:/g, '')
  const busWire = wireState({ online: true, stale: grid.stale, reserved: total })
  return <section className="panel diagram" aria-labelledby={`${uid}-t`} data-testid="diagram">
    <header className="panel-head"><h2 id={`${uid}-t`}>Buildings</h2><span className="muted">Single-line diagram. Line weight shows reserved amps. Observed {grid.lastSeen ? time(grid.lastSeen) : 'never'}.</span></header>
    <div className="diagram-body">
      <div className="sld">
        <div className="source">
          <div className="source-sym"><GeneratorSymbol /><div className="source-text"><strong>Generator</strong><span className="mono">{num(capacity)} A rating</span></div></div>
          <div className="drop source-drop" data-wire={busWire} style={wire(total, capacity)}><span className="dim mono">{total === null ? '—' : `${num(total)} A reserved`}</span></div>
        </div>
        <div className="bus" data-wire={busWire} style={wire(total, capacity)} aria-hidden="true" />
        <div className="feeders" data-testid="feeders">{grid.buildings.map(b => <Feeder key={b.id} grid={grid} id={b.id} capacity={capacity} enabled={enabled} onOpen={onOpenBuilding} />)}</div>
        <p className="legend" aria-hidden="true"><svg className="sym sym-breaker" width="14" height="14" viewBox="0 0 18 18"><rect x="2" y="2" width="14" height="14" className="closed" /></svg> closed <svg className="sym sym-breaker" width="14" height="14" viewBox="0 0 18 18"><rect x="2" y="2" width="14" height="14" className="open" /></svg> open <i className="key key-demand" /> demand <i className="key key-reserved" /> reserved <i className="key key-fair" /> fair share</p>
      </div>
      <Cluster grid={grid} onOpenCluster={onOpenCluster} />
    </div>
  </section>
}

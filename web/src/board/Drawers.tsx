import { useState, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { names, districts, num, time, type Building, type Grid, type Source } from '../data'
import { OVERLOAD, forBackend, overload, scenarios } from '../lab/scenarios'
import { describeTiers, tiersOf } from './tiers'
import { filterAudit, kindFilters, kindText, ledgerCaption } from './ledger-logic'
import { clusterFacts, nodeRows } from './cluster-details'
import { Segmented, Status } from './controls'
import { activeSource, shortSession, type PairView } from './standby-logic'
import type { Theme } from './console-logic'

/** A right-side drawer: a modal dialog, so focus is trapped inside, Escape closes it and focus returns to the control that opened it. */
function Drawer({ open, onClose, title, description, restore, closeLabel = 'Close', testId, closeTestId, wide, children }: { open: boolean; onClose: () => void; title: string; description: string; restore: () => void; closeLabel?: string; testId: string; closeTestId?: string; wide?: boolean; children: ReactNode }) {
  return <Dialog.Root open={open} onOpenChange={o => { if (!o) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="scrim" />
      <Dialog.Content className={wide ? 'drawer drawer-wide' : 'drawer'} data-testid={testId} onCloseAutoFocus={e => { e.preventDefault(); restore() }}>
        <header className="drawer-head"><Dialog.Title className="drawer-title">{title}</Dialog.Title><Dialog.Close className="btn" data-testid={closeTestId ?? `${testId}-close`}>{closeLabel}</Dialog.Close></header>
        <Dialog.Description className="drawer-lede">{description}</Dialog.Description>
        <div className="drawer-body">{children}</div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

/** Everything the building dialog always showed, plus the reservation's tiers. */
export function BuildingDrawer({ grid, id, onClose, restore }: { grid: Grid; id: string | null; onClose: () => void; restore: () => void }) {
  // With standby gateways the figures come from the gateway that serves the building (the primary unless the standby serves).
  const primary = grid.buildings.find(x => x.id === id), standby = grid.standbys?.find(x => x.id === id), pair = id ? grid.pairs?.[id] ?? null : null
  const b = primary && pair ? activeSource(primary, standby, pair) : primary, d = b?.data, lease = grid.cluster?.leases.find(l => l.building_id === id), tiers = tiersOf(lease)
  const rows: [string, string][] = [['Requested demand', `${num(d?.demand_amps, 1)} A`], ['Served demand', `${num(d?.served_amps, 1)} A`], ['Lease version', num(d?.lease_version)], ['Readings received', num(d?.readings_total)], ['Pending storage', num(d?.pending_readings)], ['Dropped readings', num(d?.dropped_readings)]]
  return <Drawer open={!!id} onClose={onClose} restore={restore} testId="feeder-door" title={id ? names[id] ?? id : ''} description="Latest observed gateway state. Lease authority remains in the Raft ledger.">
    {b && <>
      <dl className="kv-grid">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="mono">{v}</dd></div>)}</dl>
      <p className="drawer-note"><b>Ledger reservation.</b> {describeTiers(tiers)}</p>
      {pair && primary ? <GatewayTable grid={grid} id={b.id} pair={pair} primary={primary} standby={standby} /> : <>
        <p className="drawer-note">{grid.stale ? 'These observations are stale.' : b.online ? `The ${districts[b.id] ?? b.id} gateway is responding to the latest health check.` : 'The gateway is unavailable. Its last observations may no longer apply.'}</p>
        {d?.last_error && <p className="banner banner-red" role="status">{d.last_error}</p>}
      </>}
    </>}
  </Drawer>
}

/** Both gateways of a building side by side: who serves, then each one's session, lease, broker link and reading queue. A value that was not reported reads as an em dash. */
function GatewayTable({ grid, id, pair, primary, standby }: { grid: Grid; id: string; pair: PairView; primary: Source<Building>; standby: Source<Building> | undefined }) {
  const cols = [{ g: pair.primary, src: primary }, { g: pair.standby, src: standby }]
  const elapsed = Math.max(0, grid.now - grid.lastSeen)
  const reported = (c: (typeof cols)[number]) => !grid.stale && c.src?.online && !!c.src.data
  const rows: [string, (c: (typeof cols)[number]) => string][] = [
    ['Session', c => reported(c) ? shortSession(c.src?.data?.session_id) : '—'],
    ['Lease remaining', c => !reported(c) ? '—' : c.g.state === 'serving' ? `${(Math.max(0, c.src!.data!.lease_remaining_ms - elapsed) / 1000).toFixed(1)} s` : 'No lease'],
    ['MQTT', c => !reported(c) ? '—' : c.src!.data!.mqtt_connected ? 'Connected' : 'Down'],
    ['Pending readings', c => reported(c) ? num(c.src!.data!.pending_readings) : '—'],
    ['Dropped readings', c => reported(c) ? num(c.src!.data!.dropped_readings) : '—'],
  ]
  return <>
    <h3 className="drawer-sub">Gateways</h3>
    <p className="drawer-note" data-testid="gateway-door-headline"><b>{pair.headline}.</b> {pair.detail}{grid.stale ? ' These observations are stale.' : ''}</p>
    <div className="table-scroll table-door">
      <table className="grid-table cluster-table" data-testid="gateway-door-table">
        <caption className="sr">The primary and standby gateways of {districts[id] ?? id} as last reported</caption>
        <thead><tr><td />{cols.map(c => <th scope="col" key={c.g.side} data-testid="gateway-door-col" data-side={c.g.side} data-role={c.g.state}>{c.g.name}</th>)}</tr></thead>
        <tbody>
          <tr><th scope="row">Role</th>{cols.map(c => <td key={c.g.side} data-field="Role"><Status tone={c.g.tone} label={c.g.word} /></td>)}</tr>
          {rows.map(([name, pick]) => { const values = cols.map(pick); return <tr key={name}><th scope="row">{name}</th>{values.map((v, i) => <td key={cols[i].g.side} data-field={name} data-unknown={v === '—'} className="mono">{v}</td>)}</tr> })}
        </tbody>
      </table>
    </div>
    {cols.map(c => c.src?.data?.last_error && !grid.stale ? <p key={c.g.side} className={c.g.state === 'standby' ? 'drawer-note' : 'banner banner-red'} role="status"><b>{c.g.name} gateway.</b> {c.src.data.last_error}</p> : null)}
  </>
}

/** The complete allocation log: every event the coordinators still hold (up to 100), newest first, with search, a kind filter and the JSON export. */
export function FullLogDrawer({ grid, open, onClose, restore }: { grid: Grid; open: boolean; onClose: () => void; restore: () => void }) {
  return <Drawer open={open} onClose={onClose} restore={restore} testId="ledger-door" wide title="Full log" description="Every committed capacity decision the coordinators still hold, newest first.">
    <FullLogBody grid={grid} />
  </Drawer>
}
function FullLogBody({ grid }: { grid: Grid }) {
  const [query, setQuery] = useState(''), [kind, setKind] = useState('all')
  const view = filterAudit(grid.cluster?.audit, query, kind), narrowed = query.trim() !== '' || kind !== 'all'
  return <>
    <div className="toolbar">
      <label className="field"><span className="sr">Search the full log by building, event number or kind</span><input type="search" placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} data-testid="ledger-door-search" /></label>
      <label className="field"><span className="sr">Show</span><select value={kind} onChange={e => setKind(e.target.value)} data-testid="ledger-door-filter">{kindFilters.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <button type="button" className="btn" onClick={grid.exportAudit} disabled={!grid.cluster} title="Export the newest 100 replicated events as JSON" data-testid="ledger-door-tear">Export</button>
    </div>
    <div className="table-scroll table-door" tabIndex={0} role="region" aria-label="Full log entries, newest first">
      <table className="grid-table">
        <caption className="sr">Committed capacity decisions, newest first</caption>
        <thead><tr><th scope="col" className="num">Event</th><th scope="col">Building</th><th scope="col">Entry</th><th scope="col" className="num">Amps</th><th scope="col" className="num">Version</th><th scope="col" className="num">Time</th></tr></thead>
        <tbody>{view.rows.map(a => <tr key={a.event_id} data-testid="ledger-door-row" data-kind={a.kind}><th scope="row" className="mono num">{a.event_id}</th><td>{names[a.building_id] ?? a.building_id}</td><td>{kindText(a.kind)}</td><td className="mono num">{num(a.amps)}</td><td className="mono num">{a.version}</td><td className="mono num">{time(a.occurred_at)}</td></tr>)}</tbody>
      </table>
      {!view.rows.length && <p className="empty">{view.available ? 'No entry matches. Clear the search or choose All events.' : 'Waiting for the first decision.'}</p>}
    </div>
    <p className="drawer-note" role="status" data-testid="ledger-door-caption">{grid.stale ? 'No fresh data: these entries are from the last update. ' : ''}{ledgerCaption(view, narrowed)}</p>
  </>
}

/** Every coordinator's last report side by side, plus the cluster facts. A field that was not reported reads "unknown". */
export function ClusterDrawer({ grid, open, onClose, restore }: { grid: Grid; open: boolean; onClose: () => void; restore: () => void }) {
  const rows = nodeRows(grid.nodes)
  const facts = clusterFacts({ stale: grid.stale, cluster: grid.cluster, reachable: grid.nodes.filter(n => n.online).length, total: grid.nodes.length, quorum: grid.quorum, streamLive: grid.streamLive, policy: grid.policy })
  const fields: [string, (r: (typeof rows)[number]) => string][] = [['Reachable', r => r.reachable], ['Role', r => r.role], ['Raft state', r => r.raftState], ['Leader', r => r.leaderId], ['Term', r => r.term], ['Applied index', r => r.applied], ['Last log index', r => r.lastLog], ['Commit index', r => r.commit], ['Snapshot index', r => r.snapshot], ['Reserved', r => r.reserved]]
  return <Drawer open={open} onClose={onClose} restore={restore} testId="cluster-door" wide title="Cluster details" description="What each coordinator last reported. A value that was not reported is shown as unknown, never filled in.">
    {grid.stale && <p className="banner banner-amber" role="status">No fresh data. These values are from the last update.</p>}
    <dl className="kv-grid" data-testid="cluster-facts">{facts.map(f => <div key={f.key} data-testid="cluster-fact" data-fact={f.key} data-value={f.value}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>
    <div className="table-scroll table-door">
      <table className="grid-table cluster-table" data-testid="cluster-table">
        <caption className="sr">Each coordinator as last reported</caption>
        <thead><tr><td />{rows.map(r => <th scope="col" key={r.id} data-testid="cluster-door-node" data-node={r.id} data-role={r.role}>{r.name}</th>)}</tr></thead>
        <tbody>{fields.map(([name, pick]) => <tr key={name}><th scope="row">{name}</th>{rows.map(r => { const v = pick(r); return <td key={r.id} data-field={name} data-unknown={v === 'unknown'} className="mono">{v}</td> })}</tr>)}</tbody>
      </table>
    </div>
  </Drawer>
}

export function AboutDrawer({ open, onClose, restore, demo, theme, onTheme, legacy }: { open: boolean; onClose: () => void; restore: () => void; demo: boolean; theme: Theme; onTheme: (t: Theme) => void; legacy: boolean }) {
  return <Drawer open={open} onClose={onClose} restore={restore} wide testId="help-dialog" closeTestId="help-close" title="About this system" description="Meters publish readings over MQTT. Each building asks for a budget. Three coordinators use Raft to agree before a grant becomes official.">
    <div className="notes">
      <p className="banner banner-blue"><b>The one rule.</b> Total reserved amps never exceed the generator capacity, even while parts fail.</p>
      <h3>How an amp gets reserved</h3>
      <ol className="steps-list">
        <li><b>Measure.</b> Each building's gateway adds up the demand of its meters.</li>
        <li><b>Agree.</b> The gateway asks for a budget. A majority of the three coordinators must commit it before it counts.</li>
        <li><b>Protect.</b> A gateway stops serving before the ledger can hand its amps to anyone else.</li>
      </ol>
      <h3>Reading the console</h3>
      <ul>
        <li>The diagram shows the generator, the bus and the three buildings. Line weight and the label beside each line give the amps reserved for it.</li>
        <li>A filled square means the gateway process is running; an empty one means it is stopped. This control starts or stops the {legacy ? '' : 'primary '}gateway. A running gateway still needs a valid grant to serve demand.</li>
        {!legacy && <li data-testid="about-standby">Each building has a primary and a standby gateway. If the serving one stops, the standby takes over once the lease lapses, a gap of about 12 to 15 seconds without service for that building. This covers gateway failure only: the MQTT broker and PostgreSQL still have no failover.</li>}
        <li>The stepped bar in each building shows its reservation by tier. It shortens as older tiers expire and the reservation falls to current demand.</li>
        <li>Currently served is simulated delivery reported by gateways. The gauge shows capacity held in the ledger, which may remain above zero after service stops. Releasing it needs a majority and a committed safe expiry. The marker is the highest fresh reservation since the console opened.</li>
        <li>Every status has a symbol and a word. If data stops arriving the gauge parks and says so.</li>
        <li>The allocation log lists committed decisions, newest first. Export saves them as JSON.</li>
      </ul>
      <h3>Failure tests</h3>
      <p>Each test asks for confirmation, stops services in the local project, observes the effect and restores everything it changed.</p>
      <dl className="notes-tests">
        {scenarios.map(base => { const s = forBackend(base, legacy); return <div key={s.id}><dt>{s.title}</dt><dd>{s.blurb}</dd></div> })}
        <div><dt>{overload.title}</dt><dd>{overload.blurb} The load is raised to {OVERLOAD.peak.meter_count} meters for {OVERLOAD.peakMs / 1000} s.</dd></div>
      </dl>
      <h3>Appearance</h3>
      <Segmented label="Colour theme" value={theme} options={[{ value: 'auto' as Theme, label: 'Automatic', testId: 'theme-auto' }, { value: 'light' as Theme, label: 'Light', testId: 'theme-light' }, { value: 'dark' as Theme, label: 'Dark', testId: 'theme-dark' }]} onPick={onTheme} testId="theme-switch" />
      <p className="drawer-note">{demo ? 'This copy runs on a simulator in your browser, so every figure is generated, not observed from a real system. It is marked Simulated data in the top bar. ' : ''}A local educational simulation. No physical electrical equipment is controlled. Values are timestamped observations.</p>
    </div>
  </Drawer>
}

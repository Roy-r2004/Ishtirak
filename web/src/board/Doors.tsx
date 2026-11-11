import { useState, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { names, districts, num, time, type Grid } from '../data'
import { OVERLOAD, overload, scenarios } from '../lab/scenarios'
import { describeTiers, tiersOf } from './tiers'
import { filterAudit, kindFilters, kindText, ledgerCaption } from './ledger-logic'
import { clusterFacts, nodeRows } from './cluster-details'

/** The inspection door: a metal door that swings open over the board. A modal dialog, so focus is trapped and Escape closes it. */
function Door({ open, onClose, title, description, restore, label, testId, wide, children }: { open: boolean; onClose: () => void; title: string; description: string; restore: () => void; label: string; testId: string; wide?: boolean; children: ReactNode }) {
  return <Dialog.Root open={open} onOpenChange={o => { if (!o) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="door-shade" />
      <Dialog.Content className={wide ? 'door door-wide' : 'door'} data-testid={testId} onCloseAutoFocus={e => { e.preventDefault(); restore() }}>
        <span className="hinge" aria-hidden="true"><i /><i /><i /></span>
        <header className="door-head"><Dialog.Title className="door-title">{title}</Dialog.Title><Dialog.Close className="push" data-testid={`${testId}-close`}>{label}</Dialog.Close></header>
        <Dialog.Description className="door-lede">{description}</Dialog.Description>
        <div className="door-body">{children}</div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

/** Everything the old building dialog showed, plus the reservation's tiers. */
export function FeederDoor({ grid, id, onClose, restore }: { grid: Grid; id: string | null; onClose: () => void; restore: () => void }) {
  const b = grid.buildings.find(x => x.id === id), d = b?.data, lease = grid.cluster?.leases.find(l => l.building_id === id), tiers = tiersOf(lease)
  const rows: [string, string][] = [['Requested demand', `${num(d?.demand_amps, 1)} A`], ['Served demand', `${num(d?.served_amps, 1)} A`], ['Lease version', num(d?.lease_version)], ['Readings received', num(d?.readings_total)], ['Pending storage', num(d?.pending_readings)], ['Dropped readings', num(d?.dropped_readings)]]
  return <Door open={!!id} onClose={onClose} restore={restore} testId="feeder-door" label="Close the door" title={id ? names[id] ?? id : ''} description="Latest observed gateway state. Lease authority remains in the Raft ledger.">
    {b && <>
      <dl className="door-grid">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <p className="door-tiers"><b>Ledger reservation.</b> {describeTiers(tiers)}</p>
      <p className="door-note">{grid.stale ? 'These observations are stale.' : b.online ? `The ${districts[b.id] ?? b.id} gateway is responding to the latest health check.` : 'The gateway is unavailable. Its last observations may no longer apply.'}</p>
      {d?.last_error && <p className="plate plate-alarm door-error" role="status">{d.last_error}</p>}
    </>}
  </Door>
}

/** The complete audit table: every event the coordinators still hold (up to 100), newest first, with search, a kind filter and the JSON export. */
export function LedgerDoor({ grid, open, onClose, restore }: { grid: Grid; open: boolean; onClose: () => void; restore: () => void }) {
  return <Door open={open} onClose={onClose} restore={restore} testId="ledger-door" wide label="Close the ledger" title="Full ledger" description="Every committed capacity decision the coordinators still hold, newest first.">
    <LedgerBody grid={grid} />
  </Door>
}
function LedgerBody({ grid }: { grid: Grid }) {
  const [query, setQuery] = useState(''), [kind, setKind] = useState('all')
  const view = filterAudit(grid.cluster?.audit, query, kind), narrowed = query.trim() !== '' || kind !== 'all'
  return <>
    <div className="door-tools">
      <label className="stamp-field"><span className="sr">Search the full ledger by building, event number or kind</span><input type="search" placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} data-testid="ledger-door-search" /></label>
      <label className="ledger-filter"><span className="sr">Show</span><select value={kind} onChange={e => setKind(e.target.value)} data-testid="ledger-door-filter">{kindFilters.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <button type="button" className="tear" onClick={grid.exportAudit} disabled={!grid.cluster} title="Export the newest 100 replicated events as JSON" data-testid="ledger-door-tear">Tear off</button>
    </div>
    <div className="tape tape-door" tabIndex={0} role="region" aria-label="Full ledger entries, newest first">
      <table>
        <caption className="sr">Committed capacity decisions, newest first</caption>
        <thead><tr><th scope="col">Event</th><th scope="col">Building</th><th scope="col">Entry</th><th scope="col" className="num">Amps</th><th scope="col" className="num">Version</th><th scope="col" className="num">Time</th></tr></thead>
        <tbody>{view.rows.map(a => <tr key={a.event_id} data-testid="ledger-door-row" data-kind={a.kind}><th scope="row" className="num">{a.event_id}</th><td>{names[a.building_id] ?? a.building_id}</td><td>{kindText(a.kind)}</td><td className="num">{num(a.amps)}</td><td className="num">{a.version}</td><td className="num">{time(a.occurred_at)}</td></tr>)}</tbody>
      </table>
      {!view.rows.length && <p className="tape-empty">{view.available ? 'No entry matches. Clear the search or choose All events.' : 'Waiting for the first decision.'}</p>}
    </div>
    <p className="door-note" role="status" data-testid="ledger-door-caption">{grid.stale ? 'No fresh data: these entries are from the last update. ' : ''}{ledgerCaption(view, narrowed)}</p>
  </>
}

/** Every coordinator's last report side by side, plus the cluster facts of the old cluster page. A field that was not reported reads "unknown". */
export function ClusterDoor({ grid, open, onClose, restore }: { grid: Grid; open: boolean; onClose: () => void; restore: () => void }) {
  const rows = nodeRows(grid.nodes)
  const facts = clusterFacts({ stale: grid.stale, cluster: grid.cluster, reachable: grid.nodes.filter(n => n.online).length, total: grid.nodes.length, quorum: grid.quorum, streamLive: grid.streamLive, policy: grid.policy })
  const fields: [string, (r: (typeof rows)[number]) => string][] = [['Reachable', r => r.reachable], ['Role', r => r.role], ['Raft state', r => r.raftState], ['Leader', r => r.leaderId], ['Term', r => r.term], ['Applied index', r => r.applied], ['Last log index', r => r.lastLog], ['Commit index', r => r.commit], ['Snapshot index', r => r.snapshot], ['Reserved', r => r.reserved]]
  return <Door open={open} onClose={onClose} restore={restore} testId="cluster-door" wide label="Close the door" title="Cluster details" description="What each coordinator last reported. A value that was not reported is shown as unknown, never filled in.">
    {grid.stale && <p className="plate plate-alarm door-error" role="status">No fresh data. These values are from the last update.</p>}
    <dl className="door-grid" data-testid="cluster-facts">{facts.map(f => <div key={f.key} data-testid="cluster-fact" data-fact={f.key} data-value={f.value}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>
    <div className="door-table">
      <table className="cluster-table" data-testid="cluster-table">
        <caption className="sr">Each coordinator as last reported</caption>
        <thead><tr><td />{rows.map(r => <th scope="col" key={r.id} data-testid="cluster-door-node" data-node={r.id} data-role={r.role}>{r.name}</th>)}</tr></thead>
        <tbody>{fields.map(([name, pick]) => <tr key={name}><th scope="row">{name}</th>{rows.map(r => { const v = pick(r); return <td key={r.id} data-field={name} data-unknown={v === 'unknown'}>{v}</td> })}</tr>)}</tbody>
      </table>
    </div>
  </Door>
}

export function HelpDoor({ open, onClose, restore, demo }: { open: boolean; onClose: () => void; restore: () => void; demo: boolean }) {
  return <Dialog.Root open={open} onOpenChange={o => { if (!o) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="door-shade" />
      <Dialog.Content className="door door-notes" data-testid="help-dialog" onCloseAutoFocus={e => { e.preventDefault(); restore() }}>
        <span className="hinge" aria-hidden="true"><i /><i /><i /></span>
        <header className="door-head"><Dialog.Title className="door-title">Commissioning notes</Dialog.Title><Dialog.Close className="push" data-testid="help-close">Close the notes</Dialog.Close></header>
        <Dialog.Description className="door-lede">Meters publish readings over MQTT. Each building asks for a budget. Three coordinators use Raft to agree before a grant becomes official.</Dialog.Description>
        <div className="door-body notes">
          <p className="plate plate-paper rule-plate"><strong>The one rule:</strong> total reserved amps never exceed the generator capacity, even while parts fail.</p>
          <h3>How an amp gets reserved</h3>
          <ol className="notes-steps">
            <li><b>Measure.</b> Each building’s gateway adds up its meters’ demand.</li>
            <li><b>Agree.</b> The gateway asks for a budget. A majority of the three coordinators must commit it before it counts.</li>
            <li><b>Protect.</b> A gateway stops serving before the ledger can hand its amps to anyone else.</li>
          </ol>
          <h3>Reading the board</h3>
          <ul>
            <li>The big needle is the total reserved in the leader’s ledger. The thin brass needle is the highest fresh reading since you opened this page.</li>
            <li>A lamp is lit for a reason and always carries a word. If data stops arriving, the needle parks and says so.</li>
            <li>Each feeder shows a building’s demand, what the ledger reserved for it, and its fair share. A reservation steps down as older tiers run out.</li>
            <li>The ledger tape lists committed decisions, newest first. Tear off exports them as JSON.</li>
          </ul>
          <h3>Breaking things on purpose</h3>
          <p>Lift a cover on the test panel and press. Each test stops real services in the local project, waits to see the effect, then puts everything back.</p>
          <dl className="notes-tests">
            {scenarios.map(s => <div key={s.id}><dt>{s.title}</dt><dd>{s.blurb}</dd></div>)}
            <div><dt>{overload.title}</dt><dd>{overload.blurb} It floods with {OVERLOAD.peak.meter_count} meters for {OVERLOAD.peakMs / 1000} s.</dd></div>
          </dl>
          <p className="door-note">{demo ? 'This copy runs on a simulator in your browser, so every number is generated, not observed from a real system. It is marked Simulated data wherever you look. ' : ''}A local educational simulation. No physical electrical equipment is controlled. Values are timestamped observations.</p>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

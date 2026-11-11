import { useState } from 'react'
import { names, num, time, type Grid } from '../data'
import { filterAudit, kindFilters, kindText } from './ledger-logic'

/** The audit trail: one line per committed capacity decision, newest first, with search, a kind filter, Export and the full view. */
export function AllocationLog({ grid, onOpenFull }: { grid: Grid; onOpenFull: (trigger: HTMLElement) => void }) {
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all')
  const view = filterAudit(grid.cluster?.audit, query, filter), rows = view.rows
  return <div className="log" data-testid="ledger">
    <div className="toolbar">
      <label className="field"><span className="sr">Search the allocation log by building, event number or kind</span><input type="search" placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} data-testid="ledger-search" /></label>
      <label className="field"><span className="sr">Show</span><select value={filter} onChange={e => setFilter(e.target.value)} data-testid="ledger-filter">{kindFilters.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <button type="button" className="btn" onClick={grid.exportAudit} disabled={!grid.cluster} title="Export the newest 100 replicated events as JSON" data-testid="ledger-tear">Export</button>
      <button type="button" className="btn" onClick={e => onOpenFull(e.currentTarget)} data-testid="ledger-open" aria-haspopup="dialog">Full log</button>
      <span className="muted toolbar-note">{grid.stale ? 'No fresh data. These entries are from the last update. ' : ''}{rows.length} of {view.available} shown. Full history is in PostgreSQL.</span>
    </div>
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Allocation log entries, newest first">
      <table className="grid-table">
        <caption className="sr">Committed capacity decisions, newest first</caption>
        <thead><tr><th scope="col" className="num">Event</th><th scope="col">Building</th><th scope="col">Entry</th><th scope="col" className="num">Amps</th><th scope="col" className="num">Version</th><th scope="col" className="num">Time</th></tr></thead>
        <tbody>{rows.map(a => <tr key={a.event_id} data-testid="ledger-row" data-kind={a.kind}><th scope="row" className="mono num">{a.event_id}</th><td>{names[a.building_id] ?? a.building_id}</td><td>{kindText(a.kind)}</td><td className="mono num">{num(a.amps)}</td><td className="mono num">{a.version}</td><td className="mono num">{time(a.occurred_at)}</td></tr>)}</tbody>
      </table>
      {!rows.length && <p className="empty" role="status">{view.available ? 'No entry matches. Clear the search or choose All events.' : 'Waiting for the first decision. Committed grants are listed here as they happen.'}</p>}
    </div>
  </div>
}

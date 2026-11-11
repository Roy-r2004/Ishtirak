import { useId, useState } from 'react'
import { names, num, time, type Grid } from '../data'
import { filterAudit, kindFilters, kindText } from './ledger-logic'

/** The audit trail as a paper tape: typed lines, newest at the top, a stamp field to search, a tear-off to export. */
export function Ledger({ grid, onOpenFull }: { grid: Grid; onOpenFull: (trigger: HTMLElement) => void }) {
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), uid = useId().replace(/:/g, '')
  const view = filterAudit(grid.cluster?.audit, query, filter), rows = view.rows
  return <section className="ledger" aria-labelledby={`${uid}-t`} data-testid="ledger">
    <header className="ledger-head">
      <h2 id={`${uid}-t`} className="plate engraved">Ledger</h2>
      <div className="ledger-tools">
        <label className="stamp-field"><span className="sr">Search the ledger by building, event number or kind</span><input type="search" placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} data-testid="ledger-search" /></label>
        <label className="ledger-filter"><span className="sr">Show</span><select value={filter} onChange={e => setFilter(e.target.value)} data-testid="ledger-filter">{kindFilters.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <button type="button" className="tear" onClick={grid.exportAudit} disabled={!grid.cluster} title="Export the newest 100 replicated events as JSON" data-testid="ledger-tear">Tear off</button>
        <button type="button" className="push push-head" onClick={e => onOpenFull(e.currentTarget)} data-testid="ledger-open" aria-haspopup="dialog">Full ledger</button>
      </div>
    </header>
    <div className="tape" tabIndex={0} role="region" aria-label="Ledger entries, newest first">
      <table>
        <caption className="sr">Committed capacity decisions, newest first</caption>
        <thead><tr><th scope="col">Event</th><th scope="col">Building</th><th scope="col">Entry</th><th scope="col" className="num">Amps</th><th scope="col" className="num">Version</th><th scope="col" className="num">Time</th></tr></thead>
        <tbody>{rows.map(a => <tr key={a.event_id} data-testid="ledger-row" data-kind={a.kind}><th scope="row" className="num">{a.event_id}</th><td>{names[a.building_id] ?? a.building_id}</td><td>{kindText(a.kind)}</td><td className="num">{num(a.amps)}</td><td className="num">{a.version}</td><td className="num">{time(a.occurred_at)}</td></tr>)}</tbody>
      </table>
      {!rows.length && <p className="tape-empty" role="status">{view.available ? 'No entry matches. Clear the search or choose All events.' : 'Waiting for the first decision. Committed grants will be typed here as they happen.'}</p>}
    </div>
    <p className="ledger-foot">{grid.stale ? 'No fresh data. These entries are from the last update. ' : ''}{rows.length} of {view.available} shown. Full history is in PostgreSQL.</p>
  </section>
}

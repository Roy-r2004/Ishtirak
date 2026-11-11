import { useId } from 'react'
import { num, type Grid } from '../data'
import { Status, TwoStep } from './controls'
import { nodeStatus } from './console-logic'

const label = (id: string) => `Coordinator ${id.replace(/\D/g, '') || id}`

/** One row per coordinator: role, Raft term and indexes, the amps in its ledger copy, and Stop or Start with an inline confirmation. */
export function CoordinatorsTable({ grid, enabled }: { grid: Grid; enabled: boolean }) {
  const uid = useId().replace(/:/g, ''), reachable = grid.nodes.filter(n => n.online).length
  return <section className="panel coordinators" aria-labelledby={`${uid}-t`} data-testid="council">
    <header className="panel-head"><h2 id={`${uid}-t`}>Coordinators</h2><span className="muted">{grid.stale ? 'No fresh data' : `${reachable} of ${grid.nodes.length} reachable`}</span></header>
    <div className="table coord-table" role="table" aria-label="Coordinators as last reported">
      <div className="trow thead" role="row"><span role="columnheader">Coordinator</span><span role="columnheader" className="num">Term</span><span role="columnheader" className="num">Applied</span><span role="columnheader" className="num">Last log</span><span role="columnheader" className="num">Reserved</span><span role="columnheader"><span className="sr">Action</span></span></div>
      {grid.nodes.map(n => {
        const d = n.data, up = n.online, staleNow = grid.stale
        const role = !up ? 'Unreachable' : d?.state === 'Leader' ? 'Leader' : d?.state === 'Candidate' ? 'Candidate' : 'Follower'
        const st = nodeStatus(role, staleNow), verb = up ? 'Stop' : 'Start', lock = !enabled ? 'Controls are switched off.' : grid.busy ? 'Another action is in progress.' : ''
        return <div className="trow" role="row" key={n.id} data-testid="relay" data-node={n.id} data-role={role} data-stale={staleNow}>
          <span role="cell" className="cell-name"><strong>{label(n.id)}</strong><Status tone={st.tone} label={st.label} /></span>
          <span role="cell" className="mono num">{up ? d?.raft?.term ?? '—' : '—'}</span>
          <span role="cell" className="mono num" data-testid="applied-index">{up ? d?.raft?.applied_index ?? '—' : '—'}</span>
          <span role="cell" className="mono num">{up ? d?.raft?.last_log_index ?? '—' : '—'}</span>
          <span role="cell" className="mono num">{up ? `${num(d?.granted_amps)} A` : '—'}</span>
          <span role="cell" className="cell-action">
            <TwoStep className="btn btn-sm" question={`${verb} ${label(n.id).toLowerCase()}?`} disabled={!!lock} reason={lock || undefined} armTestId="relay-cover" confirmTestId="relay-control" cancelTestId="relay-cancel" armProps={{ 'aria-label': `${verb} ${label(n.id)}` }} onConfirm={() => grid.act(n.id, up ? 'stop' : 'start')}>{verb}</TwoStep>
          </span>
        </div>
      })}
    </div>
  </section>
}

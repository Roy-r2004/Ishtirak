import { useEffect, useRef, useState } from 'react'
import { num, type Grid } from '../data'
import { GuardedButton, Lamp } from './controls'
import { useReducedMotion } from './use-motion'

const label = (id: string) => `Coordinator ${id.replace(/\D/g, '') || id}`
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

function Cable({ pulse, reduced }: { pulse: number; reduced: boolean }) {
  return <span className="cable" aria-hidden="true">
    <svg viewBox="0 0 60 24" preserveAspectRatio="none">
      <path d="M0 12C14 2 20 22 30 12S46 2 60 12" className="wire" />
      <path key={pulse} d="M0 12C14 2 20 22 30 12S46 2 60 12" className={`spark ${pulse && !reduced ? 'spark-run' : ''} ${pulse && reduced ? 'spark-still' : ''}`} pathLength="100" />
    </svg>
  </span>
}

export function Council({ grid, enabled, onOpenCluster }: { grid: Grid; enabled: boolean; onOpenCluster: (trigger: HTMLElement) => void }) {
  const fresh = !grid.stale && !!grid.cluster && !!grid.data, reduced = useReducedMotion(), pulse = useCommitPulse(grid, fresh)
  const reachable = grid.nodes.filter(n => n.online).length, majority = grid.quorum
  const voteText = grid.stale ? 'No fresh data' : majority ? `${reachable} of ${grid.nodes.length} reachable. Majority verified.` : `${reachable} of ${grid.nodes.length} reachable. No majority.`
  return <section className="council" aria-labelledby="council-title" data-testid="council">
    <header className="plate-head">
      <h2 id="council-title" className="plate engraved">Council</h2>
      {!majority && !grid.stale && <div className="plate plate-alarm alarm" role="alert" data-testid="majority-alarm"><strong>New grants are paused.</strong><p>Only {reachable} of {grid.nodes.length} coordinators can be reached; a majority needs 2. Existing leases stop serving at their safe deadlines. Start a stopped coordinator to resume.</p></div>}
      <div className="council-tools">
        <div className="vote" data-testid="vote-strip" data-pulse={pulse} aria-label={voteText} role="group">
          <span className="vote-lamps" aria-hidden="true">{grid.nodes.map((n, i) => <i key={`${n.id}-${pulse}`} className={`vote-lamp ${n.online && !grid.stale ? 'on' : ''} ${pulse && !reduced ? 'flash' : ''}`} style={{ animationDelay: `${i * 90}ms` }} />)}</span>
          {(majority || grid.stale) && <span className="vote-text">{voteText}</span>}
        </div>
        <button type="button" className="push push-head" onClick={e => onOpenCluster(e.currentTarget)} data-testid="cluster-open" aria-haspopup="dialog">Cluster details</button>
      </div>
    </header>
    <div className="relays">
      {grid.nodes.map((n, i) => {
        const d = n.data, up = n.online, leader = up && d?.state === 'Leader', staleNow = grid.stale
        const role = !up ? 'Unreachable' : d?.state === 'Leader' ? 'Leader' : d?.state === 'Candidate' ? 'Candidate' : 'Follower'
        const tone = !up ? 'red' : leader ? 'green' : 'amber'
        const lit = !staleNow
        const busy = grid.busy.endsWith(n.id)
        return <div className="relay-slot" key={n.id}>
          {i > 0 && <Cable pulse={pulse} reduced={reduced} />}
          <article className="relay" data-testid="relay" data-node={n.id} data-role={role} data-stale={staleNow}>
            <header className="relay-head"><h3 className="relay-name">{label(n.id)}</h3><Lamp tone={tone} lit={lit} label={staleNow ? 'Last seen' : role} /></header>
            <dl className="relay-stats">
              <div><dt>Term</dt><dd>{up ? d?.raft?.term ?? '—' : '—'}</dd></div>
              <div><dt>Applied</dt><dd data-testid="applied-index">{up ? d?.raft?.applied_index ?? '—' : '—'}</dd></div>
              <div><dt>Last log</dt><dd>{up ? d?.raft?.last_log_index ?? '—' : '—'}</dd></div>
              <div><dt>Reserved</dt><dd>{up ? `${num(d?.granted_amps)} A` : '—'}</dd></div>
            </dl>
            <GuardedButton label={`${up ? 'Stop' : 'Start'} ${label(n.id)}`} pressLabel={`${up ? 'Stop' : 'Start'} ${label(n.id)}`} caption={up ? 'Stop' : 'Start'} running={busy} disabled={!enabled || !!grid.busy} reason={!enabled ? 'Controls are switched off.' : grid.busy ? 'Another action is in progress.' : undefined} onPress={() => grid.act(n.id, up ? 'stop' : 'start')} coverTestId="relay-cover" pressTestId="relay-control" />
          </article>
        </div>
      })}
    </div>
  </section>
}

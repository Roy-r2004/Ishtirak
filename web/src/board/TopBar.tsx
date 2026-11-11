import { time, type Grid } from '../data'
import { policyLabel, type Policy } from '../lab/fairness'
import type { Lab } from './use-lab'
import { Glyph, Segmented, Status } from './controls'

const policies: Policy[] = ['fair_share', 'first_come']
const sentence = (p: Policy | null, capacity: number | undefined, stale: boolean) =>
  p === null ? 'The coordinators have not reported a policy yet.'
    : `${stale ? 'Last observed. ' : ''}${p === 'fair_share' ? `When buildings want more than ${capacity ?? 120} A, each gets an equal share.` : 'The first building to ask keeps what it holds until its lease ends.'}`

export function TopBar({ grid, lab, demo, onAbout, aboutRef }: { grid: Grid; lab: Lab; demo: boolean; onAbout: () => void; aboutRef: React.RefObject<HTMLButtonElement | null> }) {
  const leader = !grid.stale && !!grid.data?.nodes.some(n => n.online && n.data?.state === 'Leader')
  const lock = !lab.enabled ? 'Controls are switched off on this controller.' : grid.stale ? 'No fresh data. Controls wait for the next update.' : !leader ? 'Waiting for a verified leader.' : grid.policy === null ? 'The coordinators have not reported an allocation policy.' : lab.running ? 'The overload run is using the policy switch.' : grid.busy ? 'Another action is in progress.' : ''
  const feedTone = grid.stale ? 'fault' : grid.streamLive ? 'ok' : 'warn'
  return <header className="topbar">
    <div className="brand"><h1>Ishtirak</h1><span className="site">Beirut generator 01</span></div>
    <div className="policy" data-testid="policy">
      <span className="policy-label" id="policy-label">Admission policy</span>
      <Segmented label="Admission policy" value={grid.policy} options={policies.map(p => ({ value: p, label: policyLabel[p], testId: `policy-${p}`, aria: `${policyLabel[p]} admission` }))} onPick={p => { if (p !== grid.policy) void grid.setPolicy(p) }} disabled={!!lock} describedBy="policy-sentence" testId="policy-switch" />
      <p className="policy-sentence" id="policy-sentence" aria-live="polite" title={lock || sentence(grid.policy, grid.cluster?.capacity_amps, grid.stale)}>{lock || sentence(grid.policy, grid.cluster?.capacity_amps, grid.stale)}</p>
    </div>
    <div className="top-right">
      <div className="feed" data-testid="feed"><Status tone={feedTone} label={grid.stale ? 'Feed lost' : grid.streamLive ? 'Live socket' : 'Polling'} /><span className="feed-time mono">Updated {grid.lastSeen ? time(grid.lastSeen) : '—'}</span></div>
      {demo && <span className="chip" data-testid="demo-plate" role="note"><Glyph tone="warn" />Simulated data<span className="sr">. Generated in this browser. Not live observations.</span></span>}
      <button ref={aboutRef} type="button" className="btn" onClick={onAbout} data-testid="help-open" aria-haspopup="dialog">About this system</button>
    </div>
  </header>
}

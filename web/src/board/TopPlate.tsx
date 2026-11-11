import { time, type Grid } from '../data'
import { policyLabel, type Policy } from '../lab/fairness'
import type { Lab } from './use-lab'
import { Lamp, Rotary } from './controls'

const policies: Policy[] = ['fair_share', 'first_come']
const sentence = (p: Policy | null, capacity: number | undefined, stale: boolean) =>
  p === null ? 'The coordinators have not reported a policy yet.'
    : `${stale ? 'Last observed. ' : ''}${p === 'fair_share' ? `When buildings want more than ${capacity ?? 120} A, each gets an equal share.` : 'The first building to ask keeps what it holds until its lease ends.'}`

export function TopPlate({ grid, lab, demo, onHelp, helpRef }: { grid: Grid; lab: Lab; demo: boolean; onHelp: () => void; helpRef: React.RefObject<HTMLButtonElement | null> }) {
  const leader = !grid.stale && !!grid.data?.nodes.some(n => n.online && n.data?.state === 'Leader')
  const lock = !lab.enabled ? 'Controls are switched off on this controller.' : grid.stale ? 'No fresh data. Controls wait for the next update.' : !leader ? 'Waiting for a verified leader.' : grid.policy === null ? 'The coordinators have not reported an allocation policy.' : lab.running ? 'The overload run is using the policy switch.' : grid.busy ? 'Another action is in progress.' : ''
  return <header className="top">
    <div className="nameplate"><h1>Ishtirak</h1><p>Beirut generator 01</p></div>
    <div className="policy" data-testid="policy">
      <span className="policy-label" id="policy-label">Allocation</span>
      <Rotary label="Allocation policy" layout="sides" value={grid.policy} options={policies.map(p => ({ value: p, label: policyLabel[p], testId: `policy-${p}`, aria: `${policyLabel[p]} allocation` }))} onPick={p => { if (p !== grid.policy) void grid.setPolicy(p) }} disabled={!!lock} describedBy="policy-sentence" testId="policy-switch" />
      <p className="policy-sentence" id="policy-sentence" aria-live="polite">{lock || sentence(grid.policy, grid.cluster?.capacity_amps, grid.stale)}</p>
    </div>
    <div className="top-right">
      {demo && <div className="plate plate-notice demo-plate" data-testid="demo-plate" role="note"><strong>Simulated data</strong><span>Generated in this browser. Not live observations.</span></div>}
      <div className="feed" data-testid="feed"><Lamp tone={grid.streamLive ? 'green' : 'amber'} lit label={grid.stale ? 'Feed lost' : grid.streamLive ? 'Live socket' : 'Polling'} /><span className="feed-time">Updated {grid.lastSeen ? time(grid.lastSeen) : '—'}</span></div>
      <button ref={helpRef} type="button" className="push push-help" onClick={onHelp} data-testid="help-open">Commissioning notes</button>
    </div>
  </header>
}

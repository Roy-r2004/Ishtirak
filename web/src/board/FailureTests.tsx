import { time, num, type Grid } from '../data'
import { policyLabel, percent, type Policy } from '../lab/fairness'
import { OVERLOAD, scenarios, type RunState, type Scenario, type TimelineEvent } from '../lab/scenarios'
import type { Lab } from './use-lab'
import { Segmented, TwoStep } from './controls'

const kindLabel: Record<TimelineEvent['kind'], string> = { leader_elected: 'Leader observed', leader_lost: 'Leader lost', node_down: 'Unreachable', node_up: 'Reachable', quorum_lost: 'Majority lost', quorum_restored: 'Majority restored' }
const outcome: Record<RunState['status'], string> = { running: 'Running', restoring: 'Restoring services', done: 'Completed', timeout: 'Timed out', cancelled: 'Cancelled' }
const effect: Record<string, string> = {
  'leader-failover': 'It stops the current leader and restores it afterwards.',
  'majority-loss': 'It stops two of the three coordinators and restores them afterwards.',
  'gateway-crash': 'It stops the Hamra gateway and restores it afterwards.',
  'database-outage': 'It stops PostgreSQL and restores it afterwards.',
  overload: `It sets the meters to ${OVERLOAD.peak.meter_count} for ${OVERLOAD.peakMs / 1000} s and restores the starting setup afterwards.`,
}
/** One line per scenario for the list; the full description is in About this system. */
const summary: Record<string, string> = {
  'leader-failover': 'The remaining majority elects a replacement and keeps granting.',
  'majority-loss': 'Without a majority no new grants can commit.',
  'gateway-crash': 'Its lease is not renewed and service stops at the safe deadline.',
  'database-outage': 'Grants continue through Raft; audit writes catch up afterwards.',
}
const seconds = (ms: number) => `${Math.max(0, Math.round(ms / 1000))} s`
const policies: Policy[] = ['fair_share', 'first_come']

/** One small square per step of the scenario: filled when the step was observed done, outlined with a mark for the one in progress. */
function Steps({ scenario, run }: { scenario: Scenario; run: RunState | null }) {
  return <ol className="steps" aria-label={`${scenario.steps.length} steps`}>
    {scenario.steps.map((st, i) => {
      const state = !run ? '' : i < run.step || run.status === 'done' ? 'done' : i === run.step && run.status === 'running' ? 'now' : ''
      return <li key={i} className="step" data-state={state} title={st.label}><span className="sr">Step {i + 1}: {st.label}{state === 'done' ? ', observed' : state === 'now' ? ', in progress' : ''}</span></li>
    })}
  </ol>
}

export function FailureTests({ grid, lab }: { grid: Grid; lab: Lab }) {
  const { run, current, step, running, pending, settings, dwell, enabled, fresh } = lab
  const leader = !grid.stale && !!grid.data?.nodes.some(n => n.online && n.data?.state === 'Leader'), metersKnown = !!grid.data?.meters.online && !!grid.data.meters.data
  const lock = !enabled ? 'Controls are switched off on this controller.' : !fresh ? 'Needs fresh observations.' : running ? 'A scenario is running.' : grid.busy ? 'Another action is in progress.' : ''
  const startLock = !enabled ? 'Controls are switched off on this controller.' : !fresh ? 'Needs fresh observations.' : !leader ? 'Waiting for a verified leader.' : grid.policy === null ? 'The coordinators have not reported an allocation policy.' : !metersKnown ? 'The meter simulator is not reporting.' : running ? 'A scenario is running.' : grid.busy ? 'Another action is in progress.' : ''
  const mine = run?.id === 'overload', live = mine && run?.status === 'running'
  const statusBody = run && current ? <>
    <div className="status-text">
      <strong>{current.title}: {pending && run.status !== 'running' && run.status !== 'restoring' ? `${outcome[run.status]}, restoring ${settings ? 'what this run changed' : 'services'}` : outcome[run.status]}</strong>
      <p>{run.status === 'running' && step ? `Step ${run.step + 1} of ${current.steps.length}: ${step.label}. ${seconds(grid.now - run.stepStartedAt)} of ${seconds(step.timeoutMs)} allowed.${dwell ? ` Observing: ${seconds(dwell.elapsedMs)} of ${seconds(dwell.totalMs)}.` : ''}` : pending ? `Waiting to observe ${[...run.stopped.length ? [`${run.stopped.join(', ')} running again`] : [], ...run.touched?.meters ? ['the starting meter setup restored'] : [], ...run.touched?.policy ? ['the starting allocation policy restored'] : []].join(' and ')}. ${settings ? 'Restoration' : 'Restart'} is retried until a fresh observation confirms it.` : run.status === 'done' ? (settings ? 'Complete. The starting meter setup and policy were observed restored.' : 'Complete. Every stopped service was observed running again.') : (settings ? 'Run ended. Everything this run changed was observed restored.' : 'Run ended. Every stopped service was observed running again.')}</p>
    </div>
    <div className="status-act">
      {run.status === 'running' ? <button type="button" className="btn" onClick={lab.cancel}>Cancel and restore</button> : !pending && <button type="button" className="btn" onClick={lab.dismiss}>Dismiss</button>}
      <details className="run-log"><summary>Run log ({run.log.length})</summary><ol>{run.log.map((l, i) => <li key={i}>{l}</li>)}</ol></details>
    </div>
  </> : <div className="status-text"><strong>{!enabled ? 'Tests are switched off' : !fresh ? 'Tests are waiting for fresh data' : 'No test is running'}</strong><p>{!enabled ? 'The dashboard controller is not enabled, so tests cannot run.' : !fresh ? 'Tests run only on fresh observations. Stale data is never proof.' : 'Each test restores what it changes and confirms the restoration from observations.'}</p></div>
  return <div className="tests">
    <section className="tests-col" aria-label="Failure scenarios">
      <h3 className="col-title">Scenarios</h3>
      <div className="scenario-list" role="group" aria-label="Failure scenarios">
        {scenarios.map(s => {
          const isMine = run?.id === s.id, liveHere = isMine && running
          return <div className="scenario" key={s.id} data-testid="scenario" data-scenario={s.id} data-state={isMine ? run?.status : 'idle'}>
            <div className="scenario-main"><strong>{s.title}</strong><span className="muted clamp" title={s.blurb}>{summary[s.id] ?? s.blurb}</span></div>
            <Steps scenario={s} run={isMine ? run : null} />
            <TwoStep className="btn" question={`Run ${s.title.toLowerCase()}? ${effect[s.id] ?? ''}`} disabled={!!lock} reason={lock || undefined} armTestId="scenario-cover" confirmTestId="scenario-run" cancelTestId="scenario-cancel" armProps={{ 'aria-label': `Run ${s.title}` }} onConfirm={() => lab.start(s)}>{liveHere ? 'Running' : 'Run'}</TwoStep>
          </div>
        })}
      </div>
    </section>
    <section className="tests-col" aria-label="Overload" data-testid="overload" data-state={mine ? run?.status : 'idle'}>
      <h3 className="col-title">Overload</h3>
      <p className="muted">Settle at {OVERLOAD.calm.meter_count} meters, then raise the load to {OVERLOAD.peak.meter_count} under the chosen allocation policy and observe how the generator is shared.</p>
      <div className="overload-act">
        <Segmented label="Allocation policy for the overload run" value={lab.runPolicy} options={policies.map(p => ({ value: p, label: policyLabel[p], aria: `Overload with ${policyLabel[p].toLowerCase()}`, testId: `overload-policy-${p}` }))} onPick={lab.setRunPolicy} disabled={running} testId="overload-policy" />
        <TwoStep className="btn" question={`Run overload with ${policyLabel[lab.runPolicy].toLowerCase()}? ${effect.overload}`} disabled={!!startLock} reason={startLock || undefined} armTestId="overload-cover" confirmTestId="overload-run" cancelTestId="overload-cancel" armProps={{ 'aria-label': 'Run overload' }} promptClass="prompt-block" onConfirm={() => lab.start(lab.overload, { policy: lab.runPolicy })}>{live ? 'Running' : 'Run'}</TwoStep>
      </div>
      {live && <button type="button" className="btn" onClick={lab.cancel}>Stop overload and restore</button>}
      {dwell && <div className="progress" role="progressbar" aria-label="Observation window" aria-valuemin={0} aria-valuemax={Math.round(dwell.totalMs / 1000)} aria-valuenow={Math.round(dwell.elapsedMs / 1000)} aria-valuetext={`${Math.round(dwell.elapsedMs / 1000)} s of ${Math.round(dwell.totalMs / 1000)} s observed`}><i style={{ width: `${dwell.elapsedMs / dwell.totalMs * 100}%` }} /></div>}
      <dl className="results" data-testid="overload-results" aria-label="Last overload results in this session">
        {policies.map(p => { const r = lab.results[p]; return <div key={p}><dt>{policyLabel[p]}</dt><dd className="mono">{r ? `${percent(r.fairness)} fair, ${num(r.reserved)} of ${num(r.capacity)} A, ${num(r.wanted)} A wanted` : 'not run yet'}</dd></div> })}
      </dl>
    </section>
    <section className="tests-col" aria-label="Run status and observed events">
      <h3 className="col-title">Status</h3>
      <div className="status-window" role="status" aria-live="polite" aria-label="Scenario status" data-testid="scenario-status" data-state={run?.status ?? 'idle'}>{statusBody}</div>
      <h3 className="col-title">Observed events</h3>
      <div className="timeline" role="region" aria-label="Observed events" tabIndex={0}>
        {lab.timeline.length ? <ol>{lab.timeline.map((e, i) => <li key={`${e.at}-${i}`} data-testid="timeline-item" data-kind={e.kind}><time className="mono">{time(e.at)}</time><b>{kindLabel[e.kind]}</b><span>{e.detail}</span></li>)}</ol> : <p className="muted">No changes observed yet. Leader elections and outages are listed here when a fresh observation differs from the last.</p>}
      </div>
    </section>
  </div>
}

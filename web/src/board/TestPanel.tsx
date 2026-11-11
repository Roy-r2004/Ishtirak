import { useEffect, useId, useRef, useState } from 'react'
import { num, time, type Grid } from '../data'
import { policyLabel, percent, type Policy } from '../lab/fairness'
import { OVERLOAD, scenarios, type RunState, type Scenario, type TimelineEvent } from '../lab/scenarios'
import type { Lab } from './use-lab'
import { Fader, GuardedButton, Lamp, Lever, Rotary } from './controls'

const kindLabel: Record<TimelineEvent['kind'], string> = { leader_elected: 'Leader observed', leader_lost: 'Leader lost', node_down: 'Unreachable', node_up: 'Reachable', quorum_lost: 'Majority lost', quorum_restored: 'Majority restored' }
const outcome: Record<RunState['status'], string> = { running: 'Running', restoring: 'Restoring services', done: 'Completed', timeout: 'Timed out', cancelled: 'Cancelled' }
const seconds = (ms: number) => `${Math.max(0, Math.round(ms / 1000))} s`
const policies: Policy[] = ['fair_share', 'first_come']

/** One small lamp per step of the scenario: lit green when observed done, amber for the step in progress. */
function StepLamps({ scenario, run }: { scenario: Scenario; run: RunState | null }) {
  return <ol className="steps" aria-label={`${scenario.steps.length} steps`}>
    {scenario.steps.map((st, i) => {
      const state = !run ? '' : i < run.step || run.status === 'done' ? 'done' : i === run.step && run.status === 'running' ? 'now' : ''
      return <li key={i} className="step" data-state={state} title={st.label}><span className="sr">Step {i + 1}: {st.label}{state === 'done' ? ', observed' : state === 'now' ? ', in progress' : ''}</span></li>
    })}
  </ol>
}

export function TestPanel({ grid, lab }: { grid: Grid; lab: Lab }) {
  const uid = useId().replace(/:/g, ''), { run, current, step, running, pending, settings, dwell, enabled, fresh } = lab
  const [count, setCount] = useState(50), [factor, setFactor] = useState(1), initialized = useRef(false)
  useEffect(() => { if (grid.data?.meters.data && !initialized.current) { setCount(grid.data.meters.data.meter_count); setFactor(grid.data.meters.data.demand_factor); initialized.current = true } }, [grid.data])
  const leader = !grid.stale && !!grid.data?.nodes.some(n => n.online && n.data?.state === 'Leader'), metersKnown = !!grid.data?.meters.online && !!grid.data.meters.data
  const lock = !enabled ? 'Controls are switched off on this controller.' : !fresh ? 'Needs fresh observations.' : running ? 'A scenario is running.' : grid.busy ? 'Another action is in progress.' : ''
  const startLock = !enabled ? 'Controls are switched off on this controller.' : !fresh ? 'Needs fresh observations.' : !leader ? 'Waiting for a verified leader.' : grid.policy === null ? 'The coordinators have not reported an allocation policy.' : !metersKnown ? 'The meter simulator is not reporting.' : running ? 'A scenario is running.' : grid.busy ? 'Another action is in progress.' : ''
  const mine = run?.id === 'overload', live = mine && run?.status === 'running'
  const simBusy = !enabled || !!grid.busy
  const meters = grid.data?.meters.data, dbOn = !!grid.cluster?.postgres_connected, brokerOn = !!meters?.mqtt_connected
  const statusId = `${uid}-status`
  const statusBody = run && current ? <>
    <div className="status-text">
      <strong>{current.title}: {pending && run.status !== 'running' && run.status !== 'restoring' ? `${outcome[run.status]}, restoring ${settings ? 'what this run changed' : 'services'}` : outcome[run.status]}</strong>
      <p>{run.status === 'running' && step ? `Step ${run.step + 1} of ${current.steps.length}: ${step.label}. ${seconds(grid.now - run.stepStartedAt)} of ${seconds(step.timeoutMs)} allowed.${dwell ? ` Observing: ${seconds(dwell.elapsedMs)} of ${seconds(dwell.totalMs)}.` : ''}` : pending ? `Waiting to observe ${[...run.stopped.length ? [`${run.stopped.join(', ')} running again`] : [], ...run.touched?.meters ? ['the starting meter setup restored'] : [], ...run.touched?.policy ? ['the starting allocation policy restored'] : []].join(' and ')}. ${settings ? 'Restoration' : 'Restart'} is retried until a fresh observation confirms it.` : run.status === 'done' ? (settings ? 'Complete. The starting meter setup and policy were observed restored.' : 'Complete. Every stopped service was observed running again.') : (settings ? 'Run ended. Everything this run changed was observed restored.' : 'Run ended. Every stopped service was observed running again.')}</p>
    </div>
    <div className="status-act">
      {run.status === 'running' ? <button type="button" className="push" onClick={lab.cancel}>Cancel and restore</button> : !pending && <button type="button" className="push" onClick={lab.dismiss}>Dismiss</button>}
      <details className="run-log"><summary>Run log ({run.log.length})</summary><ol>{run.log.map((l, i) => <li key={i}>{l}</li>)}</ol></details>
    </div>
  </> : <div className="status-text"><strong>{!enabled ? 'Tests are switched off' : !fresh ? 'Tests are waiting for fresh data' : 'No test is running'}</strong><p>{!enabled ? 'The dashboard controller is not enabled, so tests cannot run.' : !fresh ? 'Tests run only on fresh observations. Stale data is never proof.' : 'Lift a cover and press to start one. Every test restores what it changes.'}</p></div>
  return <section className="test" aria-labelledby={`${uid}-t`} data-testid="test-panel">
    <header className="test-head">
      <h2 id={`${uid}-t`} className="plate engraved">Test panel</h2>
      <div className="status-window" id={statusId} role="status" aria-live="polite" aria-label="Scenario status" data-testid="scenario-status" data-state={run?.status ?? 'idle'}>{statusBody}</div>
      <span className="test-lamps"><Lamp tone="green" lit={enabled} label={enabled ? 'Controls on' : 'Controls off'} /><Lamp tone="amber" lit={!fresh} label={fresh ? 'Fresh data' : 'No fresh data'} /></span>
    </header>
    <div className="test-body">
      <div className="tp-scenarios" role="group" aria-label="Failure scenarios">
          {scenarios.map(s => {
            const isMine = run?.id === s.id, liveHere = isMine && running
            return <div className="scenario" key={s.id} data-testid="scenario" data-scenario={s.id} data-state={isMine ? run?.status : 'idle'}>
              <h3 className="scenario-name">{s.title}</h3>
              <StepLamps scenario={s} run={isMine ? run : null} />
              <GuardedButton label={s.title} caption="Run" running={liveHere} disabled={!!lock} reason={lock || undefined} onPress={() => lab.start(s)} coverTestId="scenario-cover" pressTestId="scenario-run" describedBy={`${uid}-${s.id}`} />
              <p className="sr" id={`${uid}-${s.id}`}>{s.blurb}</p>
            </div>
          })}
      </div>
      <div className="timeline" role="region" aria-label="Event recorder" tabIndex={0}>
          <h3 className="scenario-name">Event recorder</h3>
          {lab.timeline.length ? <ol>{lab.timeline.map((e, i) => <li key={`${e.at}-${i}`} data-testid="timeline-item" data-kind={e.kind}><time className="num">{time(e.at)}</time><b>{kindLabel[e.kind]}</b><span>{e.detail}</span></li>)}</ol> : <p className="tp-line">No changes seen yet. Leader elections and outages appear here when a fresh observation differs from the last.</p>}
      </div>
      <div className="overload" data-testid="overload" data-state={mine ? run?.status : 'idle'}>
        <div className="mod-head"><h3 className="scenario-name" title={`${OVERLOAD.calm.meter_count} meters, then ${OVERLOAD.peak.meter_count}`}>Overload</h3><StepLamps scenario={lab.overload} run={mine ? run : null} /></div>
        <div className="overload-act">
          <Rotary label="Run overload with" layout="sides" value={lab.runPolicy} options={policies.map(p => ({ value: p, label: policyLabel[p], aria: `Overload with ${policyLabel[p].toLowerCase()}`, testId: `overload-policy-${p}` }))} onPick={lab.setRunPolicy} disabled={running} testId="overload-policy" />
          <GuardedButton label="Overload" pressLabel="Start overload" caption="Start" running={live} disabled={!!startLock} reason={startLock || undefined} onPress={() => lab.start(lab.overload, { policy: lab.runPolicy })} coverTestId="overload-cover" pressTestId="overload-run" />
        </div>
        {live && <button type="button" className="push" onClick={lab.cancel}>Stop overload and restore</button>}
        {dwell && <div className="meter-bar" role="progressbar" aria-label="Observation window" aria-valuemin={0} aria-valuemax={Math.round(dwell.totalMs / 1000)} aria-valuenow={Math.round(dwell.elapsedMs / 1000)} aria-valuetext={`${Math.round(dwell.elapsedMs / 1000)} s of ${Math.round(dwell.totalMs / 1000)} s observed`}><i style={{ width: `${dwell.elapsedMs / dwell.totalMs * 100}%` }} /></div>}
        <dl className="results" data-testid="overload-results" aria-label="Last overload results in this session">
          {policies.map(p => { const r = lab.results[p]; return <div key={p}><dt>{policyLabel[p]}</dt><dd>{r ? `${percent(r.fairness)} fair, ${num(r.reserved)} of ${num(r.capacity)} A, ${num(r.wanted)} A wanted` : 'not run yet'}</dd></div> })}
        </dl>
      </div>
      <div className="sim" data-testid="sim">
        <div className="mod-head"><h3 className="scenario-name">Meters</h3><span className="sim-reads"><b data-testid="active-meters">{num(meters?.meter_count)}</b> active, {num(meters?.published_readings)} readings</span></div>
        <Rotary label="Household meters" layout="arc" value={count} options={[10, 50, 200].map(n => ({ value: n, label: String(n), aria: `${n} meters`, testId: `meters-${n}` }))} onPick={setCount} disabled={simBusy} testId="meters-rotary" />
        <div className="sim-set">
          <Fader id={`${uid}-f`} label="Demand multiplier" min={0} max={3} step={0.1} value={factor} onChange={setFactor} disabled={simBusy} readout={`${factor.toFixed(1)}×`} marks={['0×', '1×', '2×', '3×']} />
          <button type="button" className="push push-apply" disabled={simBusy} aria-label="Apply simulation" data-testid="sim-apply" onClick={() => void grid.post('/api/meters/config', { meter_count: count, demand_factor: factor }, 'simulation')}>{grid.busy === 'simulation' ? 'Applying' : 'Apply'}</button>
        </div>
        <div className="breakers">
          <Lever on={dbOn} busy={grid.busy.endsWith('postgres')} label="Database breaker" caption={`Database ${dbOn ? 'on' : 'off'}`} testId="breaker-database" disabled={simBusy} onToggle={() => grid.act('postgres', dbOn ? 'stop' : 'start')} />
          <Lever on={brokerOn} busy={grid.busy.endsWith('mosquitto')} label="Broker breaker" caption={`Broker ${brokerOn ? 'on' : 'off'}`} testId="breaker-broker" disabled={simBusy} onToggle={() => grid.act('mosquitto', brokerOn ? 'stop' : 'start')} />
        </div>
      </div>
    </div>
  </section>
}

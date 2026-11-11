import { useEffect, useMemo, useRef, useState } from 'react'
import type { Grid } from '../data'
import { advance, begin, cancelRun, catalogue, commandKey, commandRequest, deriveTimeline, dwellProgress, hasPending, isService, isStress, overload, proof, restoreCommands, type Command, type Observation, type RunState, type Scenario, type TimelineEvent } from '../lab/scenarios'
import type { Policy } from '../lab/fairness'
import type { Capture } from '../lab/scenarios'
import { emptyPeak, trackPeak, type PeakState } from './peak'

export type OverloadResults = Partial<Record<Policy, Capture>>
const RETRY_MS = 5000

/** What the dashboard can claim right now. Stale or missing data is never fresh. */
export function observe(grid: Grid): Observation {
  const c = grid.cluster
  return { at: Date.now(), leader: grid.data?.nodes.find(n => n.online && n.data?.state === 'Leader')?.id ?? null, nodesUp: grid.nodes.filter(n => n.online).map(n => n.id), buildingsUp: grid.buildings.filter(b => b.online).map(b => b.id), granted: c?.granted_amps ?? 0, capacity: c?.capacity_amps ?? 0, quorum: grid.quorum, stale: grid.stale || !c || !grid.data, postgresUp: c ? c.postgres_connected : undefined, policy: grid.policy, meters: grid.data?.meters.online && grid.data.meters.data ? { meter_count: grid.data.meters.data.meter_count, demand_factor: grid.data.meters.data.demand_factor } : null, wants: c?.wants, reserved: c?.leases }
}
export const isActive = (r: RunState | null) => !!r && (r.status === 'running' || r.status === 'restoring' || hasPending(r))

/**
 * The observation recorder, the peak tracker and the scenario state machine, mounted once for the whole board. The scenario logic is
 * the pure step machine in ../lab/scenarios; this hook only feeds it observations and sends the commands it emits, one at a time,
 * and always restores what a run changed (on finish, timeout, cancel, unmount and page close).
 */
export function useLab(grid: Grid) {
  const [history, setHistory] = useState<Observation[]>([]), [timeline, setTimeline] = useState<TimelineEvent[]>([]), [run, setRunState] = useState<RunState | null>(null)
  const [runPolicy, setRunPolicy] = useState<Policy>('fair_share'), [results, setResults] = useState<OverloadResults>({}), [peak, setPeak] = useState<PeakState>(emptyPeak)
  const runRef = useRef<RunState | null>(null), obsRef = useRef<Observation | null>(null), baseline = useRef<Observation | null>(null), queue = useRef<Command[]>([]), sentAt = useRef<Record<string, number>>({})
  const setRun = (next: RunState | null) => { runRef.current = next; setRunState(next) }
  const enqueue = (commands: Command[]) => { for (const c of commands) if (!queue.current.some(q => commandKey(q) === commandKey(c))) queue.current.push(c) }
  function send(cmd: Command) {
    if (isService(cmd)) return grid.act(cmd.service, cmd.action)
    if (cmd.kind === 'policy') return void grid.setPolicy(cmd.policy)
    const { path, body } = commandRequest(cmd); void grid.post(path, body, 'meters-config', `Meters set to ${cmd.meter_count} at ${cmd.demand_factor.toFixed(1)}× demand.`)
  }
  const enabled = !!grid.data?.demo_enabled, running = isActive(run)
  // Record one observation whenever new grid data arrives or freshness changes.
  useEffect(() => {
    const o = observe(grid); obsRef.current = o
    setHistory(prev => [...prev, o].slice(-600))
    setPeak(prev => trackPeak(prev, { at: o.at, fresh: !o.stale, granted: o.granted, capacity: o.capacity }))
    const events = deriveTimeline(baseline.current, o)
    if (events.length) setTimeline(prev => [...events.reverse(), ...prev].slice(0, 40))
    if (!o.stale) baseline.current = o
  }, [grid.data, grid.cluster, grid.stale, grid.quorum])
  // Drive the scenario state machine on every dashboard tick (timeouts must advance without new data).
  useEffect(() => {
    const r = runRef.current, o = obsRef.current
    if (!r || !o || !isActive(r)) return
    const x = advance(r, o, Date.now())
    if (x.run !== r) setRun(x.run)
    enqueue(x.commands)
  }, [grid.now])
  // Send queued commands one at a time through the label-checked controller.
  useEffect(() => {
    if (!queue.current.length || grid.busy || !enabled) return
    const cmd = queue.current.shift()!
    if (isStress(cmd, runRef.current) && runRef.current?.status !== 'running') return
    const key = commandKey(cmd), t = Date.now()
    if (t - (sentAt.current[key] ?? 0) < RETRY_MS) return
    sentAt.current[key] = t; send(cmd)
  }, [grid.now, grid.busy, enabled])
  // Always restore on unmount or page close, bypassing the shared action lock.
  useEffect(() => {
    const restoreNow = () => { const r = runRef.current; if (!r) return; for (const c of restoreCommands(r)) { const { path, body } = commandRequest(c); void fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(() => {}) } }
    window.addEventListener('pagehide', restoreNow)
    return () => { window.removeEventListener('pagehide', restoreNow); restoreNow() }
  }, [])
  // Keep the last completed overload window per observed policy so both outcomes can be compared.
  useEffect(() => { const cap = run?.id === 'overload' ? run.captured : undefined; if (cap?.final && cap.policy) { const p = cap.policy; setResults(prev => prev[p]?.at === cap.at ? prev : { ...prev, [p]: cap }) } }, [run])
  const stats = useMemo(() => proof(history), [history])
  const fresh = !grid.stale && !!grid.cluster && !!grid.data
  function start(s: Scenario, params?: { policy: Policy }) {
    const current = obsRef.current
    if (!current || current.stale || !enabled || isActive(runRef.current)) return
    queue.current = []
    const x = begin(s, current, Date.now(), params); setRun(x.run); enqueue(x.commands)
  }
  function cancel() { const r = runRef.current; if (r && r.status === 'running') { queue.current = queue.current.filter(c => !isStress(c, r)); setRun(cancelRun(r, Date.now())) } }
  const current = run ? catalogue.find(s => s.id === run.id) : undefined
  const step = run && current ? current.steps[Math.min(run.step, current.steps.length - 1)] : undefined
  return { history, timeline, run, runPolicy, setRunPolicy, results, stats, peak, enabled, running, fresh, start, cancel, dismiss: () => setRun(null), current, step, pending: !!run && hasPending(run), settings: !!run?.snapshot, dwell: run ? dwellProgress(run, grid.now) : null, overload }
}
export type Lab = ReturnType<typeof useLab>

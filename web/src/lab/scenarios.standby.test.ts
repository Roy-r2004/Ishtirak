import { describe, expect, it } from 'vitest'
import type { GatewayState } from '../data'
import { advance, begin, cancelRun, deriveTimeline, forBackend, isUp, nextCommand, proof, scenarioOf, scenarios, type Observation, type RunState } from './scenarios'

const all = ['coordinator1', 'coordinator2', 'coordinator3'], gws = ['hamra', 'mar_mikhael', 'achrafieh']
const obs = (o: Partial<Observation> = {}): Observation => ({ at: 1000, leader: 'coordinator2', nodesUp: [...all], buildingsUp: [...gws], granted: 90, capacity: 120, quorum: true, stale: false, postgresUp: true, ...o })
const scenario = (id: string) => scenarios.find(s => s.id === id)!
const pair = (primary: GatewayState, standby: GatewayState) => ({ primary, standby })
const healthy = { hamra: pair('serving', 'standby'), mar_mikhael: pair('serving', 'standby'), achrafieh: pair('serving', 'standby') }
const withHamra = (h: { primary: GatewayState; standby: GatewayState }, extra: Partial<Observation> = {}) => obs({ pairs: { ...healthy, hamra: h }, ...extra })
const gap = (o: Partial<Observation> = {}) => obs({ buildingsUp: ['mar_mikhael', 'achrafieh'], pairs: { ...healthy, hamra: pair('stopped', 'standby') }, ...o })
const takenOver = (o: Partial<Observation> = {}) => obs({ buildingsUp: ['mar_mikhael', 'achrafieh'], pairs: { ...healthy, hamra: pair('stopped', 'serving') }, ...o })
const returned = (o: Partial<Observation> = {}) => obs({ pairs: { ...healthy, hamra: pair('standby', 'serving') }, ...o })
const gc = scenario('gateway-crash')

describe('gateway crash with standby gateways', () => {
  it('keeps the id and the four-scenario list, with the new wording and a legacy form', () => {
    expect(scenarios).toHaveLength(4)
    expect(gc.blurb).toBe('Stop the Hamra gateway. Its standby takes over once the lease lapses, about 12 to 15 seconds.')
    expect(gc.legacy?.blurb).toContain('Its lease is not renewed')
    expect(forBackend(gc, true).blurb).toBe(gc.legacy!.blurb); expect(forBackend(gc, false)).toBe(gc)
    expect(forBackend(scenario('leader-failover'), true)).toBe(scenario('leader-failover'))
    for (const step of gc.steps) expect(step.timeoutMs).toBeLessThanOrEqual(45000)
  })
  it('uses the legacy steps when the backend reports no pairs, and the standby steps when it does', () => {
    const old = begin(gc, obs(), 1000)
    expect(old.run.legacy).toBe(true); expect(scenarioOf(old.run).steps).toBe(gc.legacy!.steps)
    const fresh = begin(gc, withHamra(healthy.hamra), 1000)
    expect(fresh.run.legacy).toBeUndefined(); expect(scenarioOf(fresh.run).steps).toBe(gc.steps)
  })
  it('on an older stack it still stops the Hamra gateway, waits for the lease to lapse and restarts it', () => {
    let r = begin(gc, obs(), 1000).run
    const a = advance(r, obs(), 2000); r = a.run
    expect(a.commands).toEqual([{ service: 'gateway-hamra', action: 'stop' }])
    const b = advance(r, obs({ buildingsUp: ['mar_mikhael', 'achrafieh'] }), 3000)
    expect(b.commands).toEqual([{ service: 'gateway-hamra', action: 'start' }])
    expect(advance(b.run, obs(), 4000).run.status).toBe('done')
  })
  it('waits for one serving and one ready standby, and for every gateway to answer, before it stops anything', () => {
    for (const h of [pair('serving', 'waiting'), pair('serving', 'stopped'), pair('waiting', 'waiting'), pair('serving', 'serving'), pair('serving', 'unknown')]) {
      const { run } = begin(gc, withHamra(h), 1000)
      const x = advance(run, withHamra(h, { at: 2000 }), 2000)
      expect(x.run.step).toBe(0); expect(x.commands).toEqual([])
    }
    const { run } = begin(gc, withHamra(healthy.hamra), 1000)
    expect(advance(run, obs({ pairs: { ...healthy, achrafieh: pair('serving', 'stopped') }, at: 2000 }), 2000).run.step).toBe(0)
  })
  it('stops the serving Hamra gateway, waits for the standby to serve, restarts it and finishes when it returned as standby', () => {
    let r = begin(gc, withHamra(healthy.hamra), 1000).run, now = 1000
    const step = (o: Observation) => { now += 1000; const x = advance(r, o, now); r = x.run; return x.commands }
    expect(step(withHamra(healthy.hamra))).toEqual([{ service: 'gateway-hamra', action: 'stop' }])
    expect(r.step).toBe(1); expect(r.stopped).toEqual(['gateway-hamra']); expect(r.target).toBe('gateway-hamra')
    expect(step(withHamra(healthy.hamra))).toEqual([]); expect(r.step).toBe(1) // still serving: not stopped yet
    expect(step(gap())).toEqual([]); expect(r.step).toBe(2) // stopped, nobody serves
    expect(step(gap())).toEqual([]); expect(r.step).toBe(2) // the gap is no proof of a takeover
    expect(step(takenOver())).toEqual([{ service: 'gateway-hamra', action: 'start' }])
    expect(r.step).toBe(3); expect(r.stopped).toEqual([]); expect(r.target).toBe('gateway-hamra')
    expect(step(takenOver())).toEqual([]); expect(r.status).toBe('running') // restarted but not yet back
    expect(step(returned({ pairs: { ...healthy, hamra: pair('waiting', 'serving') } }))).toEqual([]); expect(r.status).toBe('running') // waiting is not standby yet
    expect(step(returned())).toEqual([]); expect(r.status).toBe('done')
  })
  it('after an earlier run left the standby serving, it stops the standby gateway, so a takeover is still observed', () => {
    let r = begin(gc, returned(), 1000).run, now = 1000
    const step = (o: Observation) => { now += 1000; const x = advance(r, o, now); r = x.run; return x.commands }
    expect(step(returned())).toEqual([{ service: 'gateway-hamra-standby', action: 'stop' }])
    expect(r.target).toBe('gateway-hamra-standby')
    const primaryServing = obs({ pairs: { ...healthy, hamra: pair('serving', 'stopped') } })
    expect(step(primaryServing)).toEqual([]); expect(r.step).toBe(2)
    expect(step(primaryServing)).toEqual([{ service: 'gateway-hamra-standby', action: 'start' }])
    expect(step(obs({ pairs: { ...healthy, hamra: pair('serving', 'standby') } }))).toEqual([]); expect(r.status).toBe('done')
  })
  it('the restarted gateway must report standby: the primary serving again is not "returned as standby"', () => {
    let r = begin(gc, withHamra(healthy.hamra), 1000).run
    r = advance(r, withHamra(healthy.hamra), 2000).run
    r = advance(r, gap(), 3000).run
    r = advance(r, takenOver(), 4000).run
    expect(r.step).toBe(3)
    expect(advance(r, obs({ pairs: { ...healthy, hamra: pair('serving', 'standby') } }), 5000).run.status).toBe('running')
  })
  it('never counts a stale observation as proof of a takeover', () => {
    let r = begin(gc, withHamra(healthy.hamra), 1000).run
    r = advance(r, withHamra(healthy.hamra), 2000).run
    r = advance(r, gap(), 3000).run
    expect(r.step).toBe(2)
    expect(advance(r, takenOver({ stale: true, at: 4000 }), 4000).run.step).toBe(2)
  })
  it('times out in 45 s or less waiting for the takeover, restores the stopped gateway and retries until observed', () => {
    let r = begin(gc, withHamra(healthy.hamra), 1000).run
    r = advance(r, withHamra(healthy.hamra), 2000).run
    r = advance(r, gap(), 3000).run
    const limit = gc.steps[2].timeoutMs
    expect(limit).toBeLessThanOrEqual(45000)
    const t = advance(r, gap({ at: 3000 + limit + 1 }), 3000 + limit + 1)
    expect(t.run.status).toBe('timeout'); expect(t.commands).toEqual([{ service: 'gateway-hamra', action: 'start' }])
    const again = advance(t.run, gap({ at: t.run.stepStartedAt + 5000 }), t.run.stepStartedAt + 5000)
    expect(again.commands).toEqual([{ service: 'gateway-hamra', action: 'start' }])
    const back = advance(again.run, returned({ at: t.run.stepStartedAt + 9000 }), t.run.stepStartedAt + 9000)
    expect(back.run.stopped).toEqual([]); expect(back.commands).toEqual([])
  })
  it('cancel restores the stopped standby gateway and confirms it from the pair, not from the primaries list', () => {
    let r = begin(gc, returned(), 1000).run
    r = advance(r, returned(), 2000).run
    expect(r.stopped).toEqual(['gateway-hamra-standby'])
    const c = advance(cancelRun(r, 3000), obs({ pairs: { ...healthy, hamra: pair('serving', 'stopped') } }), 6000)
    expect(c.run.status).toBe('cancelled'); expect(c.commands).toEqual([{ service: 'gateway-hamra-standby', action: 'start' }])
    const ok = advance(c.run, obs({ pairs: { ...healthy, hamra: pair('serving', 'standby') }, at: 9000 }), 9000)
    expect(ok.run.stopped).toEqual([]); expect(ok.commands).toEqual([])
  })
  it('stops nothing when it cannot tell which single gateway serves, and times out with nothing to restore', () => {
    const x = begin(gc, withHamra(healthy.hamra), 1000)
    expect(advance(x.run, withHamra(pair('waiting', 'standby')), 2000).commands).toEqual([])
    const lost = { ...x.run, step: 1, stepStartedAt: 2000, stopped: [], log: [] }
    expect(advance(lost, withHamra(pair('serving', 'serving')), 3000).commands).toEqual([])
    const t = advance(lost, withHamra(pair('serving', 'serving')), 2000 + gc.steps[1].timeoutMs + 1)
    expect(t.run.status).toBe('timeout'); expect(t.commands).toEqual([])
  })
  it('isUp reads standby services from the pair and primaries from buildingsUp', () => {
    expect(isUp('gateway-hamra-standby', withHamra(pair('serving', 'standby')))).toBe(true)
    expect(isUp('gateway-hamra-standby', withHamra(pair('serving', 'waiting')))).toBe(true)
    expect(isUp('gateway-hamra-standby', withHamra(pair('serving', 'stopped')))).toBe(false)
    expect(isUp('gateway-hamra-standby', withHamra(pair('serving', 'unknown')))).toBe(false)
    expect(isUp('gateway-hamra-standby', withHamra(pair('serving', 'standby'), { stale: true }))).toBe(false)
    expect(isUp('gateway-hamra-standby', obs())).toBe(false) // an older backend has no standby gateways
    expect(isUp('gateway-mar-mikhael-standby', withHamra(pair('serving', 'standby')))).toBe(true)
    expect(isUp('gateway-hamra', withHamra(pair('serving', 'standby'), { buildingsUp: ['mar_mikhael'] }))).toBe(false)
  })
  it('the capacity proof ignores the pairs: only granted against capacity counts', () => {
    const p = proof([withHamra(healthy.hamra, { at: 1, granted: 100 }), takenOver({ at: 2, granted: 110 }), returned({ at: 3, granted: 90 })])
    expect(p).toEqual({ peak: 110, capacity: 120, violations: 0, samples: 3, observedSince: 1 })
  })
})

describe('deriveTimeline with standby gateways', () => {
  const o = (hamra: { primary: GatewayState; standby: GatewayState }, extra: Partial<Observation> = {}) => obs({ pairs: { hamra, mar_mikhael: pair('serving', 'standby'), achrafieh: pair('serving', 'standby') }, ...extra })
  it('reports the standby taking over once, when a gateway that stood by is observed serving', () => {
    const e = deriveTimeline(o(pair('stopped', 'standby')), o(pair('stopped', 'serving'), { at: 2000 }))
    expect(e.map(x => x.kind)).toEqual(['standby_took_over'])
    expect(e[0].detail).toBe('hamra standby gateway observed serving')
    expect(deriveTimeline(o(pair('stopped', 'serving')), o(pair('stopped', 'serving'), { at: 3000 }))).toEqual([])
  })
  it('reports a primary that was on standby and now serves, naming the building with a dash', () => {
    const e = deriveTimeline(obs({ pairs: { mar_mikhael: pair('standby', 'stopped') } }), obs({ pairs: { mar_mikhael: pair('serving', 'stopped') }, at: 2000 }))
    expect(e.map(x => x.kind)).toEqual(['standby_took_over']); expect(e[0].detail).toContain('mar-mikhael primary gateway')
  })
  it('does not call a cold start a takeover: waiting to serving is not standby to serving', () => {
    expect(deriveTimeline(o(pair('waiting', 'waiting')), o(pair('serving', 'standby'), { at: 2000 }))).toEqual([])
    expect(deriveTimeline(o(pair('waiting', 'waiting')), o(pair('waiting', 'serving'), { at: 2000 }))).toEqual([])
  })
  it('reports a standby gateway going down and coming back, which buildingsUp cannot show', () => {
    expect(deriveTimeline(o(pair('serving', 'standby')), o(pair('serving', 'stopped'), { at: 2000 }))).toEqual([{ at: 2000, kind: 'node_down', detail: 'standby gateway hamra observed unreachable' }])
    expect(deriveTimeline(o(pair('serving', 'stopped')), o(pair('serving', 'waiting'), { at: 3000 }))).toEqual([{ at: 3000, kind: 'node_up', detail: 'standby gateway hamra observed reachable' }])
    expect(deriveTimeline(o(pair('serving', 'stopped')), o(pair('serving', 'unknown'), { at: 3000 }))).toEqual([])
  })
  it('adds nothing when either observation has no pairs, or when the data is stale', () => {
    expect(deriveTimeline(obs(), o(pair('serving', 'standby'), { at: 2000 }))).toEqual([])
    expect(deriveTimeline(o(pair('serving', 'standby')), obs({ at: 2000 }))).toEqual([])
    expect(deriveTimeline(o(pair('stopped', 'standby')), o(pair('stopped', 'serving'), { at: 2000, stale: true }))).toEqual([])
  })
})

describe('nextCommand', () => {
  const start = { service: 'gateway-hamra', action: 'start' } as const, stop = { service: 'gateway-hamra', action: 'stop' } as const, other = { service: 'gateway-hamra-standby', action: 'start' } as const
  const running: RunState = { id: 'gateway-crash', step: 2, startedAt: 0, stepStartedAt: 0, stopped: [], status: 'running', log: [] }
  it('sends the first command that has not gone out in the last retry window', () => {
    expect(nextCommand([start, other], running, {}, 10000, 5000)).toEqual({ command: start, queue: [other] })
  })
  it('keeps a command that went out too recently in the queue instead of losing it, and does not let it block the others', () => {
    const sentAt = { 'start-gateway-hamra': 8000 }
    const first = nextCommand([start, other], running, sentAt, 10000, 5000)
    expect(first).toEqual({ command: other, queue: [start] })
    expect(nextCommand(first.queue, running, { ...sentAt, 'start-gateway-hamra-standby': 10000 }, 10500, 5000)).toEqual({ command: null, queue: [start] })
    expect(nextCommand(first.queue, running, sentAt, 13000, 5000)).toEqual({ command: start, queue: [] })
  })
  it('drops stress commands once the run is no longer running but keeps restores', () => {
    expect(nextCommand([stop, start], { ...running, status: 'timeout' }, {}, 10000, 5000)).toEqual({ command: start, queue: [] })
    expect(nextCommand([stop], running, {}, 10000, 5000)).toEqual({ command: stop, queue: [] })
    expect(nextCommand([], running, {}, 10000, 5000)).toEqual({ command: null, queue: [] })
  })
})

import { describe, expect, it } from 'vitest'
import { fairnessScore } from '../lab/fairness'
import { BUILDING_IDS, CAPACITY, HOLD_MS, NODE_IDS, fairShares, createSimulator, mulberry32, splitMeters, type SimLease, type Simulator } from './simulator'

const START = Date.UTC(2026, 0, 1, 12, 0, 0)
const SERVICES = [...NODE_IDS, 'gateway-hamra', 'gateway-mar-mikhael', 'gateway-achrafieh', 'postgres', 'mosquitto']
const GATEWAYS = ['gateway-hamra', 'gateway-mar-mikhael', 'gateway-achrafieh']

/** Every structural promise the ledger and gateways make, checked after a step. Empty when all hold. */
function violations(sim: Simulator): string[] {
  const s = sim.state, out: string[] = []
  const total = BUILDING_IDS.reduce((sum, id) => sum + (s.tiers[id]?.[0]?.amps ?? 0), 0)
  if (total > CAPACITY) out.push(`reserved ${total} exceeds ${CAPACITY}`)
  for (const id of BUILDING_IDS) {
    const tiers = s.tiers[id] ?? []
    if (s.tiers[id] && !tiers.length) out.push(`${id}: empty lease kept`)
    tiers.forEach((t, i) => {
      if (!(t.amps > 0)) out.push(`${id}: tier amps ${t.amps}`)
      if (i > 0 && !(t.amps < tiers[i - 1].amps && t.version > tiers[i - 1].version && t.expiresAt >= tiers[i - 1].expiresAt)) out.push(`${id}: tier order broken at ${i}`)
    })
  }
  const view = sim.overview()
  let granted = 0
  for (const b of view.buildings) {
    if (!b.online || !b.data) continue
    granted += b.data.granted_amps
    if (b.data.granted_amps > (s.tiers[b.id]?.[0]?.amps ?? 0)) out.push(`${b.id}: gateway holds ${b.data.granted_amps} A but the ledger reserves ${s.tiers[b.id]?.[0]?.amps ?? 0} A`)
    if (b.data.served_amps > b.data.granted_amps + 1e-9 || b.data.served_amps > b.data.demand_amps + 1e-9) out.push(`${b.id}: served above its grant or its demand`)
  }
  if (granted > CAPACITY) out.push(`gateways may serve ${granted} A in total`)
  const leader = sim.leaderId(), up = s.nodes.filter(n => n.up).length
  if (leader && (!s.nodes.find(n => n.id === leader)?.up || up < 2)) out.push('a leader without a live majority')
  return out
}
const reservedOf = (sim: Simulator, id: string) => sim.state.tiers[id]?.[0]?.amps ?? 0
function run(sim: Simulator, ms: number, check = true) {
  for (let t = 0; t < ms; t += 250) { sim.tick(250); if (check) { const v = violations(sim); if (v.length) throw new Error(`t=${sim.now() - START} ms: ${v.join('; ')}`) } }
}
const jainOf = (sim: Simulator) => { const d = sim.node(sim.leaderId()!)!; return fairnessScore(d.wants, d.leases) }
const building = (sim: Simulator, id: string) => sim.overview().buildings.find(b => b.id === id)!
const kinds = (sim: Simulator) => sim.state.audit.map(a => `${a.kind}:${a.building_id}`)

describe('fairShares', () => {
  it('gives everyone their want when the total fits', () => expect(fairShares([10, 20, 30], 120)).toEqual([10, 20, 30]))
  it('splits equally when everyone wants more', () => fairShares([100, 100, 100], 120).forEach(v => expect(v).toBeCloseTo(40)))
  it('lets a small want keep its want and splits the rest', () => {
    const shares = fairShares([10, 100, 100], 120)
    expect(shares[0]).toBe(10); expect(shares[1]).toBeCloseTo(55); expect(shares[2]).toBeCloseTo(55)
  })
  it('never exceeds the capacity and ignores wants that are not positive numbers', () => {
    for (const wants of [[500, 1, 0], [-5, NaN, 70], [30, 30, 30], [61, 59, 0]]) {
      const shares = fairShares(wants, 120)
      expect(shares.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(120 + 1e-9)
      shares.forEach((v, i) => { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(Math.max(0, Number.isFinite(wants[i]) ? wants[i] : 0) + 1e-9) })
    }
    expect(fairShares([-5, NaN, 70], 120)).toEqual([0, 0, 70])
    expect(fairShares([50, 50], 0)).toEqual([0, 0])
  })
})

describe('helpers', () => {
  it('splits meters across the buildings', () => {
    expect(splitMeters(10)).toEqual([4, 3, 3]); expect(splitMeters(50)).toEqual([17, 17, 16]); expect(splitMeters(200)).toEqual([67, 67, 66])
  })
  it('seeded generator repeats and stays in [0, 1)', () => {
    const a = mulberry32(5), b = mulberry32(5), c = mulberry32(6)
    const xs = Array.from({ length: 50 }, () => a())
    expect(xs).toEqual(Array.from({ length: 50 }, () => b()))
    expect(xs).not.toEqual(Array.from({ length: 50 }, () => c()))
    xs.forEach(x => { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1) })
  })
})

describe('overview shape', () => {
  const buildingKeys = ['building_id', 'name', 'meter_count', 'demand_amps', 'served_amps', 'granted_amps', 'lease_remaining_ms', 'lease_version', 'state', 'mqtt_connected', 'pending_readings', 'dropped_readings', 'readings_total', 'last_error']
  const nodeKeys = ['node_id', 'state', 'leader_id', 'quorum', 'capacity_amps', 'granted_amps', 'available_amps', 'leases', 'audit', 'postgres_connected', 'raft', 'quorum_verified_at', 'fair_share', 'wants', 'fair_shares']
  it('is valid before the first tick', () => {
    const sim = createSimulator({ seed: 1, startMs: START }), view = sim.overview()
    expect(view.demo_enabled).toBe(true)
    expect(view.observed_at).toBe(new Date(START).toISOString())
    expect(view.nodes.map(n => n.id)).toEqual([...NODE_IDS])
    expect(view.buildings.map(b => b.id)).toEqual([...BUILDING_IDS])
    expect(view.meters).toEqual({ id: 'meters', online: true, data: { meter_count: 50, demand_factor: 1, mqtt_connected: true, published_readings: 0 } })
    view.buildings.forEach(b => { expect(b.online).toBe(true); expect(b.data!.state).toBe('waiting'); expect(b.data!.granted_amps).toBe(0); expect(b.data!.demand_amps).toBeGreaterThan(0) })
    expect(view.nodes[0].data!.state).toBe('Leader'); expect(view.nodes[0].data!.raft.term).toBe('2')
    expect(view.nodes[0].data!.leases).toEqual([]); expect(view.nodes[0].data!.audit).toEqual([])
  })
  it('carries every Building and NodeData field with the right types, raft values as strings', () => {
    const sim = createSimulator({ seed: 1, startMs: START }); run(sim, 8000)
    const view = sim.overview()
    for (const b of view.buildings) {
      expect(Object.keys(b.data!).sort()).toEqual([...buildingKeys].sort())
      expect(typeof b.data!.state).toBe('string'); expect(typeof b.data!.mqtt_connected).toBe('boolean'); expect(typeof b.data!.demand_amps).toBe('number')
    }
    for (const n of view.nodes) {
      expect(Object.keys(n.data!).sort()).toEqual([...nodeKeys].sort())
      for (const v of Object.values(n.data!.raft)) expect(typeof v).toBe('string')
      for (const key of ['state', 'term', 'applied_index', 'last_log_index']) expect(n.data!.raft[key]).toBeDefined()
      expect(Number.isNaN(Date.parse(n.data!.quorum_verified_at))).toBe(false)
      n.data!.audit.forEach(a => expect(Object.keys(a).sort()).toEqual(['amps', 'building_id', 'event_id', 'kind', 'occurred_at', 'version']))
      n.data!.leases.forEach(l => { const tiers = (l as SimLease).tiers; expect(tiers.length).toBeGreaterThan(0); expect(l.amps).toBe(tiers[0].amps) })
      expect(n.data!.wants).toHaveLength(3); expect(n.data!.fair_shares).toHaveLength(3)
    }
  })
  it('reports a stopped coordinator and gateway as offline sources', () => {
    const sim = createSimulator({ seed: 1, startMs: START })
    sim.act('coordinator3', 'stop'); sim.act('gateway-achrafieh', 'stop')
    const view = sim.overview()
    expect(view.nodes[2]).toEqual({ id: 'coordinator3', online: false, error: 'connection refused' })
    expect(view.buildings[2]).toEqual({ id: 'achrafieh', online: false, error: 'connection refused' })
    expect(sim.node('coordinator3')).toBeNull()
  })
  it('starts cold: the three grants are audit events 1 to 3 within the first 1.5 s', () => {
    const sim = createSimulator({ seed: 1, startMs: START }); run(sim, 1500)
    expect(sim.state.audit.map(a => [a.event_id, a.kind])).toEqual([[1, 'granted'], [2, 'granted'], [3, 'granted']])
    expect(new Set(sim.state.audit.map(a => a.building_id)).size).toBe(3)
    expect(sim.reservedTotal()).toBeGreaterThan(0)
  })
  it('is deterministic for a seed', () => {
    const a = createSimulator({ seed: 9, startMs: START }), b = createSimulator({ seed: 9, startMs: START }), c = createSimulator({ seed: 10, startMs: START })
    for (const sim of [a, b, c]) { sim.setMeters({ meter_count: 200, demand_factor: 1 }); run(sim, 30000, false) }
    expect(JSON.stringify(a.overview())).toBe(JSON.stringify(b.overview()))
    expect(JSON.stringify(a.overview())).not.toBe(JSON.stringify(c.overview()))
  })
  it('catches up at most 5 s per tick call', () => {
    const sim = createSimulator({ seed: 1, startMs: START }); sim.tick(60000)
    expect(sim.now() - START).toBe(5000)
    sim.tick(-10); sim.tick(NaN); expect(sim.now() - START).toBe(5000)
  })
})

describe('capacity invariant', () => {
  it('never exceeds capacity under random failures, policy switches and meter changes (8 seeds, 10 simulated minutes each)', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const sim = createSimulator({ seed, startMs: START }), r = mulberry32(seed * 7919 + 13)
      const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]
      let nextOp = 0, nextHeal = 60000
      for (let t = 0; t < 600000; t += 250) {
        if (t >= nextOp) {
          nextOp = t + 1000 + Math.floor(r() * 7000)
          const k = r()
          if (k < 0.5) sim.act(pick(SERVICES), r() < 0.55 ? 'stop' : 'start')
          else if (k < 0.65) sim.setPolicy(pick(['fair_share', 'first_come']))
          else sim.setMeters({ meter_count: pick([10, 50, 200, 400, 1000]), demand_factor: pick([0, 0.5, 1, 2, 3]) })
        }
        if (t >= nextHeal) { nextHeal = t + 45000 + Math.floor(r() * 30000); for (const service of SERVICES) sim.act(service, 'start') }
        const lastLog = sim.state.lastLog, minority = sim.state.nodes.filter(n => n.up).length < 2
        sim.tick(250)
        const problems = violations(sim)
        if (problems.length) throw new Error(`seed ${seed}, t=${t} ms: ${problems.join('; ')}`)
        if (minority && sim.state.nodes.filter(n => n.up).length < 2) expect(sim.state.lastLog).toBe(lastLog)
      }
    }
  }, 60000)
})

describe('tiers decay', () => {
  it('keeps the larger tier until its own hold passes, then shrinks and audits it', () => {
    const sim = createSimulator({ seed: 3, startMs: START }); run(sim, 30000)
    const before = sim.state.tiers.hamra, big = before[0], r0 = big.amps
    expect(r0).toBeGreaterThan(10)
    expect(big.expiresAt - sim.now()).toBeLessThanOrEqual(HOLD_MS)
    const hamraEvents = () => sim.state.audit.filter(a => a.building_id === 'hamra').length, events = hamraEvents()
    sim.setMeters({ meter_count: 10, demand_factor: 1 })
    while (sim.now() < big.expiresAt - 250) { run(sim, 250); expect(reservedOf(sim, 'hamra')).toBeGreaterThanOrEqual(r0) }
    expect(hamraEvents()).toBe(events) // nothing of Hamra's was reduced or reclaimed early
    run(sim, 1000)
    expect(reservedOf(sim, 'hamra')).toBeLessThan(r0)
    const shrunk = sim.state.audit.filter(a => a.building_id === 'hamra' && a.kind === 'shrunk')
    expect(shrunk.length).toBeGreaterThan(0)
    expect(shrunk[shrunk.length - 1].amps).toBeLessThan(r0)
    // The reservation follows the (much lower) demand, never below what the building still asks for.
    run(sim, 2 * HOLD_MS)
    expect(reservedOf(sim, 'hamra')).toBeLessThanOrEqual(Math.ceil(building(sim, 'hamra').data!.demand_amps * 1.1) + 2)
    expect(sim.reservedTotal()).toBeLessThan(25)
  })
  it('builds a ladder when demand falls in steps and the gateway serves the largest live grant', () => {
    const sim = createSimulator({ seed: 4, startMs: START }); sim.setMeters({ meter_count: 200, demand_factor: 0.6 }); run(sim, 20000)
    sim.setMeters({ meter_count: 200, demand_factor: 0.3 }); run(sim, 4000)
    sim.setMeters({ meter_count: 200, demand_factor: 0.1 }); run(sim, 4000)
    const tiers = sim.state.tiers.hamra
    expect(tiers.length).toBeGreaterThanOrEqual(2)
    const lease = sim.node('coordinator1')!.leases.find(l => l.building_id === 'hamra')! as SimLease
    expect(lease.tiers.map(t => t.amps)).toEqual(tiers.map(t => t.amps))
    expect(lease.amps).toBe(tiers[0].amps); expect(lease.version).toBe(tiers[tiers.length - 1].version)
    const view = building(sim, 'hamra').data!
    expect(view.granted_amps).toBe(tiers[0].amps)
    expect(view.lease_remaining_ms).toBeGreaterThan(0); expect(view.lease_remaining_ms).toBeLessThanOrEqual(HOLD_MS)
    expect(view.state).toBe('active')
  })
  it('reclaims a lease when its last tier expires without a renewal (demand 0)', () => {
    const sim = createSimulator({ seed: 5, startMs: START }); run(sim, 15000)
    sim.setMeters({ meter_count: 50, demand_factor: 0 }); run(sim, HOLD_MS + 4000)
    expect(sim.reservedTotal()).toBe(0)
    BUILDING_IDS.forEach(id => expect(kinds(sim)).toContain(`reclaimed:${id}`))
  })
})

describe('policy effect', () => {
  const settle = (policy: 'fair_share' | 'first_come', seed: number, ms: number) => {
    const sim = createSimulator({ seed, startMs: START })
    sim.setMeters({ meter_count: 200, demand_factor: 1 }); sim.setPolicy(policy); run(sim, ms)
    return sim
  }
  it('first come lets one building hold most of the generator while another gets nothing', () => {
    for (const seed of [1, 2, 3, 4]) {
      const sim = settle('first_come', seed, 30000)
      const held = BUILDING_IDS.map(id => reservedOf(sim, id))
      expect(Math.max(...held)).toBeGreaterThan(CAPACITY * 0.4)
      expect(jainOf(sim)!).toBeLessThan(0.9)
      expect(sim.reservedTotal()).toBeLessThanOrEqual(CAPACITY)
    }
  })
  it('fair sharing converges on equal shares under the same overload', () => {
    for (const seed of [1, 2, 3, 4]) {
      const sim = settle('fair_share', seed, 40000)
      expect(jainOf(sim)!).toBeGreaterThanOrEqual(0.95)
      expect(sim.reservedTotal()).toBeGreaterThanOrEqual(CAPACITY - 12)
    }
  })
  it('switching first come -> fair share never revokes early, then evens out within 40 s', () => {
    const sim = settle('first_come', 2, 30000)
    const before = jainOf(sim)!
    const r0: Record<string, number> = {}, until: Record<string, number> = {}
    for (const id of BUILDING_IDS) { r0[id] = reservedOf(sim, id); until[id] = sim.state.tiers[id]?.[0]?.expiresAt ?? 0 }
    expect(sim.setPolicy('fair_share')).toEqual({ ok: true })
    for (let t = 0; t < 40000; t += 250) {
      run(sim, 250)
      for (const id of BUILDING_IDS) if (sim.now() < until[id] - 250) expect(reservedOf(sim, id)).toBeGreaterThanOrEqual(r0[id])
    }
    expect(jainOf(sim)!).toBeGreaterThanOrEqual(0.95)
    expect(jainOf(sim)!).toBeGreaterThan(before)
    expect(sim.reservedTotal()).toBeLessThanOrEqual(CAPACITY)
    expect(sim.node('coordinator1')!.fair_share).toBe(true)
  })
  it('a heavy first-come overload leaves one building with the generator (about 107 / 13 / 0)', () => {
    const sim = createSimulator({ seed: 1, startMs: START })
    sim.setMeters({ meter_count: 200, demand_factor: 1.6 }); sim.setPolicy('first_come'); run(sim, 6000)
    const held = BUILDING_IDS.map(id => reservedOf(sim, id)).sort((a, b) => b - a)
    expect(held[0]).toBeGreaterThan(90); expect(held[2]).toBe(0)
    expect(building(sim, BUILDING_IDS.find(id => reservedOf(sim, id) === 0)!).data!.state).toBe('waiting')
  })
})

describe('majority', () => {
  it('freezes the ledger without a majority: no grants, renewals or reclaims; gateways stop serving at their deadlines', () => {
    const sim = createSimulator({ seed: 2, startMs: START }); run(sim, 30000)
    sim.act('coordinator1', 'stop'); run(sim, 4000)
    expect(sim.leaderId()).toBe('coordinator2')
    sim.act('coordinator2', 'stop')
    expect(sim.leaderId()).toBeNull()
    const frozen = JSON.stringify({ tiers: sim.state.tiers, audit: sim.state.audit, lastLog: sim.state.lastLog, version: sim.state.version })
    sim.setMeters({ meter_count: 200, demand_factor: 3 })
    run(sim, 45000)
    expect(JSON.stringify({ tiers: sim.state.tiers, audit: sim.state.audit, lastLog: sim.state.lastLog, version: sim.state.version })).toBe(frozen)
    expect(sim.leaderId()).toBeNull()
    const view = sim.overview()
    expect(view.nodes[2].data!.state).toBe('Candidate'); expect(view.nodes[2].data!.quorum).toBe(false)
    expect(view.nodes[2].data!.granted_amps).toBeGreaterThan(0) // the frozen ledger copy
    for (const b of view.buildings) { expect(b.data!.state).toBe('expired'); expect(b.data!.served_amps).toBe(0); expect(b.data!.granted_amps).toBe(0); expect(b.data!.last_error).toMatch(/lease expired/) }
    expect(sim.setPolicy('first_come')).toMatchObject({ ok: false })
    // A majority comes back: an election, reclaims of what expired, fresh grants.
    sim.act('coordinator2', 'start'); run(sim, 2000); expect(sim.leaderId()).toBeNull()
    run(sim, 3000)
    expect(sim.leaderId()).not.toBeNull()
    run(sim, 20000)
    expect(sim.state.audit.length).toBeGreaterThan(JSON.parse(frozen).audit.length)
    expect(sim.overview().buildings.every(b => b.data!.state !== 'expired')).toBe(true)
  })
  it('keeps committing with one of three coordinators down', () => {
    const sim = createSimulator({ seed: 2, startMs: START }); run(sim, 5000)
    sim.act('coordinator3', 'stop'); const log = sim.state.lastLog; run(sim, 10000)
    expect(sim.state.lastLog).toBeGreaterThan(log); expect(sim.leaderId()).toBe('coordinator1')
    expect(sim.node('coordinator1')!.quorum).toBe(true)
  })
})

describe('leader failover', () => {
  it('elects a new leader at term + 1 within 3 s, and the old leader returns as a follower', () => {
    const sim = createSimulator({ seed: 6, startMs: START }); run(sim, 20000)
    const total = sim.reservedTotal(), log = sim.state.lastLog
    expect(sim.act('coordinator1', 'stop')).toEqual({ ok: true })
    expect(sim.leaderId()).toBeNull()
    expect(sim.node('coordinator2')!.state).toBe('Candidate'); expect(sim.node('coordinator2')!.leader_id).toBe('')
    run(sim, 1500); expect(sim.leaderId()).toBeNull()
    run(sim, 1500)
    expect(sim.leaderId()).toBe('coordinator2')
    const leader = sim.node('coordinator2')!
    expect(leader.raft.term).toBe('3'); expect(leader.state).toBe('Leader'); expect(leader.quorum).toBe(true)
    expect(sim.state.lastLog).toBeGreaterThan(log)
    expect(sim.reservedTotal()).toBeLessThanOrEqual(CAPACITY); expect(total).toBeLessThanOrEqual(CAPACITY)
    run(sim, 5000)
    sim.act('coordinator1', 'start')
    expect(sim.node('coordinator1')!.state).toBe('Candidate') // warming up
    run(sim, 2000)
    const back = sim.node('coordinator1')!
    expect(back.state).toBe('Follower'); expect(back.leader_id).toBe('coordinator2'); expect(back.raft.term).toBe('3')
    expect(sim.leaderId()).toBe('coordinator2')
    expect(Number(back.raft.last_log_index)).toBe(sim.state.lastLog)
    expect(Number(back.raft.applied_index)).toBeGreaterThanOrEqual(sim.state.lastLog - 1)
    expect(Number(leader.raft.applied_index)).toBe(Number(leader.raft.last_log_index))
  })
  it('never elects without a majority, however long it waits', () => {
    const sim = createSimulator({ seed: 6, startMs: START })
    sim.act('coordinator1', 'stop'); sim.act('coordinator3', 'stop'); run(sim, 30000)
    expect(sim.leaderId()).toBeNull()
  })
})

describe('gateways, broker and database', () => {
  it('reclaims a stopped gateway lease once its hold passes, and a restarted gateway starts a new session', () => {
    const sim = createSimulator({ seed: 7, startMs: START }); run(sim, 20000)
    const total = sim.reservedTotal(); expect(reservedOf(sim, 'hamra')).toBeGreaterThan(0)
    expect(building(sim, 'hamra').data!.readings_total).toBeGreaterThan(100)
    sim.act('gateway-hamra', 'stop')
    expect(building(sim, 'hamra')).toEqual({ id: 'hamra', online: false, error: 'connection refused' })
    run(sim, HOLD_MS + 1000)
    expect(sim.state.tiers.hamra).toBeUndefined()
    expect(kinds(sim)).toContain('reclaimed:hamra')
    expect(sim.reservedTotal()).toBeLessThan(total)
    sim.act('gateway-hamra', 'start')
    const fresh = building(sim, 'hamra').data!
    expect(fresh.state).toBe('waiting'); expect(fresh.readings_total).toBe(0)
    run(sim, 2500)
    expect(reservedOf(sim, 'hamra')).toBeGreaterThan(0)
    expect(building(sim, 'hamra').data!.state).toMatch(/active|limited/)
  })
  it('broker down: readings stop, demand freezes then ages out after 8 s, and the gateways say why', () => {
    const sim = createSimulator({ seed: 8, startMs: START }); run(sim, 10000)
    const total = building(sim, 'mar_mikhael').data!.readings_total, published = sim.overview().meters.data!.published_readings
    expect(sim.act('mosquitto', 'stop')).toEqual({ ok: true })
    expect(sim.overview().meters.data!.mqtt_connected).toBe(false)
    run(sim, 3000)
    let b = building(sim, 'mar_mikhael').data!
    expect(b.mqtt_connected).toBe(false); expect(b.demand_amps).toBeGreaterThan(0); expect(b.last_error).toBe('MQTT broker unreachable')
    expect(b.readings_total).toBe(total); expect(sim.overview().meters.data!.published_readings).toBe(published)
    run(sim, 6000)
    b = building(sim, 'mar_mikhael').data!
    expect(b.demand_amps).toBe(0); expect(b.served_amps).toBe(0)
    sim.act('mosquitto', 'start'); run(sim, 1000)
    b = building(sim, 'mar_mikhael').data!
    expect(b.mqtt_connected).toBe(true); expect(b.demand_amps).toBeGreaterThan(0); expect(b.readings_total).toBeGreaterThan(total)
  })
  it('database down: readings queue up then drop beyond 200, grants and audit continue, the queue drains on recovery', () => {
    const sim = createSimulator({ seed: 9, startMs: START }); run(sim, 8000)
    sim.act('postgres', 'stop')
    expect(sim.node('coordinator1')!.postgres_connected).toBe(false)
    const events = sim.state.audit.length
    sim.setMeters({ meter_count: 200, demand_factor: 1 }); run(sim, 25000)
    for (const b of sim.overview().buildings) { expect(b.data!.pending_readings).toBe(200); expect(b.data!.dropped_readings).toBeGreaterThan(0) }
    expect(sim.state.audit.length).toBeGreaterThan(events) // the ledger kept granting
    sim.act('postgres', 'start'); run(sim, 3000)
    expect(sim.node('coordinator1')!.postgres_connected).toBe(true)
    for (const b of sim.overview().buildings) expect(b.data!.pending_readings).toBe(0)
  })
})

describe('validation', () => {
  it('rejects bad meter settings and keeps the old ones', () => {
    const sim = createSimulator({ seed: 1, startMs: START })
    for (const cfg of [{ meter_count: 0, demand_factor: 1 }, { meter_count: 1.5, demand_factor: 1 }, { meter_count: 1001, demand_factor: 1 }, { meter_count: '50', demand_factor: 1 }, { meter_count: NaN, demand_factor: 1 }, { meter_count: 50, demand_factor: -0.1 }, { meter_count: 50, demand_factor: 3.1 }, { meter_count: 50, demand_factor: NaN }, { meter_count: 50, demand_factor: '1' }, { meter_count: undefined, demand_factor: undefined }]) {
      expect(sim.setMeters(cfg as never)).toMatchObject({ ok: false, error: expect.any(String) })
    }
    expect(sim.overview().meters.data).toMatchObject({ meter_count: 50, demand_factor: 1 })
    expect(sim.setMeters({ meter_count: 1000, demand_factor: 3 })).toEqual({ ok: true })
    expect(sim.setMeters({ meter_count: 1, demand_factor: 0 })).toEqual({ ok: true })
    expect(sim.overview().buildings.map(b => b.data!.meter_count)).toEqual([1, 0, 0])
  })
  it('rejects unknown policies, services and actions', () => {
    const sim = createSimulator({ seed: 1, startMs: START })
    expect(sim.setPolicy('greedy')).toMatchObject({ ok: false }); expect(sim.setPolicy(undefined)).toMatchObject({ ok: false })
    expect(sim.act('coordinator9', 'stop')).toMatchObject({ ok: false, error: expect.stringContaining('coordinator9') })
    expect(sim.act('postgres', 'restart')).toMatchObject({ ok: false, error: expect.stringContaining('restart') })
    expect(sim.setPolicy('first_come')).toEqual({ ok: true }); expect(sim.node('coordinator1')!.fair_share).toBe(false)
    expect(sim.setPolicy('fair_share')).toEqual({ ok: true }); expect(sim.node('coordinator1')!.fair_share).toBe(true)
    for (const service of GATEWAYS) expect(sim.act(service, 'stop')).toEqual({ ok: true })
  })
})

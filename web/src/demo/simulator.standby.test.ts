import { describe, expect, it } from 'vitest'
import type { Building, GatewayRole, Source } from '../data'
import { pairView } from '../board/standby-logic'
import { BUILDING_IDS, CAPACITY, HOLD_MS, NODE_IDS, REFUSAL_MS, createSimulator, mulberry32, type Simulator } from './simulator'

const START = Date.UTC(2026, 0, 1, 12, 0, 0)
const SERVICES = [...NODE_IDS, ...BUILDING_IDS.flatMap(id => [`gateway-${id.replaceAll('_', '-')}`, `gateway-${id.replaceAll('_', '-')}-standby`]), 'postgres', 'mosquitto']
const make = (seed = 3) => createSimulator({ seed, startMs: START, standbys: true })
const view = (sim: Simulator) => sim.overview()
const pair = (sim: Simulator, id: string) => { const v = view(sim); return { primary: v.buildings.find(b => b.id === id)!, standby: v.standbys!.find(b => b.id === id)! } }
const role = (src: Source<Building>): GatewayRole | undefined => src.data?.role
const roles = (sim: Simulator, id: string) => { const p = pair(sim, id); return [p.primary.online ? role(p.primary) : 'stopped', p.standby.online ? role(p.standby) : 'stopped'] }

/** Every promise the ledger makes about gateways, checked after every step. Empty when all hold. */
function problems(sim: Simulator): string[] {
  const s = sim.state, out: string[] = [], v = view(sim)
  const total = BUILDING_IDS.reduce((sum, id) => sum + (s.tiers[id]?.[0]?.amps ?? 0), 0)
  if (total > CAPACITY) out.push(`reserved ${total} exceeds ${CAPACITY}`)
  let granted = 0
  for (const id of BUILDING_IDS) {
    const gws = [v.buildings.find(b => b.id === id)!, v.standbys!.find(b => b.id === id)!].filter(g => g.online)
    const serving = gws.filter(g => g.data!.role === 'serving')
    if (serving.length > 1) out.push(`${id}: ${serving.length} gateways serve`)
    for (const g of gws) {
      if (g.data!.role === 'serving' && g.data!.granted_amps <= 0) out.push(`${id}: serving without a grant`)
      if (g.data!.role !== 'serving' && (g.data!.granted_amps !== 0 || g.data!.served_amps !== 0)) out.push(`${id}: a ${g.data!.role} gateway holds or serves amps`)
      if (g.data!.granted_amps > (s.tiers[id]?.[0]?.amps ?? 0)) out.push(`${id}: gateway holds ${g.data!.granted_amps} A but the ledger reserves ${s.tiers[id]?.[0]?.amps ?? 0} A`)
      if (g.data!.served_amps > g.data!.granted_amps + 1e-9) out.push(`${id}: served above grant`)
      granted += g.data!.granted_amps
    }
    // A live local lease is always the ledger's lease: the serving gateway's session is the holder.
    const holder = s.holder[id], live = [...s.buildings, ...s.standbys].filter(g => g.id === id && g.up && g.grants.some(x => x.expiresAt > s.now))
    if (live.length && !live.every(g => g.session === holder)) out.push(`${id}: a gateway serves under a session that does not hold the building`)
    if (!s.tiers[id]?.length && holder !== undefined) out.push(`${id}: holder kept after reclaim`)
  }
  if (granted > CAPACITY) out.push(`gateways may serve ${granted} A in total`)
  return out
}
function run(sim: Simulator, ms: number) {
  for (let t = 0; t < ms; t += 250) { sim.tick(250); const p = problems(sim); if (p.length) throw new Error(`t=${sim.now() - START} ms: ${p.join('; ')}`) }
}

describe('standbys option', () => {
  it('leaves the older shape without standbys: no standbys key, no role, no session id, no standby services', () => {
    const sim = createSimulator({ seed: 1, startMs: START })
    run0(sim)
    const v = sim.overview()
    expect('standbys' in v).toBe(false)
    for (const b of v.buildings) { expect('role' in b.data!).toBe(false); expect('session_id' in b.data!).toBe(false) }
    expect(sim.act('gateway-hamra-standby', 'stop')).toMatchObject({ ok: false, error: expect.stringContaining('gateway-hamra-standby') })
    function run0(x: Simulator) { x.tick(5000) }
  })
  it('does not change what the primaries do: same seed, same ledger, with or without standbys while nothing fails', () => {
    const a = createSimulator({ seed: 5, startMs: START }), b = make(5)
    for (let t = 0; t < 60000; t += 250) { a.tick(250); b.tick(250) }
    expect(b.state.tiers).toEqual(a.state.tiers)
    expect(b.state.audit.map(e => [e.kind, e.building_id, e.amps])).toEqual(a.state.audit.map(e => [e.kind, e.building_id, e.amps]))
    expect(b.reservedTotal()).toBe(a.reservedTotal())
  })
})

describe('overview with standbys', () => {
  it('has three standby sources shaped like the buildings, each with a session id and a role', () => {
    const sim = make(); run(sim, 8000)
    const v = view(sim)
    expect(v.standbys!.map(s => s.id)).toEqual([...BUILDING_IDS])
    for (const src of [...v.buildings, ...v.standbys!]) {
      expect(src.online).toBe(true)
      expect(Object.keys(src.data!).sort()).toEqual(['building_id', 'demand_amps', 'dropped_readings', 'granted_amps', 'last_error', 'lease_remaining_ms', 'lease_version', 'meter_count', 'mqtt_connected', 'name', 'pending_readings', 'readings_total', 'role', 'served_amps', 'session_id', 'state'])
      expect(src.data!.session_id).toMatch(/^[0-9a-f]{8}-0000-4000-8000-\d{12}$/)
    }
    const sessions = [...v.buildings, ...v.standbys!].map(s => s.data!.session_id)
    expect(new Set(sessions).size).toBe(6)
  })
  it('is valid before the first tick: every gateway waits, nobody serves yet', () => {
    const sim = make(); const v = view(sim)
    for (const src of [...v.buildings, ...v.standbys!]) { expect(role(src)).toBe('waiting'); expect(src.data!.state).toBe('waiting') }
  })
  it('starts cold with each primary serving and each standby refused, so standing by', () => {
    const sim = make(); run(sim, 8000)
    for (const id of BUILDING_IDS) expect(roles(sim, id)).toEqual(['serving', 'standby'])
    expect(pair(sim, 'hamra').standby.data).toMatchObject({ granted_amps: 0, served_amps: 0, lease_remaining_ms: 0, state: 'waiting', last_error: expect.stringContaining('building_session_active') })
    expect(pair(sim, 'hamra').standby.data!.demand_amps).toBeGreaterThan(0) // it reads the same meters
  })
  it('a standby that was refused more than 8 s ago is waiting again, not standing by', () => {
    const sim = make(); run(sim, 8000)
    sim.state.standbys[0].nextAt = Infinity // stops asking
    run(sim, REFUSAL_MS + 500)
    expect(role(pair(sim, 'hamra').standby)).toBe('waiting')
  })
})

describe('takeover', () => {
  it('after the serving primary stops, nobody serves for about 12 to 15 s, then the standby serves', () => {
    const sim = make(); run(sim, 20000)
    expect(roles(sim, 'hamra')).toEqual(['serving', 'standby'])
    const tiers = sim.state.tiers.hamra, lastExpiry = Math.max(...tiers.map(t => t.expiresAt)), stopAt = sim.now()
    sim.act('gateway-hamra', 'stop')
    expect(roles(sim, 'hamra')).toEqual(['stopped', 'standby'])
    expect(pairView(pair(sim, 'hamra').primary, pair(sim, 'hamra').standby, true)).toMatchObject({ serving: 'none', headline: 'No gateway serving' })
    // The ledger holds the building until the last tier ends: the standby is refused until then.
    while (sim.now() < lastExpiry - 250) { run(sim, 250); expect(roles(sim, 'hamra')).toEqual(['stopped', 'standby']); expect(sim.state.tiers.hamra).toBeDefined() }
    let served = -1
    while (sim.now() - stopAt < HOLD_MS + 8000) { run(sim, 250); if (role(pair(sim, 'hamra').standby) === 'serving') { served = sim.now() - stopAt; break } }
    expect(served).toBeGreaterThanOrEqual(HOLD_MS - 3000) // renewals are at most 3.5 s apart
    expect(served).toBeLessThanOrEqual(HOLD_MS + 3750)
    const v = pairView(pair(sim, 'hamra').primary, pair(sim, 'hamra').standby, true)
    expect(v).toMatchObject({ serving: 'standby', headline: 'Served by standby', takeover: true })
    const kinds = sim.state.audit.filter(a => a.building_id === 'hamra').slice(-3).map(a => a.kind)
    expect(kinds).toContain('reclaimed'); expect(kinds[kinds.length - 1]).toBe('granted')
    expect(pair(sim, 'hamra').standby.data).toMatchObject({ state: expect.stringMatching(/active|limited/), granted_amps: expect.any(Number) })
    expect(pair(sim, 'hamra').standby.data!.served_amps).toBeGreaterThan(0)
  })
  it('a restarted primary comes back as the standby and does not take the building back', () => {
    const sim = make(); run(sim, 20000)
    const before = pair(sim, 'hamra').primary.data!.session_id
    sim.act('gateway-hamra', 'stop'); run(sim, HOLD_MS + 5000)
    expect(roles(sim, 'hamra')).toEqual(['stopped', 'serving'])
    sim.act('gateway-hamra', 'start')
    const fresh = pair(sim, 'hamra').primary.data!
    expect(fresh).toMatchObject({ state: 'waiting', role: 'waiting', readings_total: 0 }); expect(fresh.session_id).not.toBe(before)
    run(sim, 2000)
    expect(roles(sim, 'hamra')).toEqual(['standby', 'serving'])
    run(sim, 3 * HOLD_MS) // however long it waits, it stays on standby while the standby keeps renewing
    expect(roles(sim, 'hamra')).toEqual(['standby', 'serving'])
    expect(pairView(pair(sim, 'hamra').primary, pair(sim, 'hamra').standby, true)).toMatchObject({ serving: 'standby', takeover: true })
  })
  it('the standby can be stopped in turn: the primary then takes the building over', () => {
    const sim = make(); run(sim, 20000)
    sim.act('gateway-hamra', 'stop'); run(sim, HOLD_MS + 5000); sim.act('gateway-hamra', 'start'); run(sim, 6000)
    expect(roles(sim, 'hamra')).toEqual(['standby', 'serving'])
    sim.act('gateway-hamra-standby', 'stop'); run(sim, HOLD_MS + 5000)
    expect(roles(sim, 'hamra')).toEqual(['serving', 'stopped'])
  })
  it('a restart before the lease lapses is refused like a second session, then served once it lapses', () => {
    const sim = make(); run(sim, 20000)
    sim.act('gateway-hamra-standby', 'stop'); sim.act('gateway-hamra', 'stop')
    run(sim, 1000); sim.act('gateway-hamra', 'start'); run(sim, 1500)
    expect(roles(sim, 'hamra')).toEqual(['standby', 'stopped']) // refused: the old session still holds the building
    run(sim, HOLD_MS + 5000)
    expect(roles(sim, 'hamra')).toEqual(['serving', 'stopped'])
  })
  it('with both gateways stopped the lease is reclaimed and nobody serves; a start brings service back', () => {
    const sim = make(); run(sim, 20000)
    sim.act('gateway-achrafieh', 'stop'); sim.act('gateway-achrafieh-standby', 'stop'); run(sim, HOLD_MS + 2000)
    expect(roles(sim, 'achrafieh')).toEqual(['stopped', 'stopped']); expect(sim.state.tiers.achrafieh).toBeUndefined()
    expect(pairView(pair(sim, 'achrafieh').primary, pair(sim, 'achrafieh').standby, true)).toMatchObject({ serving: 'none', tone: 'fault' })
    sim.act('gateway-achrafieh-standby', 'start'); run(sim, 4000)
    expect(roles(sim, 'achrafieh')).toEqual(['stopped', 'serving'])
  })
  it('without a majority nothing is granted or taken over, and gateways stop serving at their deadlines', () => {
    const sim = make(); run(sim, 20000)
    sim.act('gateway-hamra', 'stop'); sim.act('coordinator2', 'stop'); sim.act('coordinator3', 'stop')
    const log = sim.state.lastLog
    run(sim, 40000)
    expect(sim.state.lastLog).toBe(log)
    for (const id of BUILDING_IDS) expect(roles(sim, id)).not.toContain('serving')
    sim.act('coordinator2', 'start'); run(sim, 20000)
    expect(roles(sim, 'hamra')).toEqual(['stopped', 'serving'])
  })
})

describe('capacity and ledger invariants with standbys', () => {
  it('never lets two gateways serve a building or total grants pass capacity, under random failures of every service (8 seeds, 10 simulated minutes each)', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const sim = createSimulator({ seed, startMs: START, standbys: true }), r = mulberry32(seed * 7919 + 17)
      const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]
      let nextOp = 0, nextHeal = 60000
      for (let t = 0; t < 600000; t += 250) {
        if (t >= nextOp) {
          nextOp = t + 1000 + Math.floor(r() * 7000)
          const k = r()
          if (k < 0.55) sim.act(pick(SERVICES), r() < 0.55 ? 'stop' : 'start')
          else if (k < 0.7) sim.setPolicy(pick(['fair_share', 'first_come']))
          else sim.setMeters({ meter_count: pick([10, 50, 200, 400, 1000]), demand_factor: pick([0, 0.5, 1, 2, 3]) })
        }
        if (t >= nextHeal) { nextHeal = t + 45000 + Math.floor(r() * 30000); for (const service of SERVICES) sim.act(service, 'start') }
        sim.tick(250)
        const p = problems(sim)
        if (p.length) throw new Error(`seed ${seed}, t=${t} ms: ${p.join('; ')}`)
      }
    }
  }, 60000)
})

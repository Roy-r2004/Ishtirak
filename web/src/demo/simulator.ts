import type {Audit, Building, GatewayRole, Lease, Meter, NodeData, Overview, Source} from '../data'
import type {Policy, Share} from '../lab/fairness'

/**
 * Deterministic in-browser stand-in for the whole stack (three coordinators, three gateways, meters, broker, database).
 * It mirrors the real rules: a reservation is a ladder of committed tiers, each with its own hold; a commit needs a verified
 * leader and a majority; gateways serve only from grants they received and stop before the ledger can reclaim them.
 * Pure (no timers, no DOM); install.ts drives it from real time.
 *
 * With `standbys: true` every building has a second, standby gateway running the same code, as the real stack now does. The ledger lets
 * one gateway session hold a building, so the standby is refused (role "standby") until the lease lapses, about 12 to 15 s after the
 * serving gateway stops renewing, and is then granted the building. A restarted gateway is a new session: it comes back as the standby
 * and does not take the building back. Without the option the simulator behaves like the older backend: no "standbys", no "role".
 */
export const CAPACITY = 120
/** How long a committed tier holds capacity in the ledger. */
export const HOLD_MS = 12000
/** A gateway stops serving this long before the ledger may reclaim the tier. */
export const SAFETY_MS = 1000
export const RENEW_MS = 3000
export const ELECTION_MS = 2500
export const WARM_MS = 1500
/** Gateways ignore readings older than this. */
export const STALE_READING_MS = 8000
export const PENDING_CAP = 200
/** A building asks for a little more than it draws right now. */
export const HEADROOM = 1.1
export const BUILDING_IDS = ['hamra', 'mar_mikhael', 'achrafieh'] as const
export const NODE_IDS = ['coordinator1', 'coordinator2', 'coordinator3'] as const
const NAMES: Record<string, string> = { hamra: 'Hamra Residence', mar_mikhael: 'Mar Mikhael House', achrafieh: 'Achrafieh Gardens' }
/** A gateway is refused for this long after the ledger says another session holds the building, and is a standby while it lasts. */
export const REFUSAL_MS = 8000
/** A standby asks a little after its primary, so on a cold start the primary is the one granted. */
const STANDBY_OFFSET_MS = 1500
export type GatewaySide = 'primary' | 'standby'
const GATEWAY_SERVICE: Record<string, { id: string; side: GatewaySide }> = {
  'gateway-hamra': { id: 'hamra', side: 'primary' }, 'gateway-mar-mikhael': { id: 'mar_mikhael', side: 'primary' }, 'gateway-achrafieh': { id: 'achrafieh', side: 'primary' },
  'gateway-hamra-standby': { id: 'hamra', side: 'standby' }, 'gateway-mar-mikhael-standby': { id: 'mar_mikhael', side: 'standby' }, 'gateway-achrafieh-standby': { id: 'achrafieh', side: 'standby' },
}
const WEIGHT = [1.08, 1, 0.94]
const PERIOD_S = [140, 170, 200]
const PHASE = [0.4, 2.5, 4.6]
const OFFSET_MS = [200, 700, 1200]

export type Tier = { version: number; amps: number; expiresAt: number }
export type Grant = { version: number; amps: number; expiresAt: number }
export type SimLease = Lease & { tiers: { version: number; amps: number }[] }
export type Role = 'Leader' | 'Follower' | 'Candidate'
export type SimNode = { id: string; up: boolean; role: Role; warmAt: number; lagUntil: number }
export type SimBuilding = { id: string; side: GatewaySide; session: string; sessions: number; refusedAt: number; up: boolean; reading: { amps: number; at: number }; noise: number; want: number; nextAt: number; grants: Grant[]; hadGrant: boolean; pending: number; dropped: number; total: number; carry: number }
export type SimState = {
  startMs: number; now: number; policy: Policy
  meters: { count: number; factor: number; published: number }
  postgres: boolean; mosquitto: boolean
  term: number; leader: string | null; electionAt: number | null
  lastLog: number; version: number; nextEvent: number
  tiers: Record<string, Tier[]>; audit: Audit[]; quorumAt: number
  nodes: SimNode[]; buildings: SimBuilding[]
  /** The standby gateways, one per building; empty when the simulator mimics a backend without them. */
  standbys: SimBuilding[]
  /** The gateway session that holds each building's lease in the ledger. Kept only with standbys. */
  holder: Record<string, string>
}
export type Result = { ok: true } | { ok: false; error: string }
export type Simulator = {
  readonly state: SimState
  tick(dtMs: number): void
  now(): number
  overview(): Overview
  /** What that coordinator's WebSocket sends; null when it is stopped. */
  node(id: string): NodeData | null
  leaderId(): string | null
  /** Sum of every lease's largest tier: the amps the ledger has reserved. */
  reservedTotal(): number
  act(service: string, action: string): Result
  setMeters(cfg: { meter_count: unknown; demand_factor: unknown }): Result
  setPolicy(policy: unknown): Result
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Max-min fair split (water filling): everyone gets min(want, level), the level uses up the capacity. Total never exceeds capacity. */
export function fairShares(wants: number[], capacity: number): number[] {
  const want = wants.map(w => Number.isFinite(w) && w > 0 ? w : 0)
  const out: number[] = want.map(() => 0)
  let remaining = Math.max(0, capacity)
  let active = want.map((_, i) => i).filter(i => want[i] > 0)
  while (active.length) {
    const level = remaining / active.length
    const satisfied = active.filter(i => want[i] <= level)
    if (!satisfied.length) { for (const i of active) out[i] = level; return out }
    for (const i of satisfied) { out[i] = want[i]; remaining -= want[i] }
    active = active.filter(i => !satisfied.includes(i))
  }
  return out
}

/** Meters per building: the remainder goes to the first buildings (10 -> 4/3/3, 50 -> 17/17/16, 200 -> 67/67/66). */
export const splitMeters = (total: number): number[] => BUILDING_IDS.map((_, i) => Math.floor(total / 3) + (i < total % 3 ? 1 : 0))
const round2 = (n: number) => Math.round(n * 100) / 100
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const iso = (ms: number) => new Date(ms).toISOString()

/** A stand-in for a gateway's session UUID (the console shows its first group). Derived, not drawn, so seeds stay comparable. */
function sessionId(building: string, side: GatewaySide, n: number): string {
  let h = 2166136261
  for (const c of `${building}/${side}/${n}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return `${(h >>> 0).toString(16).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`
}

export function createSimulator(opts: { seed?: number; startMs?: number; standbys?: boolean } = {}): Simulator {
  const rng = mulberry32(opts.seed ?? 1)
  // The standbys' request timing has its own generator, so enabling them never changes what the primaries do.
  const standbyRng = mulberry32((opts.seed ?? 1) ^ 0x9e3779b9)
  const standbyMode = !!opts.standbys
  const startMs = opts.startMs ?? Date.now()
  const gateway = (id: string, i: number, side: GatewaySide): SimBuilding => ({ id, side, session: sessionId(id, side, 1), sessions: 1, refusedAt: -Infinity, up: true, reading: { amps: 0, at: startMs }, noise: 0, want: 0, nextAt: startMs + OFFSET_MS[i] + (side === 'standby' ? STANDBY_OFFSET_MS : 0), grants: [], hadGrant: false, pending: 0, dropped: 0, total: 0, carry: 0 })
  const s: SimState = {
    startMs, now: startMs, policy: 'fair_share',
    meters: { count: 50, factor: 1, published: 0 },
    postgres: true, mosquitto: true,
    term: 2, leader: 'coordinator1', electionAt: null,
    lastLog: 4, version: 0, nextEvent: 1,
    tiers: {}, audit: [], quorumAt: startMs,
    nodes: NODE_IDS.map(id => ({ id, up: true, role: id === 'coordinator1' ? 'Leader' as Role : 'Follower' as Role, warmAt: startMs, lagUntil: startMs })),
    buildings: BUILDING_IDS.map((id, i) => gateway(id, i, 'primary')),
    standbys: standbyMode ? BUILDING_IDS.map((id, i) => gateway(id, i, 'standby')) : [],
    holder: {},
  }
  let publishCarry = 0
  const gateways = () => [...s.buildings, ...s.standbys]
  const indexOf = (id: string) => BUILDING_IDS.indexOf(id as typeof BUILDING_IDS[number])
  /** What a building asks for: the larger want of its running gateways (both read the same meters). */
  const wantOf = (i: number) => Math.max(0, ...[s.buildings[i], s.standbys[i]].filter(g => g?.up).map(g => g.want))
  const upCount = () => s.nodes.filter(n => n.up).length
  const hasMajority = () => upCount() >= 2
  const canCommit = () => s.leader !== null && hasMajority()
  const reservedOf = (id: string) => s.tiers[id]?.[0]?.amps ?? 0
  const reservedTotal = () => BUILDING_IDS.reduce((sum, id) => sum + reservedOf(id), 0)
  const modelDemand = (i: number) => {
    const b = s.buildings[i], t = (s.now - s.startMs) / 1000
    const base = splitMeters(s.meters.count)[i] * 0.9 * s.meters.factor * WEIGHT[i]
    return Math.max(0, base * (1 + 0.25 * Math.sin(2 * Math.PI * t / PERIOD_S[i] + PHASE[i]) + b.noise))
  }
  /** The demand the gateway acts on: its last reading, ignored once it is older than STALE_READING_MS. */
  const gatewayDemand = (b: SimBuilding) => s.now - b.reading.at > STALE_READING_MS ? 0 : b.reading.amps
  const liveGrants = (b: SimBuilding) => b.grants.filter(g => g.expiresAt > s.now)

  function commit() {
    s.lastLog++
    for (const n of s.nodes) if (n.up && n.role !== 'Leader') n.lagUntil = s.now + 1000
  }
  function record(kind: string, building: string, amps: number, version: number) {
    s.audit.push({ event_id: s.nextEvent++, kind, building_id: building, amps, version, occurred_at: iso(s.now) })
    if (s.audit.length > 100) s.audit.splice(0, s.audit.length - 100)
  }

  function updateConsensus() {
    const leaderNode = s.nodes.find(n => n.id === s.leader)
    if (s.leader !== null && (!leaderNode?.up || !hasMajority())) { s.leader = null; s.electionAt = null }
    if (s.leader === null) {
      if (hasMajority()) {
        if (s.electionAt === null) s.electionAt = s.now + ELECTION_MS
        if (s.now >= s.electionAt) {
          const winner = s.nodes.find(n => n.up)!
          s.leader = winner.id; s.term++; s.electionAt = null; winner.warmAt = 0
          commit() // the new leader's first entry
        }
      } else s.electionAt = null
    }
    for (const n of s.nodes) n.role = s.leader === n.id ? 'Leader' : s.leader !== null && s.now >= n.warmAt ? 'Follower' : 'Candidate'
    if (canCommit()) s.quorumAt = s.now
  }

  function sweep() {
    for (const id of BUILDING_IDS) {
      const tiers = s.tiers[id]
      if (!tiers?.length) continue
      let k = -1
      tiers.forEach((t, i) => { if (t.expiresAt <= s.now) k = i })
      if (k < 0) continue // an expired tier takes every older one with it
      const before = tiers[0].amps, rest = tiers.slice(k + 1)
      commit()
      if (!rest.length) { delete s.tiers[id]; delete s.holder[id]; record('reclaimed', id, before, tiers[k].version) }
      else { s.tiers[id] = rest; record('shrunk', id, rest[0].amps, rest[rest.length - 1].version) }
    }
  }

  function renew(b: SimBuilding) {
    const i = indexOf(b.id), want = Math.ceil(gatewayDemand(b) * HEADROOM - 1e-9)
    b.want = want
    if (want <= 0) return
    // The ledger lets one gateway session hold a building: while another session's lease is live, this request is refused.
    if (standbyMode && s.tiers[b.id]?.length && s.holder[b.id] !== b.session) { b.refusedAt = s.now; return }
    let ask = want
    if (s.policy === 'fair_share') ask = Math.min(want, Math.floor(fairShares(BUILDING_IDS.map((_, k) => wantOf(k)), CAPACITY)[i] + 1e-9))
    if (ask <= 0) return
    const tiers = s.tiers[b.id] ?? [], reserved = tiers[0]?.amps ?? 0, free = CAPACITY - reservedTotal()
    const amps = ask > reserved ? Math.min(ask, reserved + free) : ask
    if (amps <= 0) return // denied: nothing free
    const tier: Tier = { version: ++s.version, amps, expiresAt: s.now + HOLD_MS }
    // Older tiers that are not larger are dominated by the new one; larger ones keep the reservation until their own hold ends.
    s.tiers[b.id] = [...tiers.filter(t => t.amps > amps), tier]
    if (standbyMode) s.holder[b.id] = b.session
    commit()
    if (amps > reserved) record('granted', b.id, amps, tier.version)
    b.grants.push({ version: tier.version, amps, expiresAt: tier.expiresAt - SAFETY_MS })
    b.hadGrant = true
  }

  function step(h: number) {
    s.now += h
    updateConsensus()
    // Meters publish at 1 Hz per meter while the broker is up; a gateway only receives them while it is running.
    if (s.mosquitto) {
      publishCarry += s.meters.count * h / 1000
      const whole = Math.floor(publishCarry); publishCarry -= whole; s.meters.published += whole
    }
    const perBuilding = splitMeters(s.meters.count)
    for (const b of s.buildings) b.noise = clamp(b.noise + (rng() - 0.5) * 0.012, -0.04, 0.04)
    // Both gateways of a building read the same meters; each one buffers its own readings.
    for (const b of gateways()) {
      const i = indexOf(b.id)
      if (s.mosquitto) b.reading = { amps: modelDemand(i), at: s.now }
      if (!b.up) continue
      b.grants = liveGrants(b)
      let produced = 0
      if (s.mosquitto) { b.carry += perBuilding[i] * h / 1000; produced = Math.floor(b.carry); b.carry -= produced; b.total += produced }
      if (s.postgres) b.pending = Math.max(0, b.pending - Math.ceil(150 * h / 1000))
      else {
        b.pending += produced
        if (b.pending > PENDING_CAP) { b.dropped += b.pending - PENDING_CAP; b.pending = PENDING_CAP }
      }
    }
    if (!canCommit()) { for (const b of gateways()) if (b.up && s.now >= b.nextAt) b.nextAt = s.now + 1000; return }
    sweep()
    // Primaries come first, so on a tie the primary asks before its standby.
    const due = gateways().filter(b => b.up && s.now >= b.nextAt).sort((a, c) => a.nextAt - c.nextAt)
    for (const b of due) {
      renew(b)
      b.nextAt = s.now + RENEW_MS + Math.round(((b.side === 'standby' ? standbyRng : rng)() - 0.5) * 1000)
    }
  }

  function leaseOut(id: string): SimLease | null {
    const tiers = s.tiers[id]
    if (!tiers?.length) return null
    return { building_id: id, amps: tiers[0].amps, version: tiers[tiers.length - 1].version, tiers: tiers.map(t => ({ version: t.version, amps: t.amps })) }
  }
  const wantsOut = (): Share[] => BUILDING_IDS.map((id, i) => ({ building_id: id, amps: wantOf(i) }))
  const fairOut = (): Share[] => {
    const wants = wantsOut(), shares = fairShares(wants.map(w => w.amps), CAPACITY)
    return wants.map((w, i) => ({ building_id: w.building_id, amps: round2(shares[i]) }))
  }

  function nodeData(n: SimNode): NodeData {
    const lagging = n.role === 'Follower' && s.now < n.lagUntil
    const applied = Math.max(0, s.lastLog - (lagging ? 1 : 0))
    const granted = reservedTotal()
    const leases = BUILDING_IDS.map(leaseOut).filter((l): l is SimLease => l !== null)
    return {
      node_id: n.id, state: n.role, leader_id: n.role === 'Candidate' ? '' : s.leader ?? '',
      quorum: n.role === 'Leader' ? hasMajority() : s.leader !== null && hasMajority() && n.role === 'Follower',
      capacity_amps: CAPACITY, granted_amps: granted, available_amps: CAPACITY - granted,
      leases: leases as Lease[], audit: s.audit.map(a => ({ ...a })), postgres_connected: s.postgres,
      raft: { state: n.role, term: String(s.term), applied_index: String(applied), last_log_index: String(s.lastLog), commit_index: String(applied), last_snapshot_index: '0', num_peers: String(NODE_IDS.length - 1) },
      quorum_verified_at: iso(s.quorumAt), fair_share: s.policy === 'fair_share', wants: wantsOut(), fair_shares: fairOut(),
    }
  }

  function buildingData(b: SimBuilding): Building {
    const i = indexOf(b.id), grants = liveGrants(b)
    let best: Grant | null = null
    for (const g of grants) if (!best || g.amps > best.amps || (g.amps === best.amps && g.expiresAt > best.expiresAt)) best = g
    const demand = gatewayDemand(b), granted = best?.amps ?? 0, remaining = best ? Math.max(0, best.expiresAt - s.now) : 0
    const state = remaining > 0 ? (demand > granted ? 'limited' : 'active') : b.hadGrant ? 'expired' : 'waiting'
    // Serving = a live lease. A gateway the ledger refused within REFUSAL_MS stands by; anything else is waiting.
    const role: GatewayRole = remaining > 0 ? 'serving' : s.now - b.refusedAt <= REFUSAL_MS ? 'standby' : 'waiting'
    const lastError = b.hadGrant && remaining === 0 ? 'lease expired; serving stopped' : !s.mosquitto ? 'MQTT broker unreachable' : !s.postgres && b.pending > 0 ? 'storage unavailable; readings are queued' : standbyMode && role === 'standby' ? 'building_session_active: another gateway session holds this building' : ''
    return {
      building_id: b.id, name: NAMES[b.id], meter_count: splitMeters(s.meters.count)[i],
      demand_amps: round2(demand), served_amps: round2(Math.min(demand, granted)), granted_amps: granted,
      lease_remaining_ms: Math.round(remaining), lease_version: best?.version ?? 0, state,
      mqtt_connected: s.mosquitto, pending_readings: b.pending, dropped_readings: b.dropped, readings_total: b.total, last_error: lastError,
      ...(standbyMode ? { session_id: b.session, role } : {}),
    }
  }

  const down = (id: string) => ({ id, online: false, error: 'connection refused' })
  function overview(): Overview {
    const nodes: Source<NodeData>[] = s.nodes.map(n => n.up ? { id: n.id, online: true, data: nodeData(n) } : down(n.id))
    const source = (b: SimBuilding): Source<Building> => b.up ? { id: b.id, online: true, data: buildingData(b) } : down(b.id)
    const buildings = s.buildings.map(source)
    const meters: Source<Meter> = { id: 'meters', online: true, data: { meter_count: s.meters.count, demand_factor: s.meters.factor, mqtt_connected: s.mosquitto, published_readings: Math.floor(s.meters.published) } }
    return { nodes, buildings, ...(standbyMode ? { standbys: s.standbys.map(source) } : {}), meters, observed_at: iso(s.now), demo_enabled: true }
  }

  function act(service: string, action: string): Result {
    if (action !== 'stop' && action !== 'start') return { ok: false, error: `unknown action "${action}"` }
    const up = action === 'start'
    const node = s.nodes.find(n => n.id === service)
    if (node) {
      if (node.up === up) return { ok: true }
      node.up = up
      if (up) node.warmAt = s.now + WARM_MS
      else if (s.leader === node.id) { s.leader = null; s.electionAt = null; if (hasMajority()) s.electionAt = s.now + ELECTION_MS }
      updateConsensus()
      return { ok: true }
    }
    const target = GATEWAY_SERVICE[service], b = target && (target.side === 'primary' ? s.buildings : s.standbys)[indexOf(target.id)]
    if (b) {
      const i = indexOf(b.id)
      if (b.up === up) return { ok: true }
      b.up = up
      if (up) { // a new session: nothing carried over from the crashed process. It asks the ledger like any gateway and is refused while the other session holds the building.
        Object.assign(b, { grants: [], hadGrant: false, pending: 0, dropped: 0, total: 0, carry: 0, want: 0, nextAt: s.now + 500, refusedAt: -Infinity, session: sessionId(b.id, b.side, ++b.sessions) })
        b.reading = { amps: s.mosquitto ? modelDemand(i) : b.reading.amps, at: s.mosquitto ? s.now : b.reading.at }
      } else { b.grants = []; b.want = 0 }
      return { ok: true }
    }
    if (service === 'postgres') { s.postgres = up; return { ok: true } }
    if (service === 'mosquitto') { s.mosquitto = up; return { ok: true } }
    return { ok: false, error: `unknown service "${service}"` }
  }

  function setMeters(cfg: { meter_count: unknown; demand_factor: unknown }): Result {
    const count = cfg?.meter_count, factor = cfg?.demand_factor
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 1000) return { ok: false, error: 'meter_count must be a whole number from 1 to 1000' }
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0 || factor > 3) return { ok: false, error: 'demand_factor must be a number from 0 to 3' }
    s.meters.count = count; s.meters.factor = factor
    return { ok: true }
  }

  function setPolicy(policy: unknown): Result {
    if (policy !== 'fair_share' && policy !== 'first_come') return { ok: false, error: 'policy must be fair_share or first_come' }
    if (!canCommit()) return { ok: false, error: 'The policy needs a leader with a majority to commit it. Restore a coordinator and try again.' }
    s.policy = policy
    commit()
    return { ok: true }
  }

  updateConsensus()
  s.buildings.forEach((b, i) => { b.reading = { amps: modelDemand(i), at: s.now } })

  return {
    state: s,
    tick(dtMs: number) {
      let left = Math.min(Math.max(0, Number.isFinite(dtMs) ? dtMs : 0), 5000)
      while (left > 0) { const h = Math.min(250, left); left -= h; step(h) }
    },
    now: () => s.now,
    overview,
    node: id => { const n = s.nodes.find(x => x.id === id); return n?.up ? nodeData(n) : null },
    leaderId: () => s.leader,
    reservedTotal,
    act, setMeters, setPolicy,
  }
}

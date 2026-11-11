// Preset fixtures for the local mock API. Everything here is SYNTHETIC test data for screenshots and
// end-to-end scripts; it is never an observation of the real system.
export const CAPACITY = 120
export const COORD = ['coordinator1', 'coordinator2', 'coordinator3']
export const IDS = ['hamra', 'mar_mikhael', 'achrafieh']
export const NAMES = { hamra: 'Hamra Residence', mar_mikhael: 'Mar Mikhael House', achrafieh: 'Achrafieh Gardens' }
export const PRESET_NAMES = ['healthy', 'hog', 'node-down', 'leader-down', 'stale', 'majority-lost', 'gateway-down', 'violation', 'db-down', 'broker-down']

const amps = (a, b, c) => ({ hamra: a, mar_mikhael: b, achrafieh: c })
const shares = (a, b, c) => IDS.map((id, i) => ({ building_id: id, amps: [a, b, c][i] }))

/** ~12 committed events, oldest first, ids increasing, all inside the last two minutes. Ends with one event per lease tier. */
function makeAudit(now, leases) {
  const tierEvents = []
  for (const id of IDS) (leases[id] || []).forEach((t, i) => tierEvents.push({ kind: i === 0 ? 'granted' : 'shrunk', building_id: id, amps: t.amps, version: t.version }))
  tierEvents.sort((a, b) => a.version - b.version || IDS.indexOf(a.building_id) - IDS.indexOf(b.building_id))
  const history = [
    ['granted', 'hamra', 18, 1], ['granted', 'mar_mikhael', 14, 1], ['granted', 'achrafieh', 12, 1], ['shrunk', 'mar_mikhael', 9, 2],
    ['granted', 'hamra', 34, 2], ['reclaimed', 'achrafieh', 12, 2], ['granted', 'achrafieh', 16, 3], ['granted', 'mar_mikhael', 20, 3],
  ].map(([kind, building_id, a, version]) => ({ kind, building_id, amps: a, version })).slice(0, Math.max(0, 12 - tierEvents.length))
  const all = [...history, ...tierEvents]
  return all.map((e, i) => ({ event_id: 100 + i, ...e, occurred_at: new Date(now - (all.length - i) * 9000).toISOString() }))
}

export function buildState(name, now) {
  const S = {
    preset: name, presetAt: now, stale: false, jitter: 2, drift: name === 'healthy',
    nodes: Object.fromEntries(COORD.map(id => [id, { online: true, epoch: 0 }])),
    leaderId: 'coordinator1', term: 3, applied: 212, lastLog: 212, tickN: 0, electionScheduled: false, electionPending: 0,
    policyFair: true,
    meters: { count: 50, factor: 1, mqtt: true, published: 48210 },
    postgres: true, dbDownAt: 0, pendingBase: 0, pendingGrows: false,
    quorumLostAt: null, remainingAtLoss: {}, quorumVerifiedAt: now,
    gateways: Object.fromEntries(IDS.map((id, i) => [id, { online: true, epoch: 0, readings: 2000 + i * 300, dropped: 0 }])),
    base: amps(28, 22, 19.5),
    leases: { hamra: [{ version: 7, amps: 31 }, { version: 9, amps: 26 }], mar_mikhael: [{ version: 8, amps: 24 }], achrafieh: [{ version: 6, amps: 22 }] },
    leaseBase: {},
    wants: shares(38, 30, 27), fairShares: shares(38, 30, 27),
    tasks: [], audit: [],
  }
  switch (name) {
    case 'healthy': break
    case 'hog':
      S.policyFair = false; S.jitter = 0.5; S.base = amps(98, 58, 56)
      S.leases = { hamra: [{ version: 11, amps: 102 }, { version: 14, amps: 70 }], mar_mikhael: [{ version: 12, amps: 7 }], achrafieh: [{ version: 13, amps: 4 }] }
      S.wants = shares(110, 60, 58); S.fairShares = shares(40, 40, 40)
      break
    case 'node-down': S.nodes.coordinator2.online = false; break
    case 'leader-down': S.nodes.coordinator1.online = false; S.leaderId = null; S.electionPending = 3000; break
    case 'stale': S.stale = true; break
    case 'majority-lost':
      S.nodes.coordinator2.online = false; S.nodes.coordinator3.online = false; S.leaderId = null
      S.quorumLostAt = now; S.remainingAtLoss = amps(12000, 12000, 12000)
      break
    case 'gateway-down': S.gateways.hamra.online = false; break
    case 'violation': // synthetic: the leader reports 124 A granted against 120 A capacity, to exercise the red limit lamp. Not a real system state.
      S.policyFair = false; S.jitter = 0.5; S.base = amps(48, 38, 32)
      S.leases = { hamra: [{ version: 5, amps: 50 }], mar_mikhael: [{ version: 5, amps: 40 }], achrafieh: [{ version: 5, amps: 34 }] }
      S.wants = shares(55, 45, 38); S.fairShares = shares(40, 40, 40)
      break
    case 'db-down': S.postgres = false; S.dbDownAt = now; S.pendingBase = 40; break
    case 'broker-down': S.meters.mqtt = false; break
    default: throw Error(`Unknown preset ${name}`)
  }
  S.audit = makeAudit(now, S.leases)
  S.nextEventId = 100 + S.audit.length
  return S
}

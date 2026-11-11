import { describe, expect, it } from 'vitest'
import type { Audit, Building, NodeData, Source } from '../data'
import { amps, capacityFigures, coverage } from './readouts'
import { LEDGER_LIMIT, filterAudit, kindText, ledgerCaption } from './ledger-logic'
import { UNKNOWN, clusterFacts, nodeRows, verifiedAt } from './cluster-details'

const gateway = (id: string, demand: number, served: number, online = true): Source<Building> => ({ id, online, data: { building_id: id, name: id, meter_count: 10, demand_amps: demand, served_amps: served, granted_amps: served, lease_remaining_ms: 5000, lease_version: 1, state: 'active', mqtt_connected: true, pending_readings: 0, dropped_readings: 0, readings_total: 1, last_error: '' } })

describe('capacity figures', () => {
  const three = [gateway('a', 20, 20), gateway('b', 30, 25), gateway('c', 10, 10)]
  it('free is capacity minus reserved; served and curtailed come from the gateways', () => {
    expect(capacityFigures({ fresh: true, capacity: 120, reserved: 77, buildings: three })).toEqual({ free: 43, served: 55, curtailed: 5, reporting: 3, total: 3 })
  })
  it('curtailed is a real 0 when nothing is curtailed', () => {
    const f = capacityFigures({ fresh: true, capacity: 120, reserved: 40, buildings: [gateway('a', 20, 20), gateway('b', 10, 10)] })
    expect(f.curtailed).toBe(0)
    expect(amps(f.curtailed)).toBe('0 A')
  })
  it('curtailed never goes negative, even when served is reported above demand', () => {
    expect(capacityFigures({ fresh: true, capacity: 120, reserved: 40, buildings: [gateway('a', 10, 12)] }).curtailed).toBe(0)
  })
  it('free floors at 0 when the ledger shows more reserved than capacity', () => {
    expect(capacityFigures({ fresh: true, capacity: 120, reserved: 124, buildings: three }).free).toBe(0)
  })
  it('stale data gives no figures at all, never zeros', () => {
    const f = capacityFigures({ fresh: false, capacity: 120, reserved: 77, buildings: three })
    expect([f.free, f.served, f.curtailed]).toEqual([null, null, null])
    expect([f.free, f.served, f.curtailed].map(amps)).toEqual(['—', '—', '—'])
  })
  it('an unknown capacity or reservation leaves free unknown but keeps served', () => {
    expect(capacityFigures({ fresh: true, capacity: undefined, reserved: 77, buildings: three }).free).toBeNull()
    expect(capacityFigures({ fresh: true, capacity: 120, reserved: null, buildings: three })).toMatchObject({ free: null, served: 55 })
    expect(capacityFigures({ fresh: true, capacity: Number.NaN, reserved: 10, buildings: three }).free).toBeNull()
  })
  it('only gateways that report count, and the figure says how many did', () => {
    const f = capacityFigures({ fresh: true, capacity: 120, reserved: 50, buildings: [gateway('a', 20, 18), gateway('b', 30, 30, false), { id: 'c', online: false }] })
    expect(f).toMatchObject({ served: 18, curtailed: 2, reporting: 1, total: 3 })
    expect(coverage(f)).toBe('1 of 3 gateways reporting')
    expect(coverage(capacityFigures({ fresh: true, capacity: 120, reserved: 50, buildings: three }))).toBe('')
  })
  it('with no gateway reporting, served and curtailed are unknown rather than 0', () => {
    const f = capacityFigures({ fresh: true, capacity: 120, reserved: 50, buildings: [{ id: 'a', online: false }, { id: 'b', online: false }] })
    expect(f).toMatchObject({ free: 70, served: null, curtailed: null, reporting: 0 })
    expect(coverage(f)).toBe('')
  })
  it('ignores a gateway whose numbers are not valid', () => {
    const bad = gateway('x', Number.NaN, 5)
    expect(capacityFigures({ fresh: true, capacity: 120, reserved: 50, buildings: [bad, gateway('a', 20, 20)] })).toMatchObject({ served: 20, reporting: 1 })
  })
  it('rounds to one decimal so floating-point noise never shows', () => {
    const f = capacityFigures({ fresh: true, capacity: 120, reserved: 0.1 + 0.2, buildings: [gateway('a', 0.1 + 0.2, 0.3)] })
    expect(f).toMatchObject({ free: 119.7, served: 0.3, curtailed: 0 })
    expect(amps(17.14)).toBe('17.1 A')
  })
})

describe('ledger door filtering', () => {
  const event = (event_id: number, kind: string, building_id = 'hamra'): Audit => ({ event_id, kind, building_id, amps: 10 + event_id, version: event_id, occurred_at: '2026-01-01T10:00:00Z' })
  const events = [event(1, 'granted'), event(2, 'granted', 'mar_mikhael'), event(3, 'shrunk'), event(4, 'reclaimed', 'achrafieh'), event(5, 'granted', 'achrafieh')]
  it('lists newest first whatever order the coordinator sends', () => {
    expect(filterAudit(events, '', 'all').rows.map(e => e.event_id)).toEqual([5, 4, 3, 2, 1])
    expect(filterAudit([...events].reverse(), '', 'all').rows.map(e => e.event_id)).toEqual([5, 4, 3, 2, 1])
  })
  it('filters by kind, with Reduced meaning the stored "shrunk"', () => {
    expect(filterAudit(events, '', 'granted').rows.map(e => e.event_id)).toEqual([5, 2, 1])
    expect(filterAudit(events, '', 'shrunk').rows.map(e => e.event_id)).toEqual([3])
    expect(filterAudit(events, '', 'reclaimed').rows.map(e => e.event_id)).toEqual([4])
    expect(kindText('shrunk')).toBe('Reduced')
  })
  it('searches building name, event number and entry text, ignoring case and spaces around it', () => {
    expect(filterAudit(events, ' achrafieh ', 'all').rows.map(e => e.event_id)).toEqual([5, 4])
    expect(filterAudit(events, '3', 'all').rows.map(e => e.event_id)).toEqual([3])
    expect(filterAudit(events, 'REDUCED', 'all').rows.map(e => e.event_id)).toEqual([3])
    expect(filterAudit(events, 'nothing like this', 'all').rows).toEqual([])
  })
  it('combines the search and the kind filter', () => {
    expect(filterAudit(events, 'achrafieh', 'granted').rows.map(e => e.event_id)).toEqual([5])
  })
  it('never lists more than 100 events and keeps the newest ones', () => {
    const many = Array.from({ length: 150 }, (_, i) => event(i + 1, 'granted'))
    const view = filterAudit(many, '', 'all')
    expect(LEDGER_LIMIT).toBe(100)
    expect(view.rows).toHaveLength(100)
    expect(view.rows[0].event_id).toBe(150)
    expect(view.rows.at(-1)?.event_id).toBe(51)
    expect(view.available).toBe(100)
    expect(filterAudit(many, '', 'all', 20).rows).toHaveLength(20)
  })
  it('copes with no events at all', () => {
    expect(filterAudit(undefined, '', 'all')).toEqual({ rows: [], available: 0 })
  })
  it('does not change the list it was given', () => {
    const before = events.map(e => e.event_id)
    filterAudit(events, '', 'all')
    expect(events.map(e => e.event_id)).toEqual(before)
  })
  it('the caption says how many matching events are shown and where the full history is', () => {
    expect(ledgerCaption(filterAudit(events, '', 'all'), false)).toBe('5 events shown. Full history lives in PostgreSQL.')
    expect(ledgerCaption(filterAudit(events, '', 'granted'), true)).toBe('3 events matching, of 5 held here. Full history lives in PostgreSQL.')
    expect(ledgerCaption(filterAudit(events, '3', 'all'), true)).toBe('1 event matching, of 5 held here. Full history lives in PostgreSQL.')
    expect(ledgerCaption(filterAudit(undefined, '', 'all'), false)).toBe('No events yet. Full history lives in PostgreSQL.')
    expect(ledgerCaption(filterAudit(events, 'zzz', 'all'), true)).toBe('0 events matching, of 5 held here. Full history lives in PostgreSQL.')
  })
})

describe('cluster details', () => {
  const node = (id: string, over: Partial<NodeData> = {}): Source<NodeData> => ({ id, online: true, data: { node_id: id, state: 'Follower', leader_id: 'coordinator1', quorum: true, capacity_amps: 120, granted_amps: 77, available_amps: 43, leases: [], audit: [], postgres_connected: true, raft: { state: 'Follower', term: '3', applied_index: '212', last_log_index: '213', commit_index: '212', last_snapshot_index: '0' }, quorum_verified_at: '2026-03-04T10:11:12Z', ...over } })
  it('gives one row per coordinator with every observed field', () => {
    const [row] = nodeRows([node('coordinator2')])
    expect(row).toEqual({ id: 'coordinator2', name: 'Coordinator 2', reachable: 'Yes', role: 'Follower', raftState: 'Follower', leaderId: 'coordinator1', term: '3', applied: '212', lastLog: '213', commit: '212', snapshot: '0', reserved: '77 A' })
  })
  it('says unknown, not 0, for a field the coordinator did not report', () => {
    const [row] = nodeRows([node('coordinator1', { raft: { state: 'Leader', term: '3' }, granted_amps: undefined as unknown as number })])
    expect(row).toMatchObject({ term: '3', applied: UNKNOWN, lastLog: UNKNOWN, commit: UNKNOWN, snapshot: UNKNOWN, reserved: UNKNOWN })
  })
  it('treats an empty string as missing but an empty leader id as "none"', () => {
    const [row] = nodeRows([node('coordinator3', { leader_id: '', state: '', raft: { state: ' ', term: '' } })])
    expect(row).toMatchObject({ leaderId: 'none', role: UNKNOWN, raftState: UNKNOWN, term: UNKNOWN })
  })
  it('an unreachable coordinator is marked so and every observed field is unknown', () => {
    const [row] = nodeRows([{ id: 'coordinator2', online: false, error: 'connection refused' }])
    expect(row).toMatchObject({ reachable: 'No', role: 'Unreachable', raftState: UNKNOWN, leaderId: UNKNOWN, term: UNKNOWN, applied: UNKNOWN, reserved: UNKNOWN })
  })
  it('reads numeric raft values too and survives an online node without data', () => {
    const [a] = nodeRows([node('coordinator1', { raft: { term: 4 as unknown as string } })])
    expect(a.term).toBe('4')
    const [b] = nodeRows([{ id: 'coordinator1', online: true }])
    expect(b).toMatchObject({ reachable: 'Yes', role: UNKNOWN, leaderId: UNKNOWN })
  })
  it('a zero or garbled majority time is unknown', () => {
    expect(verifiedAt('0001-01-01T00:00:00Z')).toBe(UNKNOWN)
    expect(verifiedAt('not a date')).toBe(UNKNOWN)
    expect(verifiedAt(undefined)).toBe(UNKNOWN)
    expect(verifiedAt('2026-03-04T10:11:12Z')).toMatch(/^\d\d:\d\d:\d\d$/)
  })
  const base = { stale: false, reachable: 3, total: 3, quorum: true, streamLive: true, policy: 'fair_share' as const }
  const facts = (over: object = {}, cluster?: NodeData | null) => Object.fromEntries(clusterFacts({ ...base, cluster, ...over }).map(f => [f.key, f.value]))
  it('lists the cluster facts of the old cluster page', () => {
    const c = node('coordinator1').data!
    const f = facts({}, { ...c, wants: [{ building_id: 'a', amps: 30 }, { building_id: 'b', amps: 30 }], leases: [{ building_id: 'a', amps: 30, version: 1 }, { building_id: 'b', amps: 30, version: 2 }] })
    expect(f).toMatchObject({ postgres: 'Connected', majority: 'Verified', reachable: '3 of 3', feed: 'WebSocket', policy: 'Fair sharing', fairness: '100%' })
    expect(f['verified-at']).toMatch(/^\d\d:\d\d:\d\d$/)
  })
  it('reports a database that is down, no majority, polling and first come', () => {
    const c = node('coordinator1', { postgres_connected: false }).data!
    expect(facts({ quorum: false, streamLive: false, policy: 'first_come', reachable: 1 }, c)).toMatchObject({ postgres: 'Not connected', majority: 'Not verified', feed: 'Polling', policy: 'First come', reachable: '1 of 3' })
  })
  it('shows unknown instead of inventing values when the cluster has not reported', () => {
    expect(facts({ policy: null }, undefined)).toMatchObject({ postgres: UNKNOWN, majority: UNKNOWN, 'verified-at': UNKNOWN, policy: UNKNOWN, fairness: UNKNOWN })
    const c = node('coordinator1').data!
    expect(facts({}, c).fairness).toBe(UNKNOWN) // no wants or leases reported
    expect(facts({}, { ...c, postgres_connected: undefined as unknown as boolean }).postgres).toBe(UNKNOWN)
  })
  it('fairness is n/a, not unknown, when it is reported but undefined (fewer than two buildings want power)', () => {
    const c = node('coordinator1').data!
    expect(facts({}, { ...c, wants: [{ building_id: 'a', amps: 30 }], leases: [] }).fairness).toBe('n/a')
  })
  it('stale data says the majority is unknown and the feed is lost', () => {
    const c = node('coordinator1').data!
    expect(facts({ stale: true }, c)).toMatchObject({ majority: UNKNOWN, feed: 'Lost' })
    expect(facts({ total: 0, reachable: 0 }, c).reachable).toBe(UNKNOWN)
  })
})

import { describe, expect, it } from 'vitest'
import type { Building, Source } from '../data'
import { deliverySummary, gatewayDelivery } from './delivery'

const building = (patch: Partial<Building> = {}): Source<Building> => ({ id: 'hamra', online: true, data: {
  building_id: 'hamra', name: 'Hamra', meter_count: 10, demand_amps: 20, served_amps: 0,
  granted_amps: 0, lease_remaining_ms: 0, lease_version: 3, state: 'expired', mqtt_connected: true,
  pending_readings: 0, dropped_readings: 0, readings_total: 10, last_error: '', ...patch,
} })
const input = (buildings = [building(), building(), building()]) => ({ fresh: true, quorum: false, reachable: 1, totalNodes: 3, buildings })

describe('reported delivery during majority loss', () => {
  it('reports expired delivery independently of retained ledger reservations', () => {
    const summary = deliverySummary(input())
    expect(summary.state).toBe('stopped')
    expect(summary.title).toContain('delivery stopped after leases expired')
    expect(summary.heldNote).toContain('Release requires a coordinator majority')
    expect(summary.recovery).toContain('Start at least one stopped coordinator')
  })
  it('keeps a usable grant usable even when demand and service are zero', () => {
    const b = building({ granted_amps: 20, lease_remaining_ms: 1500, served_amps: 0, demand_amps: 0, state: 'active' })
    expect(gatewayDelivery(b, true)).toBe('usable')
    expect(deliverySummary(input([b])).title).toContain('existing grants expire shortly')
  })
  it('uses the reported grant rather than a reservation or local countdown', () => {
    expect(gatewayDelivery(building({ granted_amps: 20, lease_remaining_ms: 0 }), true)).toBe('unknown')
    expect(gatewayDelivery(building({ served_amps: 21, granted_amps: 20, lease_remaining_ms: 500 }), true)).toBe('unknown')
  })
  it('does not claim all delivery stopped when one gateway is missing', () => {
    const s = deliverySummary(input([building(), { id: 'missing', online: false }]))
    expect(s.state).toBe('unknown')
    expect(s.reporting).toBe(1)
    expect(s.title).toContain('status incomplete')
  })
  it('treats stale, nonfinite and negative readings as unknown', () => {
    expect(gatewayDelivery(building(), false)).toBe('unknown')
    for (const value of [NaN, Infinity, -1]) expect(gatewayDelivery(building({ served_amps: value }), true)).toBe('unknown')
    expect(gatewayDelivery(building({ demand_amps: NaN }), true)).toBe('unknown')
    expect(deliverySummary({ ...input(), fresh: false }).paused).toBe(false)
  })
  it('does not call a waiting gateway an expired lease', () => {
    const s = deliverySummary(input([building({ state: 'waiting' })]))
    expect(s.allExpired).toBe(false)
    expect(s.serviceLabel).toBe('No valid grant — no service')
  })
  it('distinguishes reachable majority from a verified leader', () => {
    const s = deliverySummary({ ...input(), reachable: 2 })
    expect(s.title).toContain('Majority not verified')
    expect(s.recovery).toContain('Wait for a verified leader')
  })
  it('does not claim grants recovered as soon as quorum returns', () => {
    const s = deliverySummary({ ...input(), quorum: true, reachable: 3 })
    expect(s.paused).toBe(false)
    expect(s.state).toBe('stopped')
    expect(s.heldNote).toContain('safe reclamation commits')
  })
})

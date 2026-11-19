import { describe, expect, it } from 'vitest'
import type { Building, GatewayRole, Source } from '../data'
import { activeSource, activeSources, deployed, gatewayState, isRunning, pairView, shortSession } from './standby-logic'

const gw = (id: string, role?: GatewayRole, extra: Partial<Building> = {}): Source<Building> => ({ id, online: true, data: { building_id: id, name: id, meter_count: 16, demand_amps: 20, served_amps: role === 'serving' ? 20 : 0, granted_amps: role === 'serving' ? 24 : 0, lease_remaining_ms: role === 'serving' ? 9000 : 0, lease_version: 3, state: role === 'serving' ? 'active' : 'waiting', mqtt_connected: true, pending_readings: 0, dropped_readings: 0, readings_total: 10, last_error: '', ...(role ? { role } : {}), ...extra } })
const down = (id: string): Source<Building> => ({ id, online: false, error: 'connection refused' })

describe('deployed', () => {
  it('is false for an absent, null or empty standbys list and true for a list with sources', () => {
    expect(deployed(undefined)).toBe(false); expect(deployed(null)).toBe(false); expect(deployed([])).toBe(false)
    expect(deployed([gw('hamra', 'standby')])).toBe(true)
  })
})

describe('gatewayState', () => {
  it('reports the role of a fresh, reachable gateway', () => {
    for (const role of ['serving', 'standby', 'waiting'] as const) expect(gatewayState(gw('hamra', role), true)).toBe(role)
  })
  it('says stopped for an unreachable gateway and unknown for a missing source, a missing or unrecognised role and stale data', () => {
    expect(gatewayState(down('hamra'), true)).toBe('stopped')
    expect(gatewayState(undefined, true)).toBe('unknown')
    expect(gatewayState(gw('hamra'), true)).toBe('unknown')
    expect(gatewayState({ id: 'hamra', online: true }, true)).toBe('unknown')
    expect(gatewayState(gw('hamra', 'leader' as GatewayRole), true)).toBe('unknown')
    expect(gatewayState(gw('hamra', 'serving'), false)).toBe('unknown')
    expect(gatewayState(down('hamra'), false)).toBe('unknown')
  })
  it('counts serving, standby and waiting as running', () => {
    expect(['serving', 'standby', 'waiting', 'stopped', 'unknown', undefined].map(s => isRunning(s as never))).toEqual([true, true, true, false, false, false])
  })
})

describe('pairView', () => {
  it('healthy: the primary serves and the standby is ready', () => {
    const v = pairView(gw('hamra', 'serving'), gw('hamra', 'standby'), true)
    expect(v).toMatchObject({ serving: 'primary', headline: 'Primary serving', tone: 'ok', takeover: false })
    expect(v.primary).toMatchObject({ side: 'primary', name: 'Primary', state: 'serving', word: 'Serving', tone: 'ok', online: true })
    expect(v.standby).toMatchObject({ side: 'standby', name: 'Standby', state: 'standby', word: 'Standby ready', tone: 'ok', online: true })
  })
  it('takeover: the primary is stopped and the standby serves', () => {
    const v = pairView(down('hamra'), gw('hamra', 'serving'), true)
    expect(v).toMatchObject({ serving: 'standby', headline: 'Served by standby', takeover: true })
    expect(v.primary).toMatchObject({ state: 'stopped', word: 'Stopped', online: false })
    expect(v.standby).toMatchObject({ state: 'serving', word: 'Serving' })
    expect(v.detail).toMatch(/Starting it makes it the standby/)
  })
  it('after the primary restarts it stands by and does not take the building back', () => {
    const v = pairView(gw('hamra', 'standby'), gw('hamra', 'serving'), true)
    expect(v).toMatchObject({ serving: 'standby', takeover: true })
    expect(v.primary).toMatchObject({ state: 'standby', word: 'Standby ready' })
    expect(v.detail).toMatch(/stays on standby/)
  })
  it('the gap: the primary stopped and the standby has not yet been granted the building', () => {
    const v = pairView(down('hamra'), gw('hamra', 'standby'), true)
    expect(v).toMatchObject({ serving: 'none', headline: 'No gateway serving', tone: 'warn', takeover: false })
    expect(v.detail).toMatch(/takes over when the lease lapses/)
  })
  it('nothing can serve when both gateways are stopped, and that is a fault', () => {
    expect(pairView(down('hamra'), down('hamra'), true)).toMatchObject({ serving: 'none', tone: 'fault', headline: 'No gateway serving' })
  })
  it('starting up is not a failure to explain away: waiting gateways give a warning, not a claim', () => {
    expect(pairView(gw('hamra', 'waiting'), gw('hamra', 'waiting'), true)).toMatchObject({ serving: 'none', tone: 'warn' })
    expect(pairView(down('hamra'), gw('hamra', 'waiting'), true)).toMatchObject({ serving: 'none', tone: 'warn' })
  })
  it('the primary serves but the standby is not ready: says so', () => {
    for (const standby of [down('hamra'), gw('hamra', 'waiting'), undefined]) {
      const v = pairView(gw('hamra', 'serving'), standby, true)
      expect(v.serving).toBe('primary'); expect(v.detail).toMatch(/No standby is ready/)
    }
    expect(pairView(gw('hamra', 'serving'), undefined, true).standby).toMatchObject({ state: 'unknown', word: 'Unknown', online: false })
  })
  it('never guesses: stale data, a missing or role-less report is unknown', () => {
    const stale = pairView(gw('hamra', 'serving'), gw('hamra', 'standby'), false)
    expect(stale).toMatchObject({ serving: 'unknown', headline: 'Gateway status unknown', takeover: false, tone: 'off' })
    expect(stale.primary.state).toBe('unknown'); expect(stale.standby.state).toBe('unknown')
    expect(pairView(undefined, undefined, true).serving).toBe('unknown')
    expect(pairView(gw('hamra'), gw('hamra', 'standby'), true).serving).toBe('unknown')
    expect(pairView(down('hamra'), undefined, true).serving).toBe('unknown')
  })
  it('two gateways both claiming to serve is shown as a fault and is not assigned to either', () => {
    const v = pairView(gw('hamra', 'serving'), gw('hamra', 'serving'), true)
    expect(v).toMatchObject({ serving: 'unknown', tone: 'fault', headline: 'Both report serving', takeover: false })
  })
  it('every state has a word and a tone, so each status is a symbol plus a word', () => {
    const states: Source<Building>[] = [gw('h', 'serving'), gw('h', 'standby'), gw('h', 'waiting'), down('h'), gw('h')]
    for (const a of states) for (const b of states) {
      const v = pairView(a, b, true)
      for (const g of [v.primary, v.standby]) { expect(g.word).not.toBe(''); expect(['ok', 'warn', 'fault', 'off']).toContain(g.tone) }
      expect(v.headline).not.toBe(''); expect(v.detail).not.toBe('')
      expect(v.takeover).toBe(v.serving === 'standby')
    }
  })
})

describe('activeSource and activeSources', () => {
  const primaries = [gw('hamra', 'serving'), gw('mar_mikhael', 'serving'), gw('achrafieh', 'serving')]
  it('returns the primaries themselves when no standbys are deployed', () => {
    expect(activeSources(primaries, undefined, true)).toBe(primaries)
    expect(activeSources(primaries, [], true)).toBe(primaries)
  })
  it('uses the standby only for the building it serves', () => {
    const standbys = [gw('hamra', 'serving'), gw('mar_mikhael', 'standby'), gw('achrafieh', 'standby')]
    const out = activeSources([down('hamra'), primaries[1], primaries[2]], standbys, true)
    expect(out[0]).toBe(standbys[0]); expect(out[1]).toBe(primaries[1]); expect(out[2]).toBe(primaries[2])
  })
  it('keeps the primary when nobody serves or the data is stale', () => {
    const p = down('hamra'), s = gw('hamra', 'standby')
    expect(activeSource(p, s, pairView(p, s, true))).toBe(p)
    const live = gw('hamra', 'serving'), standby = gw('hamra', 'serving')
    expect(activeSources([p], [standby], false)[0]).toBe(p)
    expect(activeSource(live, standby, pairView(live, standby, true))).toBe(live)
  })
})

describe('shortSession', () => {
  it('shows the first eight characters and an em dash when there is none', () => {
    expect(shortSession('9f1c2ab4-0d3e-4a55-8b21-77c0de12aa90')).toBe('9f1c2ab4')
    expect(shortSession('')).toBe('—'); expect(shortSession(undefined)).toBe('—')
  })
})

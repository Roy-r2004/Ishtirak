import { describe, expect, it } from 'vitest'
import { CLUSTER_SIZE, THEME_KEY, breakerText, clusterGeometry, feederStatus, lineWeight, nodeStatus, parseTheme, readTheme, saveTheme, themeAttribute, toggleArm, voteSummary, wireState } from './console-logic'

describe('line weight encodes amps', () => {
  it('runs from 2 px at no load to 8 px at the full rating', () => {
    expect(lineWeight(0, 120)).toBe(2)
    expect(lineWeight(60, 120)).toBe(5)
    expect(lineWeight(120, 120)).toBe(8)
  })
  it('never draws thicker than the rating and rises monotonically', () => {
    expect(lineWeight(500, 120)).toBe(8)
    let last = 0
    for (let a = 0; a <= 120; a += 10) { const w = lineWeight(a, 120); expect(w).toBeGreaterThanOrEqual(last); last = w }
  })
  it('an unknown or invalid value is a 1 px hairline, not a guess', () => {
    for (const v of [null, undefined, Number.NaN, -3]) expect(lineWeight(v as number, 120)).toBe(1)
    expect(lineWeight(40, 0)).toBe(1)
    expect(lineWeight(40, null)).toBe(1)
  })
})

describe('status marks always carry words', () => {
  it('maps a feeder to the label and tone the board prints', () => {
    expect(feederStatus({ online: true, stale: false, state: 'active' })).toEqual({ label: 'Within budget', tone: 'ok' })
    expect(feederStatus({ online: true, stale: false, state: 'limited' })).toEqual({ label: 'Demand limited', tone: 'warn' })
    expect(feederStatus({ online: true, stale: false, state: 'expired' })).toEqual({ label: 'Lease expired', tone: 'fault' })
    expect(feederStatus({ online: true, stale: false, state: 'waiting' })).toEqual({ label: 'Awaiting capacity', tone: 'warn' })
    expect(feederStatus({ online: true, stale: false })).toEqual({ label: 'Awaiting capacity', tone: 'warn' })
  })
  it('offline and stale win over whatever state was last reported', () => {
    expect(feederStatus({ online: false, stale: false, state: 'active' })).toEqual({ label: 'Offline', tone: 'off' })
    expect(feederStatus({ online: true, stale: true, state: 'active' })).toEqual({ label: 'Stale', tone: 'warn' })
    expect(feederStatus({ online: false, stale: true, state: 'active' }).label).toBe('Offline')
  })
  it('marks coordinators by role and never calls stale data live', () => {
    expect(nodeStatus('Leader', false)).toEqual({ label: 'Leader', tone: 'ok' })
    expect(nodeStatus('Follower', false)).toEqual({ label: 'Follower', tone: 'off' })
    expect(nodeStatus('Candidate', false)).toEqual({ label: 'Candidate', tone: 'warn' })
    expect(nodeStatus('Unreachable', false)).toEqual({ label: 'Unreachable', tone: 'fault' })
    expect(nodeStatus('Leader', true)).toEqual({ label: 'Last seen', tone: 'off' })
    expect(nodeStatus('Unreachable', true).label).toBe('Unreachable')
    expect(nodeStatus('', false).label).toBe('Follower')
  })
  it('a wire is energised only with a live gateway, fresh data and reserved amps', () => {
    expect(wireState({ online: true, stale: false, reserved: 31 })).toBe('energised')
    expect(wireState({ online: true, stale: false, reserved: 0 })).toBe('idle')
    expect(wireState({ online: false, stale: false, reserved: 31 })).toBe('idle')
    expect(wireState({ online: true, stale: true, reserved: 31 })).toBe('unknown')
    expect(wireState({ online: true, stale: false, reserved: null })).toBe('unknown')
  })
  it('names the breaker position', () => {
    expect(breakerText(true)).toBe('Closed')
    expect(breakerText(false)).toBe('Open')
  })
})

describe('vote indicator', () => {
  it('says verified, paused or unknown in words', () => {
    expect(voteSummary({ stale: false, quorum: true, reachable: 3, total: 3 })).toMatchObject({ label: 'Majority verified', tone: 'ok', detail: '3 of 3 coordinators reachable.' })
    expect(voteSummary({ stale: false, quorum: false, reachable: 1, total: 3 })).toMatchObject({ label: 'No majority', tone: 'fault' })
    expect(voteSummary({ stale: false, quorum: false, reachable: 1, total: 3 }).detail).toContain('New grants are paused')
    expect(voteSummary({ stale: true, quorum: true, reachable: 3, total: 3 })).toMatchObject({ label: 'No fresh data', tone: 'warn' })
  })
})

describe('cluster drawing', () => {
  const g = clusterGeometry(['coordinator1', 'coordinator2', 'coordinator3'])
  it('places three distinct nodes inside the drawing box', () => {
    expect(g.nodes).toHaveLength(3)
    expect(new Set(g.nodes.map(n => `${n.x},${n.y}`)).size).toBe(3)
    for (const n of g.nodes) { expect(n.x).toBeGreaterThan(0); expect(n.y).toBeGreaterThan(0); expect(n.y).toBeLessThan(CLUSTER_SIZE.height) }
  })
  it('links every pair of coordinators exactly once', () => {
    const pairs = g.links.map(l => [l.from, l.to].sort().join('|')).sort()
    expect(pairs).toEqual(['coordinator1|coordinator2', 'coordinator1|coordinator3', 'coordinator2|coordinator3'])
    for (const l of g.links) expect(l.path).toMatch(/^M[\d. -]+[VC]/)
  })
  it('keeps the outer arc to the left of the column so it crosses no node', () => {
    const arc = g.links.find(l => l.from === 'coordinator1' && l.to === 'coordinator3')!
    const xs = [...arc.path.matchAll(/-?\d+(?:\.\d+)? /g)].map(m => Number(m[0]))
    expect(Math.min(...xs)).toBeLessThan(g.nodes[0].x)
  })
  it('copes with fewer than three coordinators', () => {
    expect(clusterGeometry(['a', 'b']).links).toHaveLength(1)
    expect(clusterGeometry([]).nodes).toEqual([])
  })
})

describe('theme', () => {
  it('accepts only light and dark, everything else follows the system', () => {
    expect(parseTheme('light')).toBe('light')
    expect(parseTheme('dark')).toBe('dark')
    for (const v of ['auto', 'blue', '', null, undefined, 3]) expect(parseTheme(v)).toBe('auto')
  })
  it('auto removes the data-theme attribute', () => {
    expect(themeAttribute('auto')).toBeNull()
    expect(themeAttribute('dark')).toBe('dark')
    expect(themeAttribute('light')).toBe('light')
  })
  it('survives a missing or throwing store', () => {
    expect(readTheme(null)).toBe('auto')
    expect(readTheme(undefined)).toBe('auto')
    expect(readTheme({ getItem: () => { throw new Error('blocked') } })).toBe('auto')
    expect(() => saveTheme({ setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } }, 'dark')).not.toThrow()
  })
  it('stores a choice and forgets it for auto', () => {
    const data = new Map<string, string>()
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) }
    saveTheme(store, 'dark')
    expect(data.get(THEME_KEY)).toBe('dark')
    expect(readTheme(store)).toBe('dark')
    saveTheme(store, 'auto')
    expect(data.has(THEME_KEY)).toBe(false)
    expect(readTheme(store)).toBe('auto')
  })
})

describe('two-step confirmation', () => {
  it('arms, disarms on a second press, and replaces another armed key', () => {
    expect(toggleArm(null, 'a')).toBe('a')
    expect(toggleArm('a', 'a')).toBeNull()
    expect(toggleArm('a', 'b')).toBe('b')
  })
})

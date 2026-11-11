import { describe, expect, it } from 'vitest'
import { OVERRUN, SPRING, SWEEP_DEG, angleToValue, arcPath, buildTicks, clampToScale, describeReading, pegged, polar, scaleStop, springStep, valueToAngle, type Spring } from './dial'
import { emptyPeak, trackPeak, type PeakSample, type PeakState } from './peak'
import { describeTiers, tierSegments, tiersOf } from './tiers'
import { nearestIndex, niceMax, scale, tracePath, visibleSamples, yTicks } from './chart-math'
import { proof, type Observation } from '../lab/scenarios'
import { describeNotice } from './copy'

describe('dial geometry', () => {
  it('maps 0 A and the mechanical stop to the ends of the sweep and rises monotonically', () => {
    expect(valueToAngle(0, 120)).toBeCloseTo(-SWEEP_DEG / 2)
    expect(valueToAngle(scaleStop(120), 120)).toBeCloseTo(SWEEP_DEG / 2)
    let last = -Infinity
    for (let v = 0; v <= 132; v += 3) { const a = valueToAngle(v, 120); expect(a).toBeGreaterThan(last); last = a }
  })
  it('puts the capacity line on the red arc: past the middle of the sweep but before the stop', () => {
    const a = valueToAngle(120, 120)
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThan(SWEEP_DEG / 2)
    expect(scaleStop(120)).toBeCloseTo(120 * OVERRUN)
  })
  it('round-trips value and angle and clamps what the scale cannot show', () => {
    for (const v of [0, 7, 77, 120, 131]) expect(angleToValue(valueToAngle(v, 120), 120)).toBeCloseTo(v, 6)
    expect(valueToAngle(-5, 120)).toBeCloseTo(valueToAngle(0, 120))
    expect(valueToAngle(500, 120)).toBeCloseTo(SWEEP_DEG / 2)
    expect(clampToScale(Number.NaN, 120)).toBe(0)
    expect(pegged(140, 120)).toBe(true)
    expect(pegged(120, 120)).toBe(false)
  })
  it('falls back to 120 A when the capacity is unknown', () => {
    expect(scaleStop(0)).toBeCloseTo(132)
    expect(scaleStop(Number.NaN)).toBeCloseTo(132)
  })
  it('builds a tick every 2 A, a longer one every 10 A and numerals every 20 A, ending at the limit', () => {
    const ticks = buildTicks(120)
    expect(ticks).toHaveLength(61)
    expect(ticks.filter(t => t.kind !== 'minor')).toHaveLength(13)
    expect(ticks.filter(t => t.label !== undefined).map(t => t.label)).toEqual(['0', '20', '40', '60', '80', '100', '120'])
    expect(ticks.at(-1)?.value).toBe(120)
    expect(ticks.find(t => t.value === 10)?.kind).toBe('mid')
    expect(ticks.find(t => t.value === 4)?.kind).toBe('minor')
  })
  it('places points on the circle: up is 0 degrees, clockwise is positive', () => {
    expect(polar(100, 100, 50, 0)).toEqual({ x: 100, y: 50 })
    const right = polar(100, 100, 50, 90)
    expect(right.x).toBeCloseTo(150); expect(right.y).toBeCloseTo(100)
    expect(arcPath(100, 100, 50, -30, 30)).toMatch(/^M[\d.]+ [\d.]+A50 50 0 0 1 [\d.]+ [\d.]+$/)
  })
})

describe('needle spring', () => {
  const settle = (from: Spring, target: number, seconds: number) => { let s = from; for (let t = 0; t < seconds; t += 1 / 60) s = springStep(s, target, 1 / 60); return s }
  it('converges on the target and stops there', () => {
    const s = settle({ pos: 0, vel: 0 }, 60, 3)
    expect(s.pos).toBe(60); expect(s.vel).toBe(0)
  })
  it('overshoots only a little (damped, not a ringing needle)', () => {
    let s: Spring = { pos: 0, vel: 0 }, max = 0
    for (let t = 0; t < 3; t += 1 / 60) { s = springStep(s, 100, 1 / 60); max = Math.max(max, s.pos) }
    expect(max).toBeLessThan(103)
  })
  it('stays finite for a long frame, a zero frame and bad input', () => {
    expect(Number.isFinite(springStep({ pos: 0, vel: 0 }, 100, 60).pos)).toBe(true)
    expect(springStep({ pos: 5, vel: 0 }, 9, 0)).toEqual({ pos: 5, vel: 0 })
    const recovered = springStep({ pos: Number.NaN, vel: Number.NaN }, 10, 0.016) // a corrupt state restarts from rest at 0 A
    expect(Number.isFinite(recovered.pos) && Number.isFinite(recovered.vel)).toBe(true)
    expect(recovered.pos).toBeGreaterThanOrEqual(0); expect(recovered.pos).toBeLessThan(10)
    expect(springStep({ pos: 3, vel: 1 }, Number.NaN, 0.016)).toEqual({ pos: 3, vel: 1 })
  })
  it('is slower than an undamped snap but settles within about a second', () => {
    expect(springStep({ pos: 0, vel: 0 }, 100, 1 / 60).pos).toBeLessThan(5)
    const s = settle({ pos: 0, vel: 0 }, 100, 1.2)
    expect(Math.abs(s.pos - 100)).toBeLessThan(1)
    expect(SPRING.zeta).toBeLessThan(1)
  })
})

describe('describeReading', () => {
  it('says the value, the peak and the limit in words', () => {
    expect(describeReading({ value: 77, capacity: 120, peak: 81, fresh: true, violations: 0 })).toBe('77 of 120 amps reserved. Peak since the board opened: 81 amps. The capacity limit has not been exceeded.')
    expect(describeReading({ value: 124, capacity: 120, peak: 124, fresh: true, violations: 2 })).toContain('Limit exceeded in 2 samples.')
  })
  it('never presents stale data as live', () => {
    const text = describeReading({ value: 77, capacity: 120, peak: 81, fresh: false, violations: 0 })
    expect(text).toMatch(/^No fresh data\. The needle is parked/)
    expect(text).toContain('last reading, 77 of 120 amps')
    expect(describeReading({ value: null, capacity: null, peak: null, fresh: false, violations: 0 })).toBe('No fresh data. The needle is parked.')
  })
})

describe('peak needle tracker', () => {
  const feed = (samples: PeakSample[], from: PeakState = emptyPeak) => samples.reduce(trackPeak, from)
  const s = (at: number, granted: number, fresh = true, capacity = 120): PeakSample => ({ at, granted, fresh, capacity })
  it('starts empty: no peak is claimed before a fresh sample', () => {
    expect(emptyPeak.peak).toBeNull()
    expect(feed([s(1, 50, false)])).toBe(emptyPeak)
  })
  it('holds the highest fresh value and never moves down', () => {
    const state = feed([s(1, 40), s(2, 81), s(3, 20)])
    expect(state.peak).toBe(81); expect(state.samples).toBe(3); expect(state.since).toBe(1); expect(state.violations).toBe(0)
  })
  it('ignores stale and malformed samples, even large ones', () => {
    const state = feed([s(1, 30), s(2, 119, false), s(3, Number.NaN), s(4, -4), s(5, 30, true, Number.NaN)])
    expect(state.peak).toBe(30); expect(state.samples).toBe(1)
  })
  it('counts every fresh sample above capacity as a violation and keeps the peak above the line', () => {
    const state = feed([s(1, 119), s(2, 124), s(3, 121), s(4, 120)])
    expect(state.violations).toBe(2); expect(state.peak).toBe(124); expect(state.capacity).toBe(120)
  })
  it('agrees with the capacity proof computed over the same observations', () => {
    const history: Observation[] = [30, 60, 130, 90, 120].map((granted, i) => ({ at: i, leader: 'coordinator1', nodesUp: [], buildingsUp: [], granted, capacity: 120, quorum: true, stale: i === 3 }))
    const p = proof(history)
    const state = feed(history.map(o => ({ at: o.at, fresh: !o.stale, granted: o.granted, capacity: o.capacity })))
    expect([state.peak, state.violations, state.samples, state.since]).toEqual([p.peak, p.violations, p.samples, p.observedSince])
  })
})

describe('tier steps', () => {
  it('reads a lease without tiers as one tier', () => {
    expect(tiersOf({ building_id: 'a', amps: 30, version: 4 })).toEqual([{ version: 4, amps: 30 }])
    expect(tiersOf(null)).toEqual([])
    expect(tiersOf({ building_id: 'a', amps: 0, version: 1 })).toEqual([])
  })
  it('keeps falling tiers and drops anything that does not fall', () => {
    const lease = { building_id: 'a', amps: 107, version: 9, tiers: [{ version: 1, amps: 107 }, { version: 2, amps: 107 }, { version: 3, amps: 26 }, { version: 4, amps: Number.NaN }] }
    expect(tiersOf(lease)).toEqual([{ version: 1, amps: 107 }, { version: 3, amps: 26 }])
  })
  it('draws a floor under the newest tier and one step per older tier, so the bar shortens as tiers expire', () => {
    const tiers = [{ version: 1, amps: 100 }, { version: 2, amps: 60 }, { version: 3, amps: 20 }]
    expect(tierSegments(tiers)).toEqual([
      { lo: 0, hi: 20, version: 3, role: 'floor' },
      { lo: 20, hi: 60, version: 2, role: 'step' },
      { lo: 60, hi: 100, version: 1, role: 'step' },
    ])
    // the oldest tier expires: the top step disappears and the bar's end moves down
    expect(tierSegments(tiers.slice(1)).at(-1)?.hi).toBe(60)
    expect(tierSegments([{ version: 5, amps: 40 }])).toEqual([{ lo: 0, hi: 40, version: 5, role: 'floor' }])
    expect(tierSegments([])).toEqual([])
  })
  it('describes the decay in words', () => {
    expect(describeTiers([{ version: 1, amps: 100 }, { version: 2, amps: 20 }])).toBe('2 tiers, 100 amps, then 20 amps. The reservation falls to 20 amps as older tiers expire.')
    expect(describeTiers([{ version: 1, amps: 31 }])).toBe('One reservation of 31 amps.')
    expect(describeTiers([])).toBe('No reservation.')
  })
})

describe('chart recorder maths', () => {
  const p = (at: number, v = 10) => ({ at, demand: v, served: v, granted: v })
  it('keeps real finite samples in time order and honours the range', () => {
    const points = [p(3), p(1), { at: 2, demand: Number.NaN, served: 1, granted: 1 }, p(4)]
    expect(visibleSamples(points, 90).map(x => x.at)).toEqual([1, 3, 4])
    expect(visibleSamples(Array.from({ length: 120 }, (_, i) => p(i)), 30)).toHaveLength(30)
    expect(visibleSamples(Array.from({ length: 120 }, (_, i) => p(i)), 90)).toHaveLength(90)
    expect(visibleSamples([], 30)).toEqual([])
  })
  it('chooses an axis that clears the data and the capacity line', () => {
    expect(niceMax([77, 81], 120)).toBe(140)
    expect(niceMax([], null)).toBe(20)
    expect(niceMax([190], 120)).toBe(200)
    expect(yTicks(140)).toEqual([0, 20, 40, 60, 80, 100, 120, 140])
  })
  it('scales and traces', () => {
    expect(scale(5, 0, 10, 0, 100)).toBe(50)
    expect(scale(5, 5, 5, 0, 100)).toBe(50)
    expect(tracePath([0, 10], [5, 7])).toBe('M0 5L10 7')
    expect(tracePath([0, 10], [5, 7], true)).toBe('M0 5H10V7')
    expect(tracePath([], [])).toBe('')
    expect(nearestIndex([0, 10, 20], 12)).toBe(1)
    expect(nearestIndex([], 5)).toBe(-1)
  })
})

describe('notice copy', () => {
  it('says what happened to what', () => {
    expect(describeNotice('stop coordinator1 completed.')).toBe('Stopped coordinator 1.')
    expect(describeNotice('start gateway-mar-mikhael completed.')).toBe('Started the Mar Mikhael gateway.')
    expect(describeNotice('stop postgres completed.')).toBe('Stopped the database.')
    expect(describeNotice('start mosquitto completed.')).toBe('Started the MQTT broker.')
  })
  it('only capitalises anything it does not recognise', () => {
    expect(describeNotice('Simulation updated. Live readings will follow.')).toBe('Simulation updated. Live readings will follow.')
    expect(describeNotice('action failed: nope')).toBe('Action failed: nope')
    expect(describeNotice('')).toBe('')
  })
})

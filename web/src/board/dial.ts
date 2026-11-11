/**
 * Geometry and physics of the capacity gauge (a flat half circle). Pure functions: the gauge component only draws what they return.
 * Angles are degrees measured from straight up, clockwise positive; 0 A sits at -SWEEP/2 and the end of the scale at +SWEEP/2.
 */
export const SWEEP_DEG = 180
/** The needle can travel this far past the capacity line before it hits its stop, so a violation would still show on the red arc. */
export const OVERRUN = 1.1

export type Tick = { value: number; angle: number; kind: 'major' | 'mid' | 'minor'; label?: string }
export type Spring = { pos: number; vel: number }

const finite = (n: number) => Number.isFinite(n)
export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** Largest amps the needle can show. */
export const scaleStop = (capacity: number) => (finite(capacity) && capacity > 0 ? capacity : 120) * OVERRUN
/** Amps the needle can honestly show: clamped to the scale, 0 for anything that is not a number. */
export const clampToScale = (value: number, capacity: number) => finite(value) ? clamp(value, 0, scaleStop(capacity)) : 0
/** True when the value lies beyond the stop and the needle can only press against it. */
export const pegged = (value: number, capacity: number) => finite(value) && value > scaleStop(capacity)

export function valueToAngle(value: number, capacity: number): number {
  const stop = scaleStop(capacity)
  return -SWEEP_DEG / 2 + clampToScale(value, capacity) / stop * SWEEP_DEG
}
export function angleToValue(angle: number, capacity: number): number {
  const stop = scaleStop(capacity)
  return clamp((angle + SWEEP_DEG / 2) / SWEEP_DEG, 0, 1) * stop
}

export function polar(cx: number, cy: number, r: number, angle: number): { x: number; y: number } {
  const a = angle * Math.PI / 180
  return { x: cx + r * Math.sin(a), y: cy - r * Math.cos(a) }
}
const fix = (n: number) => Math.round(n * 100) / 100
/** SVG path of an arc on the circle (cx, cy, r) from angle a0 to a1 (clockwise). */
export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p0 = polar(cx, cy, r, a0), p1 = polar(cx, cy, r, a1)
  return `M${fix(p0.x)} ${fix(p0.y)}A${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} ${a1 >= a0 ? 1 : 0} ${fix(p1.x)} ${fix(p1.y)}`
}

/**
 * Ticks of the printed scale: minor every `minor` amps, a longer tick every `major`, numerals every `label`, up to the capacity line.
 * The red arc (capacity to the stop) carries no ticks, only the limit line.
 */
export function buildTicks(capacity: number, minor = 2, major = 10, label = 20): Tick[] {
  const cap = finite(capacity) && capacity > 0 ? capacity : 120, out: Tick[] = []
  for (let value = 0; value <= cap + 1e-9; value += minor) {
    const v = Math.round(value * 1000) / 1000
    const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-9
    const isLabel = isMajor && Math.abs(v / label - Math.round(v / label)) < 1e-9
    out.push({ value: v, angle: valueToAngle(v, cap), kind: isLabel ? 'major' : isMajor ? 'mid' : 'minor', ...(isLabel ? { label: String(v) } : {}) })
  }
  return out
}

/** Moving-coil feel: a damped spring (damping ratio about 0.8, settles in under a second). Sub-stepped so a long frame cannot blow it up. */
export const SPRING = { omega: 9, zeta: 0.8 }
export function springStep(state: Spring, target: number, dtSeconds: number, params = SPRING): Spring {
  let { pos, vel } = state
  if (!finite(pos)) pos = 0
  if (!finite(vel)) vel = 0
  if (!finite(target)) return { pos, vel }
  let left = clamp(finite(dtSeconds) ? dtSeconds : 0, 0, 0.5)
  const h = 1 / 240
  while (left > 1e-9) {
    const dt = Math.min(h, left)
    left -= dt
    vel += (-params.omega * params.omega * (pos - target) - 2 * params.zeta * params.omega * vel) * dt
    pos += vel * dt
  }
  if (Math.abs(pos - target) < 0.004 && Math.abs(vel) < 0.004) return { pos: target, vel: 0 }
  return { pos, vel }
}

/** The reading in words, for screen readers and the dial's text equivalent. */
export function describeReading(o: { value: number | null; capacity: number | null; peak: number | null; fresh: boolean; violations: number }): string {
  const cap = o.capacity, fmt = (n: number) => Math.round(n * 10) / 10
  if (!o.fresh || o.value === null || cap === null) return `No fresh data. The needle is parked${o.value !== null && cap !== null ? ` at the last reading, ${fmt(o.value)} of ${fmt(cap)} amps` : ''}.`
  const peak = o.peak === null ? '' : ` Peak since the board opened: ${fmt(o.peak)} amps.`
  const limit = o.violations > 0 ? ` Limit exceeded in ${o.violations} ${o.violations === 1 ? 'sample' : 'samples'}.` : ' The capacity limit has not been exceeded.'
  return `${fmt(o.value)} of ${fmt(cap)} amps reserved.${peak}${limit}`
}

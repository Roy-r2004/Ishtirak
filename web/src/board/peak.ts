/**
 * The peak needle: highest reserved total in any FRESH sample since the board opened, plus how many fresh samples exceeded
 * the capacity. Stale or malformed samples change nothing; a lower sample never moves the peak down (a drag needle).
 */
export type PeakState = { peak: number | null; capacity: number | null; samples: number; violations: number; since: number | null }
export type PeakSample = { at: number; fresh: boolean; granted: number; capacity: number }
export const emptyPeak: PeakState = { peak: null, capacity: null, samples: 0, violations: 0, since: null }

const ok = (n: number) => Number.isFinite(n) && n >= 0
export function trackPeak(prev: PeakState, s: PeakSample): PeakState {
  if (!s.fresh || !ok(s.granted) || !ok(s.capacity) || !Number.isFinite(s.at)) return prev
  return {
    peak: prev.peak === null ? s.granted : Math.max(prev.peak, s.granted),
    capacity: s.capacity,
    samples: prev.samples + 1,
    violations: prev.violations + (s.granted > s.capacity ? 1 : 0),
    since: prev.since ?? s.at,
  }
}

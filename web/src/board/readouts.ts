import { num, type Building, type Source } from '../data'

/**
 * The three plain figures beside the main dial, all from observations:
 * free = capacity minus the amps reserved in the leader's ledger, served = what the gateways actually deliver,
 * curtailed = requested demand minus served. Nothing is guessed: stale data or a missing source gives null, never 0.
 */
export type CapacityFigures = { free: number | null; served: number | null; curtailed: number | null; reporting: number; total: number }
export type CapacityInput = { fresh: boolean; capacity?: number | null; reserved?: number | null; buildings: (Partial<Source<Building>> & { online: boolean })[] }

const known = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
const tenth = (n: number) => Math.round(n * 10) / 10

export function capacityFigures(input: CapacityInput): CapacityFigures {
  const total = input.buildings.length
  const reporting = input.buildings.flatMap(b => b.online && b.data && known(b.data.served_amps) && known(b.data.demand_amps) ? [b.data] : [])
  if (!input.fresh) return { free: null, served: null, curtailed: null, reporting: reporting.length, total }
  // A reservation above capacity would be a violation; the figure floors at 0 and the Limit exceeded lamp carries the alarm.
  const free = known(input.capacity) && known(input.reserved) ? tenth(Math.max(0, input.capacity - input.reserved)) : null
  if (!reporting.length) return { free, served: null, curtailed: null, reporting: 0, total }
  const served = reporting.reduce((sum, b) => sum + b.served_amps, 0), demand = reporting.reduce((sum, b) => sum + b.demand_amps, 0)
  return { free, served: tenth(served), curtailed: tenth(Math.max(0, demand - served)), reporting: reporting.length, total }
}

/** "43 A", or an em dash when the value is unknown. */
export const amps = (value: number | null) => value === null ? '—' : `${num(value, 1)} A`

/** Empty when every gateway reports; otherwise says how many did, because served and curtailed then cover only those. */
export const coverage = (f: CapacityFigures) => f.total > 0 && f.reporting > 0 && f.reporting < f.total ? `${f.reporting} of ${f.total} gateways reporting` : ''

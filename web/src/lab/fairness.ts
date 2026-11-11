export type Policy = 'fair_share' | 'first_come'
export type Share = { building_id: string; amps: number }
export type MeterConfig = { meter_count: number; demand_factor: number }
export type BuildingShare = { id: string; want: number | null; reserved: number | null; fair: number | null }

export const policyLabel: Record<Policy, string> = { fair_share: 'Fair sharing', first_come: 'First come' }
/** The coordinators report a boolean; anything else (missing key, older build) means the policy is unknown. */
export const policyOf = (fairShare?: boolean | null): Policy | null => typeof fairShare === 'boolean' ? (fairShare ? 'fair_share' : 'first_come') : null

const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
export const sumAmps = (shares?: Share[]) => (shares ?? []).reduce((total, s) => total + (ok(s.amps) ? s.amps : 0), 0)

/**
 * Jain's fairness index (sum x)^2 / (n * sum x^2): 1 when every value is equal, 1/n when one value takes everything.
 * null when it is not defined: fewer than two values, any value that is not a non-negative number, or all values zero.
 */
export function jain(values: number[]): number | null {
  if (values.length < 2 || !values.every(ok)) return null
  const sum = values.reduce((a, b) => a + b, 0), squares = values.reduce((a, b) => a + b * b, 0)
  return squares === 0 ? null : sum * sum / (values.length * squares)
}

/**
 * Jain's index of the reserved (lease) amps across the buildings that currently want power (want > 0).
 * A building with a want but no lease holds 0 A. null ("n/a") when fewer than two buildings want power or nothing is known.
 */
export function fairnessScore(wants?: Share[], reserved?: Share[]): number | null {
  if (!wants || !reserved) return null
  const wanting = wants.filter(w => ok(w.amps) && w.amps > 0)
  if (wanting.length < 2) return null
  return jain(wanting.map(w => reserved.find(r => r.building_id === w.building_id)?.amps ?? 0))
}

/** "46%" for a score, "n/a" when it is undefined. */
export const percent = (score: number | null) => score === null ? 'n/a' : `${Math.round(score * 100)}%`

/** One row per building. A list that was not reported gives null (unknown); a reported list without the building gives 0 for leases and null for wants and fair shares. */
export function shareRows(ids: string[], wants?: Share[], reserved?: Share[], fair?: Share[]): BuildingShare[] {
  const pick = (list: Share[] | undefined, id: string, missing: number | null) => list ? list.find(s => s.building_id === id)?.amps ?? missing : null
  return ids.map(id => ({ id, want: pick(wants, id, null), reserved: pick(reserved, id, 0), fair: pick(fair, id, null) }))
}

/** Common scale for the bars of every building: at least the generator capacity and never smaller than any shown value. */
export const barScale = (rows: BuildingShare[], capacity: number) => Math.max(1, ok(capacity) ? capacity : 0, ...rows.flatMap(r => [r.want, r.reserved, r.fair]).filter(ok))
/** Bar width or marker position as a percentage of the scale, clamped to 0..100. */
export const barPercent = (value: number | null, scale: number) => value === null || !(scale > 0) ? 0 : Math.max(0, Math.min(100, value / scale * 100))

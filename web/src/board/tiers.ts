import type { Lease, Tier } from '../data'

export type TierSegment = { lo: number; hi: number; version: number; role: 'floor' | 'step' }

const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0
/**
 * The tiers of a lease, oldest first with falling amps. A coordinator that omits `tiers` is read as one tier at the lease's amps.
 * Anything that is not a positive number, or is not lower than the tier before it, is dropped (it would be dominated anyway).
 */
export function tiersOf(lease?: Lease | null): Tier[] {
  if (!lease || !ok(lease.amps)) return []
  const given = (lease.tiers ?? []).filter(t => ok(t.amps) && Number.isFinite(t.version))
  const list = given.length ? given : [{ version: lease.version, amps: lease.amps }]
  const out: Tier[] = []
  for (const t of list) if (!out.length || t.amps < out[out.length - 1].amps) out.push(t)
  return out
}

/**
 * Segments of the stepped reservation bar, from 0 up to the largest tier. The lowest tier is the floor that outlives every older
 * tier; each higher step is capacity that goes back to the ledger when its tier's hold ends.
 */
export function tierSegments(tiers: Tier[]): TierSegment[] {
  const out: TierSegment[] = []
  for (let i = tiers.length - 1; i >= 0; i--) {
    const lo = i === tiers.length - 1 ? 0 : tiers[i + 1].amps
    out.push({ lo, hi: tiers[i].amps, version: tiers[i].version, role: i === tiers.length - 1 ? 'floor' : 'step' })
  }
  return out
}

export function describeTiers(tiers: Tier[]): string {
  if (!tiers.length) return 'No reservation.'
  if (tiers.length === 1) return `One reservation of ${tiers[0].amps} amps.`
  return `${tiers.length} tiers, ${tiers.map(t => `${t.amps} amps`).join(', then ')}. The reservation falls to ${tiers[tiers.length - 1].amps} amps as older tiers expire.`
}

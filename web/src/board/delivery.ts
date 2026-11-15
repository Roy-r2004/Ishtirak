import type { Building, Source } from '../data'

export type GatewayDelivery = 'usable' | 'stopped' | 'unknown'

const known = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

/** Describe reported authorization, never infer service from a browser countdown or ledger reservation. */
export function gatewayDelivery(b: Source<Building>, fresh: boolean): GatewayDelivery {
  const d = b.data
  if (!fresh || !b.online || !d || ![d.granted_amps, d.lease_remaining_ms, d.served_amps, d.demand_amps].every(known)) return 'unknown'
  if (d.granted_amps > 0 && d.lease_remaining_ms > 0 && d.served_amps <= d.granted_amps) return 'usable'
  if (d.granted_amps === 0 && d.lease_remaining_ms === 0 && d.served_amps === 0) return 'stopped'
  return 'unknown'
}

export type DeliveryInput = { fresh: boolean; quorum: boolean; reachable: number; totalNodes: number; buildings: Source<Building>[] }

export function deliverySummary(i: DeliveryInput) {
  const states = i.buildings.map(b => gatewayDelivery(b, i.fresh))
  const reporting = states.filter(s => s !== 'unknown').length, total = states.length
  const complete = total > 0 && reporting === total
  const state: GatewayDelivery = !complete ? 'unknown' : states.some(s => s === 'usable') ? 'usable' : 'stopped'
  const allExpired = state === 'stopped' && i.buildings.every(b => b.data?.state === 'expired')
  const paused = i.fresh && !i.quorum
  const majority = Math.floor(i.totalNodes / 2) + 1
  const missing = Math.max(0, majority - i.reachable)
  const cause = i.reachable < majority ? 'No majority' : 'Majority not verified'
  const title = state === 'stopped'
    ? `${cause} — delivery stopped${allExpired ? ' after leases expired' : '; no valid grants reported'}.`
    : state === 'usable' ? `${cause} — existing grants expire shortly.`
      : `${cause} — delivery status incomplete.`
  const recovery = missing > 0
    ? `Start at least ${missing === 1 ? 'one' : missing} stopped coordinator${missing === 1 ? '' : 's'} to restore a majority.`
    : 'Wait for a verified leader. Check coordinator connectivity if this persists.'
  const detail = `${i.reachable} of ${i.totalNodes} coordinators reachable; a majority needs ${majority}. New grants and renewals are paused.`
  const serviceLabel = state === 'unknown' ? 'Delivery status incomplete' : state === 'stopped'
    ? allExpired ? 'Lease expired — no service' : 'No valid grant — no service'
    : paused ? 'Existing grants still usable' : 'Valid gateway grants'
  const heldNote = paused
    ? 'Capacity held in ledger. Release requires a coordinator majority; this is not current delivery.'
    : 'Capacity held in ledger protects grants until safe reclamation commits.'
  return { state, allExpired, reporting, total, complete, paused, title, detail, recovery, serviceLabel, heldNote }
}

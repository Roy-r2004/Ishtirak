import { names, type Audit } from '../data'

/** Entry names as the ledger prints them; the stored kind "shrunk" is shown as "Reduced". */
export const kindText = (kind: string) => kind === 'reclaimed' ? 'Reclaimed' : kind === 'shrunk' ? 'Reduced' : kind === 'granted' ? 'Granted' : kind
export const kindFilters = [['all', 'All events'], ['granted', 'Granted'], ['shrunk', 'Reduced'], ['reclaimed', 'Reclaimed']] as const
/** The coordinators replicate the newest 100 events; older history lives in PostgreSQL. */
export const LEDGER_LIMIT = 100

export type LedgerView = { rows: Audit[]; available: number }

/**
 * Audit events newest first, at most `limit` of them, narrowed by kind and by a search over building, event number and entry.
 * `available` is how many events are held before any filter, so a caption can say "3 of 12".
 */
export function filterAudit(events: Audit[] | undefined, query: string, kind: string, limit = LEDGER_LIMIT): LedgerView {
  const newest = [...(events ?? [])].sort((a, b) => b.event_id - a.event_id).slice(0, limit)
  const needle = query.trim().toLowerCase()
  const rows = newest.filter(a => (kind === 'all' || a.kind === kind) && (needle === '' || `${names[a.building_id] ?? a.building_id} ${a.event_id} ${a.kind} ${kindText(a.kind)}`.toLowerCase().includes(needle)))
  return { rows, available: newest.length }
}

/** The caption under the full ledger: how many matching events are shown, and where the rest lives. */
export function ledgerCaption(view: LedgerView, narrowed: boolean): string {
  const noun = (n: number) => `${n} ${n === 1 ? 'event' : 'events'}`
  if (view.available === 0) return 'No events yet. Full history lives in PostgreSQL.'
  const shown = narrowed ? `${noun(view.rows.length)} matching, of ${view.available} held here.` : `${noun(view.rows.length)} shown.`
  return `${shown} Full history lives in PostgreSQL.`
}

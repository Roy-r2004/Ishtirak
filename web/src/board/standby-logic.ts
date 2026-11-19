/**
 * Pure rules for a building's gateway pair: the primary and its standby run the same code, the ledger lets only one gateway session
 * hold the building, and the other idles until the lease lapses. Nothing here guesses: a gateway that was not reported, or reported
 * without a role, is `unknown`, and with no fresh data nothing is claimed about who serves.
 */
import type { Building, GatewayState, Source } from '../data'
import type { Tone } from './console-logic'

export type Side = 'primary' | 'standby'
/** Which gateway of the pair serves the building: `unknown` when it cannot be told from fresh reports. */
export type Serving = 'primary' | 'standby' | 'none' | 'unknown'
export type GatewayView = { side: Side; name: 'Primary' | 'Standby'; state: GatewayState; word: string; tone: Tone; online: boolean }
export type PairView = {
  serving: Serving
  /** The pair in plain words, always with a tone so it is drawn with a symbol. */
  headline: string
  tone: Tone
  /** One sentence for the screen reader and the details drawer. */
  detail: string
  /** The standby serves and the primary does not. */
  takeover: boolean
  primary: GatewayView
  standby: GatewayView
}

/** Backends without standby gateways send no `standbys`; an empty list means the same. */
export const deployed = (standbys: Source<Building>[] | null | undefined): standbys is Source<Building>[] => Array.isArray(standbys) && standbys.length > 0

/** One gateway's state from its source: only a fresh, reachable gateway that reported a known role has a role. */
export function gatewayState(source: Source<Building> | undefined, fresh: boolean): GatewayState {
  if (!fresh || !source) return 'unknown'
  if (!source.online) return 'stopped'
  const role = source.data?.role
  return role === 'serving' || role === 'standby' || role === 'waiting' ? role : 'unknown'
}

const WORDS: Record<GatewayState, { word: string; tone: Tone }> = {
  serving: { word: 'Serving', tone: 'ok' },
  standby: { word: 'Standby ready', tone: 'ok' },
  waiting: { word: 'Waiting', tone: 'warn' },
  stopped: { word: 'Stopped', tone: 'off' },
  unknown: { word: 'Unknown', tone: 'off' },
}
/** Whether a gateway state means the process answers (it may still be waiting). */
export const isRunning = (state: GatewayState | undefined) => state === 'serving' || state === 'standby' || state === 'waiting'

function describe(p: GatewayState, s: GatewayState): Pick<PairView, 'serving' | 'headline' | 'tone' | 'detail'> {
  if (p === 'serving' && s === 'serving') return { serving: 'unknown', headline: 'Both report serving', tone: 'fault', detail: 'One session per building: check the gateways.' }
  if (p === 'serving') return { serving: 'primary', headline: 'Primary serving', tone: 'ok', detail: s === 'standby' ? 'The standby takes over if it stops (12 to 15 s).' : 'No standby is ready. If it stops, nothing serves.' }
  if (s === 'serving') return { serving: 'standby', headline: 'Served by standby', tone: 'ok', detail: p === 'stopped' ? 'Primary stopped. Starting it makes it the standby.' : p === 'standby' ? 'Primary returned as standby and stays on standby.' : 'The primary is not ready to stand by.' }
  if (p === 'unknown' || s === 'unknown') return { serving: 'unknown', headline: 'Gateway status unknown', tone: 'off', detail: 'No fresh report; who serves is unconfirmed.' }
  if (p === 'stopped' && s === 'stopped') return { serving: 'none', headline: 'No gateway serving', tone: 'fault', detail: 'Both gateways are stopped. Nothing can serve.' }
  if (p === 'standby' || s === 'standby') return { serving: 'none', headline: 'No gateway serving', tone: 'warn', detail: 'Standby takes over when the lease lapses.' }
  return { serving: 'none', headline: 'No gateway serving', tone: 'warn', detail: 'Starting up or waiting for a grant.' }
}

/** The pair as the console shows it. A missing standby source is `unknown`, never assumed stopped or absent. */
export function pairView(primary: Source<Building> | undefined, standby: Source<Building> | undefined, fresh: boolean): PairView {
  const p = gatewayState(primary, fresh), s = gatewayState(standby, fresh), d = describe(p, s)
  const view = (side: Side, state: GatewayState, source: Source<Building> | undefined): GatewayView => ({ side, name: side === 'primary' ? 'Primary' : 'Standby', state, ...WORDS[state], online: !!source?.online })
  return { ...d, takeover: d.serving === 'standby', primary: view('primary', p, primary), standby: view('standby', s, standby) }
}

/** The source whose figures describe the building: the standby once it serves, otherwise the primary. */
export const activeSource = (primary: Source<Building>, standby: Source<Building> | undefined, view: PairView): Source<Building> => view.serving === 'standby' && standby ? standby : primary

/** One source per building for totals and delivery: with no standbys these are the primaries themselves. */
export function activeSources(buildings: Source<Building>[], standbys: Source<Building>[] | null | undefined, fresh: boolean): Source<Building>[] {
  if (!deployed(standbys)) return buildings
  return buildings.map(b => { const s = standbys.find(x => x.id === b.id); return activeSource(b, s, pairView(b, s, fresh)) })
}

/** The first eight characters of a session id (the first group of its UUID), or an em dash when none was reported. */
export const shortSession = (id?: string) => id ? id.slice(0, 8) : '—'

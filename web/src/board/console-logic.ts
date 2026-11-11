/**
 * Pure rules of the single-line diagram console: what a line weight means, which status mark a state gets, where the three
 * coordinators are drawn, how the theme is stored. No React, no DOM: the components only draw what these return.
 */

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/**
 * Stroke width in px of a line that carries `amps` out of `capacity`: 2 px at no load up to 8 px at the full rating.
 * An unknown value draws as a 1 px hairline, never as a guess. Reserved amps are also printed beside the line, so the weight is never the only carrier.
 */
export function lineWeight(amps: number | null | undefined, capacity: number | null | undefined): number {
  if (!finite(amps) || !finite(capacity) || capacity <= 0 || amps < 0) return 1
  return Math.round((2 + Math.min(1, amps / capacity) * 6) * 10) / 10
}

export type Tone = 'ok' | 'warn' | 'fault' | 'off'
export type Mark = { label: string; tone: Tone }

/** The feeder's state as words plus a tone. The label is what the old board printed, so tests and screenshots stay comparable. */
export function feederStatus(i: { online: boolean; stale: boolean; state?: string }): Mark {
  if (!i.online) return { label: 'Offline', tone: 'off' }
  if (i.stale) return { label: 'Stale', tone: 'warn' }
  if (i.state === 'active') return { label: 'Within budget', tone: 'ok' }
  if (i.state === 'limited') return { label: 'Demand limited', tone: 'warn' }
  if (i.state === 'expired') return { label: 'Lease expired', tone: 'fault' }
  return { label: 'Awaiting capacity', tone: 'warn' }
}

/** A coordinator's role as words plus a tone: the leader is ok, a follower or candidate is neutral-to-warn, an unreachable one is a fault. */
export function nodeStatus(role: string, stale: boolean): Mark {
  if (role === 'Unreachable') return { label: 'Unreachable', tone: 'fault' }
  if (stale) return { label: 'Last seen', tone: 'off' }
  if (role === 'Leader') return { label: 'Leader', tone: 'ok' }
  if (role === 'Candidate') return { label: 'Candidate', tone: 'warn' }
  return { label: role || 'Follower', tone: 'off' }
}

export type WireState = 'energised' | 'idle' | 'unknown'
/** A feeder line is energised when its gateway is up, the data is fresh and amps are reserved for it. */
export function wireState(i: { online: boolean; stale: boolean; reserved: number | null }): WireState {
  if (i.stale || i.reserved === null) return 'unknown'
  return i.online && i.reserved > 0 ? 'energised' : 'idle'
}

export const breakerText = (closed: boolean) => closed ? 'Closed' : 'Open'

/** The headline of the vote indicator beside the coordinators. */
export function voteSummary(i: { stale: boolean; quorum: boolean; reachable: number; total: number }): Mark & { detail: string } {
  if (i.stale) return { label: 'No fresh data', tone: 'warn', detail: 'The majority cannot be confirmed.' }
  if (i.quorum) return { label: 'Majority verified', tone: 'ok', detail: `${i.reachable} of ${i.total} coordinators reachable.` }
  return { label: 'No majority', tone: 'fault', detail: `${i.reachable} of ${i.total} coordinators reachable. New grants are paused.` }
}

export type ClusterNode = { id: string; x: number; y: number }
export type ClusterLink = { from: string; to: string; path: string }
export const CLUSTER_SIZE = { width: 280, height: 196 }

/**
 * Where the three coordinators sit in the cluster drawing (a 280 x 196 box): a column of three circles with the replication
 * links between every pair, the outer pair joined by an arc that bulges to the left so no link crosses a node.
 */
export function clusterGeometry(ids: string[]): { nodes: ClusterNode[]; links: ClusterLink[] } {
  const x = 50, ys = [32, 98, 164]
  const nodes = ids.slice(0, 3).map((id, i) => ({ id, x, y: ys[i] }))
  const links: ClusterLink[] = []
  for (let i = 0; i < nodes.length - 1; i++) links.push({ from: nodes[i].id, to: nodes[i + 1].id, path: `M${x} ${nodes[i].y + 18}V${nodes[i + 1].y - 18}` })
  if (nodes.length === 3) links.push({ from: nodes[0].id, to: nodes[2].id, path: `M${x - 14} ${nodes[0].y + 12}C${x - 52} ${nodes[0].y + 40} ${x - 52} ${nodes[2].y - 40} ${x - 14} ${nodes[2].y - 12}` })
  return { nodes, links }
}

export type Theme = 'auto' | 'light' | 'dark'
export const THEME_KEY = 'ishtirak-theme'
export const parseTheme = (value: unknown): Theme => value === 'light' || value === 'dark' ? value : 'auto'
/** The data-theme attribute for a theme; null means "remove it and follow the system". */
export const themeAttribute = (theme: Theme): 'light' | 'dark' | null => theme === 'auto' ? null : theme

/** Reads the stored theme without ever throwing (storage can be blocked or missing). */
export function readTheme(storage?: Pick<Storage, 'getItem'> | null): Theme {
  try { return parseTheme(storage?.getItem(THEME_KEY)) } catch { return 'auto' }
}
export function saveTheme(storage: Pick<Storage, 'setItem' | 'removeItem'> | null | undefined, theme: Theme) {
  try { if (theme === 'auto') storage?.removeItem(THEME_KEY); else storage?.setItem(THEME_KEY, theme) } catch { /* a blocked store only means the choice is not remembered */ }
}

/** Two-step confirmation: arming the same key twice disarms it; arming another key replaces the first. */
export type Armed = string | null
export const toggleArm = (current: Armed, key: string): Armed => current === key ? null : key

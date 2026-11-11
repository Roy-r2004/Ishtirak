import { num, time, type NodeData, type Source } from '../data'
import { fairnessScore, percent, policyLabel, type Policy } from '../lab/fairness'

/** Shown wherever the coordinators did not report a value. Nothing is filled in. */
export const UNKNOWN = 'unknown'

export type NodeRow = { id: string; name: string; reachable: string; role: string; raftState: string; leaderId: string; term: string; applied: string; lastLog: string; commit: string; snapshot: string; reserved: string }
export type Fact = { key: string; label: string; value: string }

const word = (v: unknown) => typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : UNKNOWN
const coordinatorName = (id: string) => `Coordinator ${id.replace(/\D/g, '') || id}`

/** One row per coordinator, strings only. An unreachable coordinator has no data, so every observed field is unknown. */
export function nodeRows(nodes: Source<NodeData>[]): NodeRow[] {
  return nodes.map(n => {
    const d = n.online ? n.data : undefined, raft = d?.raft
    const leader = d === undefined ? UNKNOWN : typeof d.leader_id === 'string' ? (d.leader_id === '' ? 'none' : d.leader_id) : UNKNOWN
    return {
      id: n.id, name: coordinatorName(n.id), reachable: n.online ? 'Yes' : 'No',
      role: !n.online ? 'Unreachable' : word(d?.state),
      raftState: word(raft?.state), leaderId: leader,
      term: word(raft?.term), applied: word(raft?.applied_index), lastLog: word(raft?.last_log_index), commit: word(raft?.commit_index), snapshot: word(raft?.last_snapshot_index),
      reserved: typeof d?.granted_amps === 'number' && Number.isFinite(d.granted_amps) ? `${num(d.granted_amps)} A` : UNKNOWN,
    }
  })
}

/** A zero time ("0001-01-01…") or an unparsable value means the coordinator never verified a majority. */
export function verifiedAt(iso?: string): string {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN
  return Number.isFinite(ms) && new Date(ms).getUTCFullYear() >= 2000 ? time(ms) : UNKNOWN
}

export type FactsInput = { stale: boolean; cluster?: NodeData | null; reachable: number; total: number; quorum: boolean; streamLive: boolean; policy: Policy | null }

/** The cluster-wide facts of the old Coordinator cluster page, in reading order. */
export function clusterFacts(i: FactsInput): Fact[] {
  const c = i.cluster
  const fairness = !c || !c.wants || !c.leases ? UNKNOWN : percent(fairnessScore(c.wants, c.leases))
  return [
    { key: 'postgres', label: 'PostgreSQL', value: typeof c?.postgres_connected === 'boolean' ? (c.postgres_connected ? 'Connected' : 'Not connected') : UNKNOWN },
    { key: 'majority', label: 'Majority', value: i.stale || !c ? UNKNOWN : i.quorum ? 'Verified' : 'Not verified' },
    { key: 'verified-at', label: 'Last verified', value: verifiedAt(c?.quorum_verified_at) },
    { key: 'reachable', label: 'Coordinators reachable', value: i.total > 0 ? `${i.reachable} of ${i.total}` : UNKNOWN },
    { key: 'feed', label: 'Live feed', value: i.stale ? 'Lost' : i.streamLive ? 'WebSocket' : 'Polling' },
    { key: 'policy', label: 'Admission policy', value: i.policy ? policyLabel[i.policy] : UNKNOWN },
    { key: 'fairness', label: 'Fairness score', value: fairness },
  ]
}

# Fair sharing under overload

## Problem
With first-come admission the first building to ask keeps what it asked for. Observed live: one building reserved 102 A of
120 A while two others held 7 A and 4 A, for as long as the demand lasted, because `grant` refused any growth that did not fit
the free capacity. Lease tiers already let a reservation shrink safely; what was missing is a rule that makes an over-share
building's reservation shrink and that gives a starved building part of what it asks for instead of nothing.

## Policy
Two admission policies, chosen by committed state: `first_come` (the previous behaviour, unchanged, and the zero value) and
`fair_share` (default for a new or upgraded cluster, `FAIR_SHARE=true`).

- Every processed request records the building's **want**: the requested amount clamped to capacity, tagged with the log index.
  Wants steer shares; they reserve nothing. A want is dropped by `expire_want` after one lease length (12 s) without a refresh.
- Under `fair_share` a grant authorizes `t = min(want, share)`, where `share` is the building's max-min fair share over all
  wants including the one just recorded. If `t` is above the building's current reservation `R`, the growth is limited to the
  free capacity: `t = R + min(t - R, free)`. The result is `granted` when `t` equals the request and `granted_partial`
  otherwise; `t <= 0` is refused (`capacity_exhausted`, which needs `R = 0` and nothing free, or a zero share when there are
  more wanting buildings than amps). Requests above the whole capacity are clamped instead of being `invalid_request`.
- The grant is recorded as an ordinary tier `{log index, t}`. `first_come` keeps the old rule exactly.

## Why the switch is a committed command
Apply must give every replica, and every replay of the log, the same answer. If the policy came from node-local config
(`FAIR_SHARE` on whichever node is leader), two replicas could decide the same entry differently, and a restart with another
value would rewrite history. `set_policy` is a log entry: the policy changes at one precise index everywhere, a replay
reproduces it, and `ensurePolicy` only proposes the configured value while the ledger has none (after waiting for the
leader's FSM to catch up, so a stale view cannot replace an operator's choice). `POST /api/policy` commits a change at run time.

## Safe preemption through lease tiers
A renewal never releases anything: a grant below the reservation just adds a lower tier, and the reservation falls only when
the older, larger tier expires, which the leader proposes 12 s after it first saw that tier, while the gateway stops using
a grant 10 s after it sent the request. So a gateway can never use more than the ledger has reserved (checked in the
simulation at every step, including delayed commits and leader changes). Fair sharing only changes what renewals ask for:
an over-share building's renewals are capped at its share, its old large tier is no longer refreshed, and it lapses on its own
hold. Freed amps become `free`, and growth is bounded by `free` at the time of each command, so `sum(reserved) <= capacity`
holds after every command whatever the policy, the shares or the wants are. Wants and shares affect fairness only, never safety.

## Max-min shares
`FairShares` takes buildings in ascending `(want, building id)` order with `rem = capacity`. For position `i` of `n`,
`share = floor(rem / (n - i))`. A want at most `share` gets its full want and `rem` shrinks by it; at the first want above
`share` every remaining building gets `share`, the `rem mod (n - i)` leftover amps going one each to the first of them in that order.
Examples at 120 A: wants 102/99/98 give 40/40/40; 10/100/100 give 10/55/55. It is pure and does not depend on map order.

## Invariants (checked after every command in the property test, both policies)
`Granted <= capacity`; tier order and lease/tier mirroring; every want `0 < amps <= capacity`; under `fair_share` an accepted
lease never exceeds the request or the share; a reservation never grows by more than the free capacity; replay and a
mid-run snapshot restore give an identical state.

## Not solved
- No priority classes: every building is equal; an essential building cannot outrank another.
- Decay takes up to 12 s (the hold) plus a gateway round trip; a leader change restarts the hold of every inherited tier.
- A silent building's want caps the others for up to one hold (about 12 s). A gateway whose demand falls to 0 sends a
  zero-amp request that the coordinator refuses before the ledger, so its last want lingers the same way.
- Requests above capacity are clamped (a building asking for 500 A is treated as wanting all 120 A).
- Wants are keyed by whatever building id a request carries and the coordinator has no authentication; a client inventing ids
  can lower everyone's share. Out of scope for the prototype; a roster of known buildings would close it.
- Every request under overload is a Raft entry, a stored result and (when granted) an audit event; this grows without bound.

## Mixed-version warning
`set_policy` and `expire_want` are new log commands. A coordinator running the previous binary answers them
`invalid_command` and keeps first-come state, so it decides grants differently from upgraded nodes: ledgers diverge and a
leader change can then hand out capacity the others have reserved. Never run old and new coordinators together once a
`set_policy` has been committed (an upgraded leader commits one on its first tick). Upgrade all three at once, and wipe the Raft
volumes to downgrade after `fair_share` has been committed.

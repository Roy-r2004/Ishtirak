# Lease tiers: letting a reservation decay to current demand, safely

## Problem
Before this change a renewal never shrank a building's reservation (`amps = max(request, current)`), and every renewal
created a new lease version that restarted the coordinator's 12 s hold. A gateway that kept renewing therefore held its
largest-ever reservation indefinitely and could starve the other buildings (observed: 107-111 A reserved against about
26 A of demand). Shrinking at once on a smaller renewal is unsafe: a gateway keeps every grant it received, each with its
own deadline (send time + 10 s), and serves the maximum of those still valid. An older, larger grant can therefore remain
usable after a smaller renewal commits.

## Tier model
A stored lease carries `Tiers`: one entry `{Version, Amps}` per committed grant that may still be in use.

- `len(Tiers) >= 1`, ascending `Version`, strictly decreasing `Amps` (older tier larger).
- `Lease.Amps == Tiers[0].Amps` (reserved = largest tier), `Lease.Version == newest tier version`. `Granted()` is unchanged
  and sums `Lease.Amps`.
- Sum of `Lease.Amps` over buildings <= `Capacity` after every command.

Grant: capacity is checked on the growth `max(R, r) - R` exactly as before (subtraction form, so `r <= R` always fits).
On accept, tiers with `Amps <= r` are dropped (a newer tier with at least the same amps expires no earlier), the new tier
is appended, and the response carries only that grant's own `{Amps: r, Version: index}`, never the reserved maximum, so a
gateway cannot extend an old large authorization. Expire (term-fenced as before) naming a tier version removes that tier
and every older one; if none remain the lease is deleted (`reclaimed`), otherwise the reservation drops to the new largest
tier (`shrunk`). Unknown version, wrong term or no lease changes nothing. The coordinator keeps one monotonic 12 s hold per
(building, tier version), set when the current leader term first observes the tier; a change of term or leadership clears
all holds; `Due` reports the highest version of the contiguous run of expired tiers.

## Safety argument
Let grant g be sent by a gateway at its monotonic time s, committed at index i, and first observed by the leader at o (after
commit). The gateway may use g only until s + 10 s. The tier for g, or a dominating tier with at least g's amps and a later or
equal commit, is not removed before o + 12 s on the leader's monotonic clock, and holds restart on every term change. If the
relative clock-rate error between a gateway and a coordinator is at most 1% (rho = 0.01), then 10/(1-rho) < 12/(1+rho), so the
tier outlives every use of g. Dominance pruning is safe because the dominating tier commits no earlier than the older grant's
send time, so its hold ends after the older grant's usable window. Delayed or reordered commits (a smaller grant committing
before a larger one sent earlier) are covered identically: the larger tier, whenever it commits, is held from its own
observation. Hence the reserved amount is always >= the largest authorization any gateway may still use, and an amount is
freed only after no gateway can use it, so it cannot be granted twice. Capacity is enforced inside the deterministic FSM on a
majority-committed log, so the sum bound holds on every replica and on replay.

Assumptions: strictly increasing Raft log indexes and a single FSM version across the cluster; the 1% clock-rate bound; the
gateway discards a grant at its own monotonic deadline and computes it from the original request start.
Not covered: host or VM suspension (monotonic clocks may stop), malicious or faulty gateways, and physical actuation (the
generator is not switched by this software).

## Backward compatibility
- Old snapshot: leases without `tiers` get one synthesized tier `{Version, Amps}`. Restore still rejects over-capacity totals
  and now also malformed tiers (unsorted or duplicate versions, non-decreasing amps, non-positive amps, `Lease.Amps` or
  `Lease.Version` not matching the tiers).
- Old command log: grants decide with `max(R, r) - R`, unchanged. Old expire commands carry the lease's latest version, which
  is always the newest tier, so they remove all tiers exactly as the old delete did. Replay therefore yields the same
  accept/reject decisions and per-building reserved amps (a seeded model of the old rules is compared in
  `TestMatchesOldRulesOnOldStyleCommandStreams`). Stored results and events differ only in carrying the grant's own amps.
- `Apply` stays deterministic: no wall clock, randomness or map-ordered output. `View()` deep-copies tiers.

## Residual limits
- No priority or fair-share policy: if several buildings demand more than capacity at once, first come first served holds.
- Decay is not immediate: after demand falls, the reservation shrinks about one hold (12 s) after the renewal that carried
  the lower request is observed, plus up to the 200 ms expiry tick.
- Rolling upgrades with mixed binaries are unsafe (an old replica ignores tier expiries and diverges); upgrade the cluster
  together with the data reset procedure already used for ledger changes.
- Snapshots written by this version are not readable by older binaries as tiered state.
- Clients that read `Lease.Amps` from the state endpoint see the reserved amount; clients that read a `granted` event see that
  grant's own amps. The `shrunk` event is new and needs dashboard handling.

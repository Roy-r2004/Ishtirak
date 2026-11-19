# Active/standby gateway pair per building

## Problem
A building has one gateway. When it fails, the building is cut off until someone restarts it: a single point of failure per
building. The coordinators already tolerate the loss of a minority (three Raft nodes); the gateways did not.

## Design
Each building runs two gateway processes from the same code with the same `BUILDING_ID`: the primary (`gateway-<building>`)
and a standby (`gateway-<building>-standby`, compose services added for hamra, mar-mikhael and achrafieh). Nothing in the
ledger or the coordinators changed. The standby is simply a second gateway session of the same building, and the ledger
already allows only one session to hold a building's lease:

- `internal/ledger` refuses a grant from a different session while the building's lease is held, with the reason
  `building_session_active` (the existing check `exists && current.SessionID != r.SessionID`).
- Both gateways subscribe to the building's MQTT topic. Each has its own client id and a clean session, so each receives
  every reading and keeps its own current data and its own copy of the unflushed readings.
- Both send grant requests. Whichever session holds the lease is granted and serves. The other is refused every time, until
  the holder stops renewing and the coordinator commits the expiry of the holder's last tier. Its next request after that
  is accepted and it serves the building. The two processes are symmetric: "primary" and "standby" only say which one the
  compose file starts for the building, not which one serves.

### What the gateway does differently (`internal/telemetry/gateway.go`)
- **Role.** `GET /api/status` has a new field `role`: `serving` (the gateway holds a live local lease, state `active` or
  `limited`), `standby` (its most recent grant outcome was a `building_session_active` refusal received less than 8 s ago, so
  another session holds the building), or `waiting` (neither: no lease yet, the lease lapsed, another refusal reason, or the
  last outcome is older than 8 s). `serving` wins over `standby`. A later accepted grant clears the refusal.
- **Back-off.** After a `building_session_active` refusal `Renew` sends nothing for `StandbyRetry` (2 s). A refused request
  still costs a Raft entry, so a standby must not ask on every one-second tick. Other refusals (`capacity_exhausted`,
  `invalid_request`, ...) keep the previous cadence. The refusal error text (`grant refused: building_session_active`) is
  unchanged and is shown as the standby's `last_error`.
- The renewal loop ticks once per second and the refusal time is taken when the reply arrives, so the standby's requests are
  in practice 2 to 3 s apart, never closer than 2 s. (The fake-clock tests have zero latency and see exactly 2 s.)

### Console and controller (`cmd/control`)
`/api/overview` has a new top-level key `standbys`: three `source` objects (`id`, `online`, `data`, `error`) in the same
order and shape as `buildings`, with `id` the building id, fetched from `http://gateway-<building>-standby:8080/api/status`
(`mar_mikhael` is `gateway-mar-mikhael-standby`). All existing keys are unchanged. The three standby services are in the
start/stop/restart allowlist under their exact compose service names. No standby publishes a port.

## Safety argument: why a standby cannot cause double use
The invariant is that the total amperage the gateways may use never exceeds the generator capacity. A second gateway for a
building would break it only if both could use that building's amps at the same time. They cannot:

1. **The ledger admits one session per building.** While any tier of a building's lease exists, a grant request from another
   session is refused and reserves nothing (the refusal path returns before the want is recorded or capacity is touched).
   So the building's reservation in the ledger always belongs to one session, and `sum(reserved) <= capacity` holds exactly
   as before: the standby adds no reservation.
2. **A gateway uses amps only from its own grants.** A gateway serves `min(demand, largest live grant of its own session)`,
   and each grant lives until its own request-send time + 10 s (lease 12 s minus the 2 s safety margin), whatever the reply
   timing. A refused standby holds no grant and serves 0 A.
3. **A different session is admitted only after committed expiry.** The coordinator holds every committed tier for 12 s from
   the moment the current leader first observed it (a leader change restarts the hold) and then commits an `expire` command.
   Only when the last tier is gone can the other session be granted. The primary's last local use ended at most 10 s after
   its last request was sent, which is before the ledger commits that request's expiry (at least 12 s after it was
   committed). The standby therefore starts serving strictly after the primary's last grant has lapsed locally and in the
   ledger. This is the same margin the system already relies on for a gateway that restarts with a new session; the standby
   adds no new timing assumption (the README's rate-error assumption of at most 1% applies unchanged).
4. **A refused or late reply never grants.** The standby's `ApplyGrant` accepts only a reply that matches its own request and
   session and arrives before its own deadline; a refusal never creates a grant.

Takeover time, from the primary's last renewal, in the design: 12 s (hold) + about 0.2 s (the coordinator checks for due
expiries every 200 ms) + the wait for the standby's next request (at most 2 to 3 s: the 2 s back-off and the 1 s tick) +
one request round trip, so roughly 12 to 15 s. Three things can make it longer, all by the existing rules and not by the
standby: a Raft leader change inside the window restarts the 12 s hold; neighbouring buildings that want more than their
fair share can take the amps freed by the failed gateway before the standby asks, after which the standby is admitted under
fair sharing like any request and may wait up to about one more lease length (24 s in the neighbour simulation below); and
a standby or coordinator that is itself down.

## Reading continuity
Both gateways receive each reading (QoS 1, separate clean sessions) and hold their own `latest` map and their own pending
queue, so at the moment of takeover the standby already has the current demand and any readings the primary had not yet
flushed. When the primary dies, the readings it had received but not flushed are lost with it (the existing limitation), but
the standby holds its own copy and flushes it. Both gateways flush every reading to the coordinator, so each reading reaches
PostgreSQL twice with the same `reading_id`. By reading `internal/storage/postgres.go` the insert is
`ON CONFLICT(reading_id) DO NOTHING`, so the table keeps one row per reading. The tests below prove the gateways send
the same ids twice; they do not exercise PostgreSQL.

## Limits (honest)
- **A service gap per failure of about 12 to 15 s** (measured from the primary's last renewal; the gap seen by the building
  is shorter by the time between that renewal and the crash, and up to 24 s in the neighbour case or after a leader change
  inside the window). During it the building has no service. This is shorter than "until someone restarts the gateway",
  not zero.
- Covers **gateways only**. A failure of Mosquitto, PostgreSQL, the coordinators' majority or the meters is not helped.
  A crash of both gateways of a building still means no service for that building.
- **Readings are written twice** to PostgreSQL (idempotent by reading id, so no duplicate rows, but double the write
  load and double the MQTT subscribers).
- **Refused requests are Raft entries.** Every grant request, accepted or refused, is a committed command and its result is
  retained in the ledger's request history. One standby asks every 2 to 3 s, about 1,200 to 1,800 extra entries per hour
  per standby, 3 standbys in the compose stack. The back-off keeps this bounded; it does not remove it.
- **A restarted primary becomes the standby.** It starts with a new session and is refused while the other gateway holds the
  lease; it does not take the building back. Roles are symmetric, so after the serving gateway fails the restarted one takes
  over in turn.
- **Idle buildings.** The gateway asks for `ceil(demand)` amps and the coordinator rejects 0 (HTTP 400), so with zero demand
  nobody renews and the lease lapses after 12 s. Both gateways then report `waiting` (not `standby`), and the one whose
  request reaches the coordinator first when demand returns serves. This follows from reading the code and was not tested.
- The 12 to 15 s figure, the 2 to 3 s request spacing and the Raft-entry rates come from the constants and the code; they
  were not measured on the Docker stack.

## Verification
Run in this change with the Go toolchain; no Docker stack, MQTT broker, PostgreSQL or real Raft cluster was used.

- `internal/telemetry/standby_test.go`: `role` values and window edges (fake clock), the refusal error text, the back-off
  (requests at 0, 2, 4, 6, 8 s under a refusing HTTP server), other refusal reasons not backing off, and the standby
  serving once the building is free.
- `internal/telemetry/standby_ledger_test.go`: two gateways for one building (plus one gateway each for the other two
  buildings, at demands that fill the 120 A capacity) driven against the real `ledger.FSM` and the real
  `coordinator.Deadlines` on a fake clock, with a handler that does what `Server.grant` and `Server.expirations` do. Checked
  after every 200 ms step and every gateway action: reserved <= 120 A; the sum of amps the gateways can use <= 120 A; each
  gateway's usable amps equal what an independent model allows from its own grants (request time + 10 s); a gateway uses amps
  only while the ledger holds the building's lease for its session; the role is `serving` exactly when amps are usable.
  Scenario: while the primary renews the standby is refused, never serves, asks about every 2 s and holds the same demand
  and its own pending readings (both flush every reading; each id arrives twice); when the primary stops renewing, the
  standby is granted exactly 12 s after the primary's last renewal in that run (asserted between 12 and 14 s) and the primary's
  grant has lapsed before it; the same primary, healed, and then a restarted primary with a new session, are refused and do
  not take the building back; when the serving gateway stops, the other takes over after the committed expiry; with both
  down the lease is reclaimed. A second simulation with neighbours wanting 70 A each saw the takeover 24 s after the last
  renewal (asserted only to be at least 12 s).
- Mutation checks run against the new tests, by build overlay with no file changed: removing the ledger's session check
  makes the real-ledger test fail; removing the back-off, the safety margin or the standby role each make tests fail.
- `cmd/control`: the new `standbys` key and the unchanged keys, a standby that is down, and the allowlist (exact names,
  all three actions, unlisted names rejected).

Not tested: the Docker stack, two real MQTT subscribers receiving the same message, a Raft leader change during a takeover,
real-time request spacing, PostgreSQL deduplication, the web console, and the failure scripts.

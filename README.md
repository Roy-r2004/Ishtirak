# Ishtirak

**Shared power. Coordinated safely.** A runnable distributed-systems prototype for neighborhood generator capacity allocation in Beirut.

The authoritative invariant is **sum of granted integer amperage <= committed generator capacity**. Three Go coordinators replicate the capacity ledger through HashiCorp Raft. Building gateways receive short-lived leases and enforce their budgets in a simulated served-load calculation.

## Start the neighborhood

Install Docker Desktop with Linux containers, then run from this directory:

```powershell
docker compose up --build -d
```

Open **http://localhost:8088**. The dashboard is the **Ishtirak Console**, a single screen built like an electrical single-line diagram: the 120 A generator at the top, a bus line down to one feeder per building (with its breaker, demand, reserved amps, fair share and lease tiers), a Capacity panel (reserved against 120 A, peak, violation counter, a one-line capacity proof), the Raft cluster with a Coordinators table, and a dock with the Allocation log, the Failure tests, the meter Simulation and a history Chart. A switch in the top bar changes the admission policy between fair sharing and first come. Add `?demo=1` to the address to see it on simulated data without any backend (a permanent "Simulated data" chip marks it). Startup usually takes a few seconds after images finish building. The initial simulation has 50 household meters across three buildings, sharing a 120 A generator.

```powershell
docker compose ps
docker compose logs --tail 100 coordinator1 coordinator2 coordinator3
docker compose stop
docker compose start
```

Only the dashboard is published to the host, bound to loopback. No host Go installation is required. No TypeSafe/OpenAI key is required or read by the application. The course brief (`Final-Project 2025.pdf`) and the original proposal documents are not redistributed in this repository.

## What is distributed?

| Process group | Responsibility | Communication |
| --- | --- | --- |
| Go meter simulators + Mosquitto | Synthetic household consumption, unique readings | MQTT QoS 1 |
| Three Go building gateways | Building partition, aggregation, leases, simulated load limiting | MQTT and HTTP/JSON |
| Three persistent Go coordinators | Leader election, consensus, capacity state machine | HashiCorp Raft TCP and HTTP/JSON |
| PostgreSQL | Durable readings and idempotent append-only event projection | SQL |
| React dashboard | Live observations, topology, audit, fault controls | HTTP and WebSocket |

There is no shared-memory coordinator ledger. Each coordinator owns an independent volume, log, snapshot, and process. Two votes are required to commit. Docker Compose is a single-host demonstration of distributed protocols; it is not resilience to failure of that host.

## Try the live demonstration

The quickest tour is the dock's **Failure tests** tab: four guided scenarios (leader failover, majority loss, gateway crash, database outage) that stop real containers after an inline Confirm, show a live capacity proof (peak granted against 120 A), the coordinators' roles and a timeline of observed changes, and always restore what they stopped. The manual steps below do the same by hand.

1. Observe the Capacity panel (reserved against 120 A, free, served, curtailed) and the three reporting buildings.
2. In the **Coordinators** table, stop the current leader (Stop, then Confirm). Watch a replacement leader appear, then start the old node again.
3. Stop two coordinators. The console reports lost quorum, new grants stop, and gateways stop serving when their safe local deadlines expire. Start both nodes again.
4. On a building, open its breaker (the breaker symbol, then Confirm) to simulate a gateway failure. Its committed budget remains reserved conservatively before reclamation. Close it again; the gateway uses a fresh session and waits for safe admission.
5. In the **Simulation** tab, stop PostgreSQL. Raft continues capacity decisions; audit entries catch up when the database returns. Buffered readings can be lost if their gateway crashes.
6. Set 10, 50, or 200 meters and vary the demand multiplier. The console separates requested demand, served demand, and reserved capacity; excess demand is curtailed rather than treated as extra authorized capacity.
7. Run the **Overload test** under each admission policy (the policy switch is in the top bar). Under first come one building can keep most of the generator; under fair sharing the buildings converge on equal shares.

Reservations are tiered: a renewal adds a short-lived tier and the reserved amount steps down to a building's current demand about 12 seconds after demand falls (the Allocation log shows "Reduced"), but never while an older, larger grant could still be in use.

**Fair sharing** (the default) is max-min fairness over what the buildings currently want. Each request records the building's want; a grant authorizes the lesser of its want and its share, and a building that wants more than its share is capped on renewal, so its older, larger tier lapses on its own and the freed amps go to the buildings that were starved. At 120 A, wants of 102/99/98 A settle at 40/40/40 A and 10/100/100 A at 10/55/55 A. The policy is a committed Raft command, so every replica switches at the same log index; a safety gate keeps it off while any coordinator is unreachable or lacks support. `first_come` (the previous rule) remains selectable. See [docs/FAIR_SHARING.md](docs/FAIR_SHARING.md). `python scripts/reset_demo.py` restarts the gateways for an immediate clean state. The tier design and its safety argument are in [docs/LEASE_TIERS.md](docs/LEASE_TIERS.md) and the report.

The local demo controller holds the Docker socket and only permits start/stop/restart of this project's named, label-verified containers. This is a trusted local demonstration capability, not a public deployment design. Disable `ENABLE_DEMO` and remove the socket mount before reusing the application outside this setting. The included database password is a public demo fixture, not a production credential.

## Safety protocol

- Generator capacity is initialized once by a replicated `init_capacity` command, not independently decided during replay by each node. The first committed value persists through snapshots and leadership changes.
- Requests have unique IDs and canonical payload hashes. Reusing an ID with changed content is rejected. Results are retained for idempotent replay, including after snapshots.
- A gateway has a fresh boot-session identifier. Another session cannot take over a building while its old lease remains reserved.
- Grants and renewals receive unique committed-log-index versions. Expiration commands compare the building, version, and proposing Raft term; a stale expiry cannot delete a newer lease.
- Lease duration is fixed at **12 seconds** across the protocol. A gateway uses a grant only until **its original request-send time + 10 seconds**, retaining that original time across retries. Late or mismatched responses cannot extend it.
- The coordinator starts a monotonic **12-second hold** when it first observes a lease version. Every leadership-term transition conservatively resets inherited holds. Clock offsets and wall-clock adjustments do not decide expiry.
- Renewals do not reduce an existing reservation. Capacity is released only through committed expiry. This deliberately favors safe accounting over fine-grained utilization.
- A failed/timed-out request is an unknown outcome, not proof of rejection. Retry with the same ID. Without a majority, no new grant can become official.

**Timing assumptions:** this is a simulator with bounded monotonic-clock rate error and cooperative processes. With a relative rate bound `rho`, safety requires `10/(1-rho) < 12/(1+rho)` before additional uncertainty; the documented operational assumption is at most 1% rate error. Host suspend/VM timer behavior and physical breakers are not certified. The invariant concerns grants and simulated service, not actual electrical infrastructure.

## Verification

Go tests and static checks can run entirely in Docker:

```powershell
docker run --rm --mount "type=bind,source=$($PWD.Path),target=/src" -w /src golang:1.25-alpine sh -c "go test ./... && go vet ./..."
```

Frontend checks:

```powershell
cd web
npm ci
npm run build
```

The integration/evaluation runner exercises the running stack, briefly stops project services, restores them in a `finally` block, and writes measured results:

```powershell
python scripts/evaluate.py
```

See [the report](docs/PROJECT_REPORT.md), [submission PDF](docs/Ishtirak_Project_Report.pdf), and [raw evaluation](artifacts/evaluation.json) for the results and limitations. The [PowerPoint](docs/Ishtirak_Presentation.pptx) contains 17 slides with a speaking script in the notes.

The completed run passed all twelve integration phases, with no capacity violations in 947 coordinator observations. The simultaneous 40-request stress admitted 17 requests of 7 A each: 119 A under the 120 A limit. Load results are the mean of five trials, failover and reclamation of three, with a concurrency sweep to 64 clients, an end-to-end telemetry latency and a demand-spike recovery phase (every building back within budget 17.6 s after the spike). The run before the lease-tier change is kept as `artifacts/evaluation-before-tiers.json`. The report explains the sampling and timing limits.

Randomized fault check (seeded fault schedule, concurrent randomized grants and replays, history checked against the capacity invariant; its result is in `artifacts/chaos-check.json`):

```powershell
python scripts/chaos_check.py --seed 1 --duration 90
python scripts/chaos_check.py --seed 1 --duration 90 --dry-run   # print the schedule only
```

Fair sharing on three real coordinator processes without Docker (build `cmd/coordinator` first; the result is in `artifacts/native-cluster-check.json`):

```powershell
python -I scripts/native_cluster_check.py --binary path\to\coordinator.exe --work path\to\scratch
```

Additional checks:

```powershell
docker run --rm --mount "type=bind,source=$($PWD.Path),target=/src" -w /src golang:1.25 sh -c "go test -race ./... && go vet ./..."
python -I -m unittest discover -s scripts -p "test_*.py"
(cd web; npm test)
node scripts/browser-check.mjs
```

Browser checks require Node 24 and Chrome; `CHROME_PATH` overrides the Windows default. They run the Failure tests' leader-failover scenario against the live stack. Of three live runs of the 40-check test, one passed (`artifacts/browser-check.json`); the report records the two that did not. Run the evaluation, the fault check and the browser checks one at a time, because each changes the running system. To regenerate the PDF, install ReportLab in a Python environment and run `python scripts/render_report.py`.

## Project map

```text
cmd/                  coordinator, gateway, meters, local demo controller
internal/ledger/      deterministic Raft state machine and safety tests
internal/coordinator/ Raft lifecycle, HTTP/WebSocket API, monotonic holds
internal/telemetry/   MQTT aggregation, safe gateway budgets, simulation
internal/storage/     PostgreSQL schema, event replay, durable readings
web/                  React/TypeScript Ishtirak Console (incl. Failure tests) and Nginx proxy
deploy/               Mosquitto configuration
scripts/              evaluation, randomized fault check, demo reset, browser checks, tests
artifacts/            measured evidence: evaluation, fault check, browser check, screenshots
docs/                 project report (Markdown and PDF) and presentation
compose.yaml          complete local environment
```

## Deliberate limits

No physical relays, billing engine, authentication product, replicated PostgreSQL, standby gateway, Kafka, Kubernetes, or external AI is added. Readings published during gateway downtime may be lost. Gateway queues are bounded and report drops. Request history and audit outbox are retained for this bounded prototype and grow over time; production retention requires a separate safety design. Fair sharing has no priority classes (every building is equal) and building ids are not authenticated. UI status and quorum checks are timestamped observations, not a linearizable physical-world measurement.

Do not reset only one side of the persistent system: resetting Raft history while retaining SQL audit IDs invalidates correspondence. For a fresh demo, stop all gateways and reset the entire Compose project's volumes together, only when data deletion is intended.

## Design sources

The original `Final-Project 2025.pdf`, `Ishtirak_Project_Proposal_slim.docx`, and `Ishtirak_Project_Flow.drawio` define the requirements and limited scope. Library behavior is grounded in [HashiCorp Raft](https://pkg.go.dev/github.com/hashicorp/raft) and [Eclipse Paho MQTT](https://pkg.go.dev/github.com/eclipse/paho.mqtt.golang) documentation. Measured results are produced by the supplied runner, not estimated from the design.

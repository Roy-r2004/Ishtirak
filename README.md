# Ishtirak

**Shared power. Coordinated safely.** A runnable distributed-systems prototype for neighborhood generator capacity allocation in Beirut.

The authoritative invariant is **sum of granted integer amperage <= committed generator capacity**. Three Go coordinators replicate the capacity ledger through HashiCorp Raft. Building gateways receive short-lived leases and enforce their budgets in a simulated served-load calculation.

## Start the neighborhood

Install Docker Desktop with Linux containers, then run from this directory:

```powershell
docker compose up --build -d
```

Open **http://localhost:8088**. The dashboard displays real MQTT telemetry, live Raft state, allocation events, and a simulation lab. Startup usually takes a few seconds after images finish building. The initial simulation has 50 household meters across three buildings, sharing a 120 A generator.

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

The quickest tour is the dashboard's **Resilience lab**: four guided scenarios (leader failover, majority loss, gateway crash, database outage) that stop real containers, show a live capacity proof (peak granted against 120 A), a per-coordinator Raft view and a timeline of observed changes, and always restore what they stopped. The manual steps below do the same by hand.

1. Observe the granted-capacity total, remaining capacity, and three reporting gateways.
2. In **Coordinator cluster**, take the current leader offline. Watch a replacement leader appear, then bring the old node online.
3. Stop two coordinators. The dashboard reports lost quorum, new grants stop, and gateways stop serving when their safe local deadlines expire. Restore both nodes.
4. On a building card, simulate a gateway failure. Its committed budget remains reserved conservatively before reclamation. Restart the gateway; it uses a fresh session and waits for safe admission.
5. In **Simulation lab**, stop PostgreSQL. Raft continues capacity decisions; audit entries catch up when the database returns. Buffered readings can be lost if their gateway crashes.
6. Set 10, 50, or 200 meters and vary the demand multiplier. The UI separates requested demand, served demand, and reserved capacity; excess demand is curtailed rather than treated as extra authorized capacity.

Allocation is first-come and a renewal never shrinks a reservation, so after a 200-meter run one building can keep a large reservation and starve the others (the invariant still holds). Run `python scripts/reset_demo.py` to restart the gateways and return to a fair allocation. This trade-off is explained in the report.

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

See [the report](docs/PROJECT_REPORT.md), [submission PDF](docs/Ishtirak_Project_Report.pdf), and [raw evaluation](artifacts/evaluation.json) for the results and limitations. The [PowerPoint](docs/Ishtirak_Presentation.pptx) contains 16 slides with a speaking script in the notes.

The completed run passed all eleven integration phases, with no capacity violations in 708 coordinator observations. The simultaneous 40-request stress admitted 17 requests of 7 A each: 119 A under the 120 A limit. Load results are the mean of five trials, failover and reclamation of three, and a concurrency sweep to 64 clients plus an end-to-end telemetry latency were added. The report explains the sampling and timing limits.

Randomized fault check (seeded fault schedule, concurrent randomized grants and replays, history checked against the capacity invariant; its result is in `artifacts/chaos-check.json`):

```powershell
python scripts/chaos_check.py --seed 1 --duration 90
python scripts/chaos_check.py --seed 1 --duration 90 --dry-run   # print the schedule only
```

Additional checks:

```powershell
docker run --rm --mount "type=bind,source=$($PWD.Path),target=/src" -w /src golang:1.25 sh -c "go test -race ./... && go vet ./..."
python -I -m unittest discover -s scripts -p "test_*.py"
(cd web; npm test)
node scripts/browser-check.mjs
```

Browser checks require Node 24 and Chrome; `CHROME_PATH` overrides the Windows default. They run the Resilience lab's leader-failover scenario against the live stack. Run the evaluation, the fault check and the browser checks one at a time, because each changes the running system. To regenerate the PDF, install ReportLab in a Python environment and run `python scripts/render_report.py`.

## Project map

```text
cmd/                  coordinator, gateway, meters, local demo controller
internal/ledger/      deterministic Raft state machine and safety tests
internal/coordinator/ Raft lifecycle, HTTP/WebSocket API, monotonic holds
internal/telemetry/   MQTT aggregation, safe gateway budgets, simulation
internal/storage/     PostgreSQL schema, event replay, durable readings
web/                  React/TypeScript dashboard (incl. Resilience lab) and Nginx proxy
deploy/               Mosquitto configuration
scripts/              evaluation, randomized fault check, demo reset, browser checks, tests
artifacts/            measured evidence: evaluation, fault check, browser check, screenshots
docs/                 project report (Markdown and PDF) and presentation
compose.yaml          complete local environment
```

## Deliberate limits

No physical relays, billing engine, authentication product, replicated PostgreSQL, standby gateway, Kafka, Kubernetes, or external AI is added. Readings published during gateway downtime may be lost. Gateway queues are bounded and report drops. Request history and audit outbox are retained for this bounded prototype and grow over time; production retention requires a separate safety design. Fair scheduling and shrinking active reservations are not implemented. UI status and quorum checks are timestamped observations, not a linearizable physical-world measurement.

Do not reset only one side of the persistent system: resetting Raft history while retaining SQL audit IDs invalidates correspondence. For a fresh demo, stop all gateways and reset the entire Compose project's volumes together, only when data deletion is intended.

## Design sources

The original `Final-Project 2025.pdf`, `Ishtirak_Project_Proposal_slim.docx`, and `Ishtirak_Project_Flow.drawio` define the requirements and limited scope. Library behavior is grounded in [HashiCorp Raft](https://pkg.go.dev/github.com/hashicorp/raft) and [Eclipse Paho MQTT](https://pkg.go.dev/github.com/eclipse/paho.mqtt.golang) documentation. Measured results are produced by the supplied runner, not estimated from the design.

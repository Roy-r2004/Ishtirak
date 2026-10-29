# Project context

Read `Final-Project 2025.pdf`, `Ishtirak_Project_Proposal_slim.docx`, and `Ishtirak_Project_Flow.drawio` before planning implementation. Ishtirak is a distributed generator-capacity coordination prototype using Go, MQTT/Mosquitto, three HashiCorp Raft coordinators, PostgreSQL, React, and Docker Compose. Preserve the capacity invariant and the proposal's limited scope.

# User's preferred workflow for substantial tasks

- Plan first. Record scope, dependencies, acceptance criteria, verification, and stopping conditions in a compact plan. Use an executable workflow when supported and useful; do not invent orchestration APIs.
- The user explicitly requests parallel agents for substantial tasks: read-only scanners, isolated editing workers, and independent verifiers. Keep small tasks simple.
- Prefer a capable planner, a lower-cost model for bounded scans, and capable coding/review models for edits and verification, using only models and settings actually available. Disclose fallbacks; never claim to switch the main session's model without confirmation from the runtime.
- Partition relevant files by responsibility. Use separate worktrees or isolated copies for parallel edits; do not let workers overwrite one another's changes. Do not assume isolation is automatic.
- Independently verify every reported audit finding and proposed fix. When independent agents are unavailable, identify that limitation and distinguish unverified concerns from confirmed findings.
- Stop a fix loop after two consecutive rounds without measurable progress; summarize the blocker and change approach or request necessary information.
- Return concise evidence, file references, diffs, test results, and remaining limitations instead of full agent transcripts. Run appropriate integration checks after combining changes.
- For workflow/setup changes, show proposed diffs and installation commands before applying them and wait for the user's go-ahead. After approval, complete the approved scope without repeatedly requesting the same permission. Respect any explicit task-specific approval gate.
- Keep deterministic routing, arithmetic, file selection, retry limits, and safety decisions in code. Consider TypeSafe/Jev only for useful semantic or visual judgments with evaluated thresholds and fallback behavior.
- `TypeSafe-Danger-Zone-Images: true` is an experimental-feature header, not a credential. Keep real API credentials outside source files. TypeSafe installation and external API use are separate setup actions, not implied by these preferences.
- Keep experimental image features outside Ishtirak's authoritative capacity-allocation and lease-safety logic.

# Ishtirak implementation boundaries

- Preserve total granted amperage <= generator capacity at all times, including failures.
- Keep the Raft ledger authoritative; require majority commit for grants and stop new grants without a majority.
- Keep capacity accounting, idempotency, and lease safety deterministic. Specify and test lease expiry across leader changes, delayed messages, and gateway restarts before implementing reclamation.
- Retain the proposed Go/MQTT/Mosquitto, three HashiCorp Raft coordinators, single PostgreSQL, React, and Docker Compose scope.
- Preserve stated limitations: no gateway replication; readings during gateway downtime may be lost; PostgreSQL has no failover and audit writes catch up after recovery.
- Verify capacity stress, leader failure, majority loss, gateway crash, duplicate requests, and 10/50/200-meter p50/p95 latency and throughput, as relevant to the approved change.
- Keep image experiments optional and outside authoritative allocation, consensus, and lease-safety paths; expanding the prototype requires approval.
- Discover current Git state before editing. If no repository exists, use verified isolated copies; do not initialize Git or create commits merely to enable this workflow.

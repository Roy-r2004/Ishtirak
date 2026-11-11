# Stable test hooks

Every hook is a `data-testid` attribute. State that a script needs is exposed as `data-*` attributes next to it, so a check never has
to parse display text. The ids are the contract: class names and layout are free to change. The console is `src/board/*`; the file that
defines each group is named in its heading. The previous Switchboard design is in the git history (commit 61643af).

## What changed from the Switchboard

The ids were kept; where the interaction changed, the note says how.

| Was | Now | Notes |
|---|---|---|
| Council | Coordinators | `council` is the Coordinators table; the Raft cluster drawing is `cluster` |
| Feeders | Buildings | the `feeders` row and each `feeder` are unchanged |
| Ledger | Allocation log | `ledger` is the log panel in the dock |
| Tear off | Export | `ledger-tear`, `ledger-door-tear` |
| Full ledger door | Full log drawer | `ledger-open`, `ledger-door*` |
| Test panel, Event recorder | Failure tests, Observed events | `scenario*`, `overload*`, `timeline-item` |
| Chart recorder (top plate and bottom button) | Chart (capacity panel button and dock tab) | `recorder-open` and `recorder-open-bottom`, one state |
| Commissioning notes | About this system | `help-open`, `help-dialog`, `help-close` |
| Flip-up covers | inline two-step confirmation | see "Two steps" below |

## Required hooks

| id | count | where | state attributes |
|---|---|---|---|
| `board` | 1 | `<main>` of the console (Board.tsx) | `data-demo` (true on simulated data), `data-tray` (true while the Chart tab is open), `data-lamptest` (always `false`: there is no startup lamp test) |
| `main-ammeter` | 1 | the Capacity panel (CapacityPanel.tsx) | `data-fresh`, `data-selftest` (always `false`), `data-reserved` (amps in the leader's ledger, empty when unknown), `data-capacity`, `data-peak`, `data-violations` |
| `peak-readout` | 1 | "Peak 81 A" | text is `<n> A`, or an em dash before the first fresh sample |
| `violations` | 1 | violation counter | `data-count` |
| `capacity-proof` | 1 | one-line proof in the Capacity panel | `data-state` = `none` / `safe` / `violated`; text starts "No violation observed" when safe |
| `free-readout`, `served-readout`, `curtailed-readout` | 1 each | free = capacity minus reserved, served = sum of the gateways' served amps, curtailed = requested minus served | `data-value` = the number to one decimal, empty when unknown; text reads `<n> A`, or an em dash when the data is stale or the source is missing. Curtailed is `0 A` when nothing is curtailed, never negative |
| `feeder` | 3 | one building column of the single-line diagram, including its line, breaker and metering block (Diagram.tsx) | `data-building` (`hamra`, `mar_mikhael`, `achrafieh`), `data-state` (text such as "Within budget"), `data-online`, `data-stale` |
| `relay` | 3 | one row of the Coordinators table (CoordinatorsTable.tsx) | `data-node` (`coordinator1..3`), `data-role` (`Leader`, `Follower`, `Candidate`, `Unreachable`), `data-stale` |
| `help-open` | 1 | "About this system" button in the top bar | `aria-haspopup=dialog` |
| `help-dialog`, `help-close` | 1 each | the About drawer (Drawers.tsx), exists only while open | |
| `meters-10`, `meters-50`, `meters-200` | 1 each | the meter choice in the Simulation tab (Simulation.tsx) | `aria-checked`, `data-selected` |
| `sim-apply` | 1 | "Apply" in the Simulation tab | `disabled` while an action is in flight |
| `ledger-row` | n | one per audit event in the Allocation log, newest first (AllocationLog.tsx) | `data-kind` (`granted`, `shrunk`, `reclaimed`) |
| `scenario` | 4 | leader failover, majority loss, gateway crash, database outage (FailureTests.tsx) | `data-scenario` (scenario id, e.g. `leader-failover`), `data-state` (`idle`, `running`, `restoring`, `done`, `timeout`, `cancelled`) |
| `scenario-cover` | 4 | the Run button of each scenario: the first step | `aria-expanded` |
| `scenario-run` | 4 | Confirm in the inline question: the second step. Always in the document; hidden and `disabled` until the first step | |
| `scenario-status` | 1 | live status window (`role=status`) | `data-state`; text contains "Completed" when a run finished |
| `timeline-item` | n | rows of Observed events | `data-kind` (`leader_elected`, `leader_lost`, `node_down`, `node_up`, `quorum_lost`, `quorum_restored`) |
| `policy-switch` | 1 | the admission policy segmented control in the top bar (TopBar.tsx) | |
| `policy-fair_share`, `policy-first_come` | 1 each | the two options | `aria-checked`, `data-selected` |
| `overload-run` | 1 | Confirm of the Overload test (second step) | |
| `capacity-proof` | 1 | see above | |

## Dock

The dock holds one panel at a time. Hidden panels stay in the document, so an id exists even when its tab is not showing; a script must
open the tab (a real click on the tab) before it focuses or looks at what is inside. The tab strip is a single tab stop; arrow keys move
between tabs and Enter or Space opens one.

| id | where |
|---|---|
| `dock` | the dock |
| `tab-log`, `tab-tests`, `tab-sim` | tabs: Allocation log, Failure tests, Simulation (`aria-selected`). The Failure tests tab shows "Running" while a test runs |
| `recorder-open-bottom` | the Chart tab (`aria-selected`, `aria-expanded`) |
| `recorder-open` | the Chart button in the Capacity panel; same state as the tab (`aria-expanded`) |
| `recorder`, `recorder-chart`, `recorder-close` | the chart, its plot (focusable; arrow keys read samples) and "Hide chart". Closing returns focus to whichever control opened it |
| `notice` | action result, shown in the dock's tab bar (`role=status`) |

## Drawers

Drawers are modal dialogs on the right: focus moves inside when one opens, Tab stays inside, Escape closes, and focus returns to the control that opened it.

| id | where |
|---|---|
| `ledger-open` | "Full log" button in the Allocation log toolbar; opens the Full log drawer |
| `ledger-door`, `ledger-door-close` | the Full log drawer |
| `ledger-door-row` | one per event in the drawer, newest first, at most 100; columns Event, Building, Entry, Amps, Version, Time (`data-kind`) |
| `ledger-door-search`, `ledger-door-filter`, `ledger-door-tear`, `ledger-door-caption` | search, kind filter (`all`, `granted`, `shrunk` shown as Reduced, `reclaimed`), Export (same file and content as `ledger-tear`), and the caption "N events matching, of M held here. Full history lives in PostgreSQL." (`role=status`) |
| `cluster-open` | "Cluster details" button on the Raft cluster drawing |
| `cluster-door`, `cluster-door-close` | the Cluster details drawer |
| `cluster-facts`, `cluster-fact`, `cluster-table`, `cluster-door-node` | the facts grid; one `cluster-fact` per fact with `data-fact` (`postgres`, `majority`, `verified-at`, `reachable`, `feed`, `policy`, `fairness`) and `data-value`; the per-coordinator table; one `cluster-door-node` column header per coordinator with `data-node` and `data-role`. A value that was not reported reads `unknown` (cells carry `data-unknown=true`) |
| `feeder-open` | a building's name in its metering block; opens the Building details drawer |
| `feeder-door`, `feeder-door-close` | the Building details drawer |
| `theme-switch`, `theme-auto`, `theme-light`, `theme-dark` | Appearance in the About drawer (radio group) |

## Two steps

An action that stops something asks first, inline, with Confirm and Cancel. The first control keeps the id it always had; the second
step is new or renamed. The Confirm button is always in the document (hidden and `disabled` until asked) so it can be found at rest.
Focus moves to Confirm when the question appears; Escape or Cancel closes it and returns focus to the first control; an unanswered
question closes itself after eight seconds.

| Action | First step | Second step | Cancel |
|---|---|---|---|
| Stop or start a coordinator | `relay-cover` (Stop or Start) | `relay-control` (Confirm) | `relay-cancel` |
| Run a failure scenario | `scenario-cover` (Run) | `scenario-run` (Confirm) | `scenario-cancel` |
| Run the Overload test | `overload-cover` (Run) | `overload-run` (Confirm) | `overload-cancel` |
| Stop a gateway | `feeder-breaker` (the breaker symbol) | `feeder-breaker-confirm` | `feeder-breaker-cancel` |

Starting a gateway (breaker open to closed) acts at once on `feeder-breaker`, with no question.

## Other hooks

| id | where |
|---|---|
| `diagram` | the single-line diagram panel; `feeders` is its row of buildings |
| `feeders`, `feeder-state`, `feeder-demand`, `feeder-reserved`, `tier-note` | the row of buildings and the parts inside each `feeder`. `feeder-breaker` is a `role=switch` (`aria-checked` = the gateway is running; closed breaker). `tier-note` reads "Steps down to <n> A" when the reservation has more than one tier |
| `cluster`, `cluster-node`, `vote-strip` | the Raft cluster drawing; `cluster-node` is one per coordinator (`data-node`, `data-role`, `data-leader`); `vote-strip` carries `data-pulse` (counts commits seen) and states the majority in words |
| `council`, `applied-index`, `relay-cover`, `relay-control`, `relay-cancel` | the Coordinators table and its parts |
| `majority-alarm` | appears only without a majority (`role=alert`) |
| `reading`, `ammeter-words`, `capacity-strip`, `fairness` | the digital reading, the same reading in words for screen readers, the strip holding the three capacity figures, and the fairness score (the share of reserved amps that is even across buildings that want power) |
| `lamp-stale`, `lamp-paused`, `lamp-limit` | status items under the gauge: `data-lit` is true when the problem is active; each always carries a symbol and words |
| `feed`, `demo-plate`, `policy` | live feed status, the "Simulated data" chip (present only on simulated data, never in real mode), and the policy block |
| `ledger`, `ledger-search`, `ledger-filter`, `ledger-tear` | the Allocation log panel: search, kind filter, Export |
| `overload`, `overload-policy`, `overload-policy-fair_share`, `overload-policy-first_come`, `overload-results` | the Overload test and its policy choice |
| `sim`, `meters-rotary`, `active-meters`, `breaker-database`, `breaker-broker` | the Simulation tab; the two services are `role=switch` |
| `tab-log`, `tab-tests`, `tab-sim` | see Dock |

## Conventions

- Every status carries a symbol and a word; read the word, not the colour.
- Doors are now drawers; the `-door` suffix in ids was kept so existing scripts keep working.
- The only animation is a value or state changing (the gauge needle easing, a bar width, a drawer opening). There is no startup animation and nothing runs on its own.

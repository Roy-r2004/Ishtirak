# Stable test hooks

Every hook is a `data-testid` attribute. State that a script needs is exposed as `data-*` attributes next to it, so a check never has
to parse display text. The board is `src/board/*`; the ids below are defined in the file named in the last column.

## Required hooks

| id | count | where | state attributes |
|---|---|---|---|
| `board` | 1 | `<main>` of the whole board (Board.tsx) | `data-lamptest` (true during the load self-test), `data-demo` (true on simulated data), `data-tray` |
| `main-ammeter` | 1 | Generator dial section (Ammeter.tsx) | `data-fresh`, `data-selftest`, `data-reserved` (amps in the leader's ledger, empty when unknown), `data-capacity`, `data-peak`, `data-violations` |
| `peak-readout` | 1 | "Peak 81 A" in the readout | text is `<n> A`, or an em dash before the first fresh sample |
| `violations` | 1 | violation counter | `data-count` |
| `free-readout`, `served-readout`, `curtailed-readout` | 1 each | the three figures under the dial (Ammeter.tsx): free = capacity minus reserved, served = sum of the gateways' served amps, curtailed = requested minus served | `data-value` = the number to one decimal, empty when unknown; the text reads `<n> A`, or an em dash when the data is stale or the source is missing. Curtailed is `0 A` when nothing is curtailed, never negative |
| `capacity-proof` | 1 | one-line proof under the dial | `data-state` = `none` / `safe` / `violated`; text starts "No violation observed" when safe |
| `feeder` | 3 | one per building (Feeders.tsx) | `data-building` (`hamra`, `mar_mikhael`, `achrafieh`), `data-state` (text such as "Within budget"), `data-online`, `data-stale` |
| `relay` | 3 | one per coordinator (Council.tsx) | `data-node` (`coordinator1..3`), `data-role` (`Leader`, `Follower`, `Candidate`, `Unreachable`), `data-stale` |
| `help-open` | 1 | "Commissioning notes" button (TopPlate.tsx) | |
| `help-dialog` | 1 | the modal (Doors.tsx), exists only while open | |
| `meters-10`, `meters-50`, `meters-200` | 1 each | rotary options (TestPanel.tsx) | `aria-checked`, `data-selected` |
| `sim-apply` | 1 | "Apply" under the fader | `disabled` while an action is in flight |
| `ledger-row` | n | one per audit event, newest first (Ledger.tsx) | `data-kind` (`granted`, `shrunk`, `reclaimed`) |
| `ledger-open` | 1 | "Full ledger" button on the Ledger plate (Ledger.tsx); opens the full-ledger door | `aria-haspopup=dialog` |
| `ledger-door`, `ledger-door-close` | 1 each | the full-ledger door (Doors.tsx), exists only while open; Escape closes it and focus returns to `ledger-open` | |
| `ledger-door-row` | n | one per event in the door, newest first, at most 100; columns Event, Building, Entry, Amps, Version, Time | `data-kind` (`granted`, `shrunk`, `reclaimed`) |
| `cluster-open` | 1 | "Cluster details" button on the Council plate (Council.tsx); opens the cluster door | `aria-haspopup=dialog` |
| `cluster-door`, `cluster-door-close` | 1 each | the cluster-details door, exists only while open; Escape closes it and focus returns to `cluster-open` | |
| `recorder-open-bottom` | 1 | second "Chart recorder" button in the footer at the bottom of the board (Board.tsx); toggles the same tray as `recorder-open` | `aria-expanded` (same value as `recorder-open`) |
| `scenario` | 4 | leader failover, majority loss, gateway crash, database outage | `data-scenario` (scenario id, e.g. `leader-failover`), `data-state` (`idle`, `running`, `restoring`, `done`, `timeout`, `cancelled`) |
| `scenario-cover` | 4 | flip-up cover, inside each `scenario` | `aria-expanded` |
| `scenario-run` | 4 | the press button under the cover, inside each `scenario` | `disabled` until the cover is lifted and while another run is active |
| `scenario-status` | 1 | live status window (`role=status`) | `data-state`; text contains "Completed" when a run finished |
| `timeline-item` | n | rows of the event recorder | `data-kind` (`leader_elected`, `leader_lost`, `node_down`, `node_up`, `quorum_lost`, `quorum_restored`) |
| `policy-switch` | 1 | rotary selector in the top plate (TopPlate.tsx) | |
| `policy-fair_share`, `policy-first_come` | 1 each | the two options of the policy switch | `aria-checked`, `data-selected` |
| `overload-run` | 1 | press button of the Overload scenario | |

## Other hooks

| id | where |
|---|---|
| `demo-plate` | permanent "Simulated data" plate; present only when the board runs on the in-browser simulator, never in real mode |
| `feed` | live socket or polling lamp with the "Updated" time |
| `policy` | the whole policy block (switch plus its one-sentence explanation) |
| `reading` | digital readout under the dial; `ammeter-words` is the same reading in words for screen readers |
| `lamp-stale`, `lamp-paused`, `lamp-limit` | meter annunciator lamps; `data-lit`, `data-tone` |
| `council`, `vote-strip`, `majority-alarm`, `applied-index` | council section; the vote strip carries `data-pulse` (counts commits seen); the alarm plate appears only without a majority |
| `relay-cover`, `relay-control` | guarded stop or start control on each relay |
| `feeders`, `fairness`, `feeder-open`, `feeder-breaker`, `feeder-demand`, `feeder-reserved`, `feeder-state`, `tier-note` | feeder section and the parts inside each `feeder`; `feeder-breaker` is a `role=switch` (`aria-checked` = gateway running) |
| `feeder-door`, `feeder-door-close` | inspection door for one building |
| `capacity-strip` | the strip holding the three capacity figures; `data-fresh` |
| `ledger-door-search`, `ledger-door-filter`, `ledger-door-tear`, `ledger-door-caption` | inside the full-ledger door: search field, kind filter (`all`, `granted`, `shrunk` shown as Reduced, `reclaimed`), JSON export (same file and content as `ledger-tear`), and the caption "N events matching, of M held here. Full history lives in PostgreSQL." (`role=status`) |
| `cluster-facts`, `cluster-fact`, `cluster-table`, `cluster-door-node` | inside the cluster door: the facts grid; one `cluster-fact` per fact with `data-fact` (`postgres`, `majority`, `verified-at`, `reachable`, `feed`, `policy`, `fairness`) and `data-value`; the per-coordinator table; one `cluster-door-node` column header per coordinator with `data-node` and `data-role` (`Leader`, `Follower`, `Candidate`, `Unreachable`). A value that was not reported reads `unknown` (cells carry `data-unknown=true`) |
| `help-close` | close button of the notes |
| `ledger`, `ledger-search`, `ledger-filter`, `ledger-tear` | ledger tape: search field, kind filter, JSON export |
| `test-panel`, `overload`, `overload-cover`, `overload-policy`, `overload-policy-fair_share`, `overload-policy-first_come`, `overload-results` | test panel and the Overload module |
| `sim`, `meters-rotary`, `active-meters`, `breaker-database`, `breaker-broker` | meter simulator module; the breakers are `role=switch` |
| `recorder-open`, `recorder`, `recorder-chart`, `recorder-close` | chart recorder tray; `recorder-open` is the button in the top plate, `recorder-open-bottom` (above) the one at the bottom. Closing the tray returns focus to whichever button opened it |
| `notice` | action result plate; `role=status` |

## Conventions

- Lamps always carry a text label; read the label, not the colour.
- Doors are modal dialogs: focus moves inside when one opens, Tab stays inside, Escape closes, and focus goes back to the button that opened it.
- Guarded buttons need two clicks: `scenario-cover` first, then `scenario-run` (or `overload-cover`, then `overload-run`; `relay-cover`, then `relay-control`).
- The ids are the contract. Class names and layout are free to change.

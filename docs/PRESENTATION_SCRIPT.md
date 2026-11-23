# Ishtirak: presentation script and question guide

This guide explains every slide in simple English. For each slide you get what is on it, what to say, and what you must understand. At the end there is a bank of questions the doctor is likely to ask, with short honest answers.

## How to use this guide

1. Read Part 1 (the words) once. Every other part uses those words.
2. Read Part 2 (the story) until you can tell it without looking.
3. Read the slide script (Part 3) slide by slide. Say it in your own words. Short sentences are better than perfect ones.
4. Before the presentation, read Part 6 (what we did not prove). The doctor respects honesty more than a perfect-sounding answer.

Three rules for the questions:

- **Answer in two or three sentences.** Then stop. If the doctor wants more, they will ask.
- **If we did not test it, say so.** "We did not test that. We expect X, and we would test it by Y." This is a good answer.
- **When in doubt, come back to the one rule:** the total amps granted is never more than 120.

## Part 1. The words you need

| Word | Plain meaning | Everyday picture |
| --- | --- | --- |
| Generator, amps (A) | The neighbourhood generator can supply 120 amps in total. Amps are how much power a building uses. | A shared water tank: 120 litres, and three buildings want water. |
| Distributed system | Several computers that work together over a network to do one job. None of them is "the" computer. | A group chat of three people who must agree, instead of one boss. |
| Coordinator | One of our three decision programs. It keeps the shared record of who has how many amps. | One of three people holding the same notebook. |
| Gateway | One small program per building. It reads that building's meters and asks the coordinators for amps. | The building's manager who phones the coordinators. |
| Standby gateway | A second gateway for the same building, waiting. If the first one drops, the standby takes over. | A spare tyre. |
| Meter | A simulated electricity meter in a flat. We simulate 10, 50 or 200 of them. | The number on your electricity bill, updating live. |
| Ledger | The shared record of every grant. Every coordinator has an identical copy. | The notebook. |
| Raft | The voting rule our coordinators follow so their copies of the ledger always agree. We used HashiCorp's Raft library; we did not write Raft ourselves. | "A note only counts if two of the three people wrote it down." |
| Leader, follower | In Raft, one coordinator is the leader. It writes first and the others copy. If the leader dies, the others elect a new one. | The one who holds the pen. |
| Term | A number that goes up each time there is a new election. | "Round 94 of the election." |
| Majority, quorum | At least 2 of our 3 coordinators. | More than half. |
| Committed | A decision that a majority has written down, so it can no longer be lost. | "It is official now." |
| Grant | A coordinator's answer "yes, you may use this many amps". | Permission. |
| Lease | A grant that expires. If the gateway does not renew it, the amps go back to the pool. | A hotel key card that stops working at checkout. |
| Session | A gateway's identity from the moment it starts. A restarted gateway gets a new one. | A new visitor badge each day. |
| Idempotent | Doing the same request twice has the same effect as doing it once. | Pressing the lift button twice does not call two lifts. |
| Request ID | A unique label on each request, so a repeat is recognised. | A tracking number. |
| Invariant | A rule that must always be true. Ours: total granted amps is never more than 120. | "The tank can never give out more than 120 litres." |
| MQTT | A messaging system. Meters publish readings to a topic and gateways subscribe. | A noticeboard with one section per building. |
| QoS 1 | MQTT promise: the message arrives at least once, maybe twice. So duplicates can happen. | Registered post that may be delivered twice. |
| PostgreSQL | The database that keeps the history: readings and an audit log. | The filing cabinet. |
| Docker Compose | A tool that starts all our programs together on one computer. | One switch that turns everything on. |
| Monotonic clock | A clock that only measures how much time has passed. It ignores the wall-clock time. | A stopwatch, not a wall clock. |
| p50, p95 | p50 is the median: half the requests are faster. p95: 95 out of 100 are faster than this. | "Typical" and "almost worst" time. |
| Throughput | How many decisions per second the system can make. | How many customers the shop serves per minute. |
| Fault tolerance | The system keeps working safely when a part breaks. | The spare tyre again. |
| Max-min fair sharing | Nobody gets more than they asked for. Whoever asked for little gets exactly that. The rest is split equally. | Sharing a pizza: if two friends want 1 slice each, the third takes the rest. |

## Part 2. The story in one minute

There is one generator for a neighbourhood. It can give 120 amps. Three buildings, Hamra, Mar Mikhael and Achrafieh, all want power and their demand changes all day. If each building decided alone, together they could ask for more than 120 amps and overload the generator.

One boss computer is not a good answer: if it crashes, nobody gets a decision. So we use three coordinators that keep the same record and vote. A decision counts only when at least two of the three agree. Power is lent as a lease, a ticket that expires, so a crashed building cannot hold power for ever. One rule never breaks: the total granted is never more than 120 amps, even when computers fail.

We tested this by breaking the system on purpose: killing the leader, killing two of three coordinators, crashing a gateway, stopping the database. The generator was never overloaded in anything we measured. A new leader took over in about five seconds. We are also clear about what we did not prove, and we say it in the last slides.

If you only remember one sentence: **three computers vote on every grant, so by design the generator is not overloaded, even when computers fail.**

## Part 3. Slide by slide

For each slide: **On the slide** (what the audience sees), **Say** (a script you can read aloud), **Understand** (the idea behind it).

### Slide 1. Title: "Ishtirak. Shared power. Coordinated safely."

**On the slide:** The 120 A generator in the middle and the three buildings around it. The technologies: Go, MQTT, Raft, PostgreSQL, React, Docker.

**Say:** "Hello. Our project is called Ishtirak, which means subscription in Arabic. In Lebanon, neighbourhood generators share one limited supply of power between many buildings. Our question is simple: how can several computers share that supply fairly and safely, even when some of them break? We will show the problem, the idea, how we built it, a live demo where we break the system on purpose, and the measurements."

**Understand:** The generator is simulated. No real breaker is controlled. The drawing is a picture of the idea, not a measurement.

### Slide 2. The problem: "One generator, no room for error"

**On the slide:** The generator (120 A in total) and three buildings, each asking for amps on its own. Three problems: overload, single point of failure, unsafe replacement.

**Say:** "Picture one generator for a whole neighbourhood, rated at 120 amps. The three buildings all want power and their demand changes all day. If each building decides alone, together they can ask for more than 120 amps and overload the generator. The obvious fix is one boss computer that decides for everyone. But if the boss crashes, nobody gets a decision. And its replacement must know what was already promised, or it could promise the same amps twice. So one computer is not enough."

**Understand:** Three difficulties: (1) many requests at the same time can add up to too much, (2) one central computer is a single point of failure, (3) a replacement computer must know what is already promised. This slide is your answer to the rubric item "problem definition": a clear problem, with significance (a power overload) and complexity (computers and networks fail).

### Slide 3. The idea: "Three votes, expiring tickets, one rule"

**On the slide:** Three big points: 3 coordinators vote; 2 of 3 decide; 12 s tickets. Then the one rule: total granted amps is at most 120 A.

**Say:** "Here is the whole idea in plain words. One: we do not trust one computer. We use three coordinators that keep identical copies of the same record, and a protocol called Raft keeps them in agreement. Two: a decision only counts when at least two of the three have written it down. If one is down, the other two carry on. Three: power is lent as a lease, a ticket that expires after twelve seconds. If it is not renewed, the amps go back to the pool. And one rule never breaks: the sum of granted amps stays at or below 120, even when computers fail."

**Understand:** Majority voting is what removes the single point of failure. Leases are what stop a dead building from keeping power for ever. The one rule is the safety property the whole project protects. We say "by design, and in every run we observed". We did not prove it formally.

### Slide 4. Architecture: "Fourteen services, one agreed ledger"

**On the slide:** A left-to-right diagram: meter simulators, MQTT broker (Mosquitto), three gateways, the Raft cluster of three coordinators, PostgreSQL, and the React dashboard with a local controller. A legend maps the brief's example components (database, application, logging service) to our system.

**Say:** "Read this from left to right. Simulated meters send readings through an MQTT broker, which is like a post office, to three gateways, one per building. Each gateway asks the three coordinators for power, and those three keep one shared ledger with Raft. A single PostgreSQL database keeps the history. The React dashboard and a small controller let us watch the system and break it on purpose. In total there are fourteen Docker services; each building's gateway also has a standby. The assignment suggested a database, an application and a logging service. Ours are PostgreSQL, the whole application, and the replicated audit log."

**Understand:** The fourteen services are: PostgreSQL, Mosquitto, 3 coordinators, 3 gateways, 3 standby gateways, the meter simulator, the controller, the dashboard (2 + 3 + 3 + 3 + 3 = 14). There is no separate logging program: the coordinators write the audit log, and it is copied into PostgreSQL. The brief asks for at least three components; we have many more.

### Slide 5. Why it is distributed: "Six distributed-systems ideas, all in use"

**On the slide:** Six boxes: independent processes, consensus, data partitioning, communication protocols, concurrency control, fault tolerance. A note: everything runs on one Docker host.

**Say:** "This slide links our project to the course. One, independent processes: each coordinator has its own storage and they only talk over the network. Two, consensus: Raft, where a majority must agree. Three, partitioning: we split data by building, so each building has its own gateway and its own MQTT topic. Four, communication: we use five different protocols. Five, concurrency control: many requests at once end up in one order, and the capacity check happens in that order. Six, fault tolerance: if the leader dies a new one is elected, without a majority no grants are made, and leases expire. To be honest, all of this runs on one laptop with Docker. So we simulate crashes of programs, not the loss of a whole machine."

**Understand:** The five protocols are MQTT (QoS 1), HTTP with JSON, Raft over TCP, SQL, and WebSocket. "Concurrency control" here means: every grant goes through one ordered log, a repeated request ID gives the same answer, and the capacity check cannot be split in two. Say the honest limit yourself; it makes the rest more believable.

### Slide 6. One grant: "No grant without a majority"

**On the slide:** Five steps: request, leader appends, majority commits, lease returned, gateway enforces. A small vote illustration. Two side notes: same request ID gives the same result, and a changed payload is rejected.

**Say:** "Here is what happens for one grant. A gateway asks for some amps and attaches a unique request ID. The leader coordinator writes the request into its log and sends it to the followers. Once a majority, two of three, has stored it, it is committed, and the gateway gets a lease back. Only then does the gateway serve that power, and it serves the smaller of what the building wants and what it was granted. One follower can be down and the grant still works. Repeating the same request ID returns the same stored answer and changes nothing, so retries are safe. Using the same ID with a different amount is refused."

**Understand:** "Idempotent" means a retry is harmless. This matters because networks lose replies: the gateway cannot know whether a timed-out request was committed, so it retries with the same ID. The capacity check happens inside the replicated state machine (the code that applies committed log entries), so every coordinator reaches the same answer.

### Slide 7. Safety timing: "Safe expiry, even when clocks drift"

**On the slide:** A timeline from 0 s. The gateway may serve until 10 s. The coordinator keeps the capacity reserved until 12 s. Three notes: retries never restart the clock, a new leader restarts holds, only clock rates matter.

**Say:** "This is the heart of safety. A lease lasts twelve seconds. But the gateway only trusts it for ten seconds, counted from when it first sent the request. The coordinator waits the full twelve before it takes the capacity back. That two-second gap is a safety margin: the gateway has stopped before anyone else can be given the same amps. Retries never restart the clock. A new leader restarts the twelve-second wait, which only makes it safer. We only assume that the clocks tick at nearly the same speed, within one percent. The wall-clock time does not matter, only how fast time passes."

**Understand:** The danger is two buildings both using the same amps. The ten-second and twelve-second numbers are chosen so the gateway always stops first. With a 1% clock speed error, the gateway stops within about 10.10 s and the coordinator waits at least about 11.88 s. The 1% is an assumption, and we state it.

### Slide 8. The console: "Everything you see is a real observation"

**On the slide:** A screenshot of our dashboard, the "Ishtirak Console", with numbered parts: the single-line diagram, the capacity panel, the Raft cluster, and the dock below.

**Say:** "This is the console you will see in the demo. It is drawn like an electrical single-line diagram: the generator at the top, a line down to each building, and a thicker line means more amps reserved. On the right, the capacity panel shows the fixed 120 amp limit, the peak so far, and the violation counter, which should stay at zero. Below it, the Raft cluster shows which coordinator is the leader and the term. The dock at the bottom has the allocation log, the failure tests, the meter simulation and a history chart. Every number is an observation from the running system. We did not fake any history."

**Understand:** The screenshot is a live capture from the Docker stack. The console has a demo mode with simulated data, always marked "Simulated data", for use without Docker. If asked, say the screen can lag by a moment, so it is not a perfect view of the whole system.

### Slide 9. Live demo: "Break it on purpose. Watch the invariant hold."

**On the slide:** A console screenshot and four cards: leader failover, majority loss, gateway crash, database outage. A "What to watch" box.

**Say:** "Now the part we like most. The console has four failure tests. Stop the leader. Stop two of the three coordinators. Crash a gateway. Stop the database. Each asks you to confirm before it stops anything, and each puts everything back afterwards. While we do this, watch the capacity panel: the peak must stay at or below 120 and the violations must stay at zero. The list of observed events shows when the leader was lost and a new one appeared. First we will run leader failover."

**Understand:** The screenshot on this slide is from a local mock, not the live stack, and the slide says so. See Part 4 for the demo script.

### Slide 10. Gateway standby: "If a gateway drops, its standby takes over"

**On the slide:** A timeline: the primary gateway drops at 0 s; the coordinator keeps the lease for 12 s; the standby is refused until then and is granted at about 14 s. Three cards: safe by construction, readings keep flowing, honest limits.

**Say:** "A concern was raised while we were building this: each building had only one gateway, so a dropped gateway would leave its building without service. Here is our answer. Every building now has a second gateway, the standby. While the first gateway is alive, the ledger refuses a second gateway for the same building, so the standby is simply told no and asks again every two seconds. If the first gateway drops, nobody renews its lease. After the normal twelve seconds the coordinator commits the expiry, and the standby's next request is granted. It starts serving about twelve to fifteen seconds after the first gateway stopped. The standby also receives every meter reading and saves its own copy, so readings are not lost. A restarted gateway becomes the new standby."

**Understand:** The key point: **we did not need to change the voting or the safety rules.** The existing rule already refuses a second session while a lease is held, so two gateways can never use the same amps. The limits: a gap of about 12 to 15 seconds in which that building has no service, it covers gateways only (not the broker or the database), and it is tested in simulation but not yet on the Docker stack. Say the last point yourself.

### Slide 11. Fair sharing: "When demand exceeds supply, share it fairly."

**On the slide:** Two sets of bars. First come: Hamra 102 A, Mar Mikhael 7 A, Achrafieh 4 A. Fair sharing: 40 A each. Three cards: wants not claims, max-min shares, shrinks on its own clock.

**Say:** "This feature answers a fairness question. Without it, allocation is first come, first served. In a test, one building held 102 of the 120 amps while the other two held 7 and 4, for as long as the demand lasted. The generator was safe, but it was not fair. With fair sharing, every request records what the building wants. Nobody gets more than they asked for, and the rest is split equally: wants of 102, 99 and 98 amps become 40 each. A building above its share is not cut off suddenly. Its renewals are capped, its old large grant runs out after its normal twelve seconds, and the freed amps go to the others. The policy is itself a Raft command, so all three coordinators switch at the same moment."

**Understand:** Fairness can never break the 120 A rule, because a building can only grow by the amps that are free at that moment. Taking power back instantly would be unsafe: the gateway might still be using it, so we wait for the lease to expire. Measured on three real coordinator processes: 102/7/4 became 40/40/40 in about 13 seconds. Not yet repeated on the full Docker stack.

### Slide 12. Fault tolerance results

**On the slide:** A table of six scenarios and their measured results.

**Say:** "These are measured results from our evaluation run on the real Docker stack. When a gateway crashed, its lease was reclaimed in about thirteen and a half seconds on average, over three trials. This was measured before we added the standby. When the leader was stopped, a new one accepted a grant in about five seconds on average. When we stopped two coordinators, new requests failed with an error, which is the correct choice, and the simulated service fell to zero amps after thirteen seconds. When the database was down, a grant was still accepted and its audit record appeared once after the database came back. In the stress test, forty requests of seven amps each: seventeen accepted, total 119, under 120. And during the whole run we sampled the system more than a thousand times and saw no violation."

**Understand:** "Safety over availability": with no majority we refuse new grants, because granting without agreement could overload the generator. The numbers: leader failover 4.83 s (range 4.05 to 6.39); gateway crash 13.62 s (12.89 to 14.38); 323 overview samples and 947 coordinator snapshots, maximum granted 120, never above.

### Slide 13. Randomized fault check: "A randomized fault run: zero violations"

**On the slide:** Numbers: 1,559 requests, 427 accepted, 1,055 rejected, 77 unknown outcomes, 134 capacity samples, maximum 120 A, 0 violations, the same log position on all three coordinators.

**Say:** "Hand-picked tests can miss things, so we wrote a small randomized fault checker. With a fixed seed it sends more than fifteen hundred requests while services are stopped and restarted, including a window when two coordinators are down together. 427 requests were accepted and 1,055 were rejected, almost all because the capacity was full. 77 had an unknown outcome. Unknown does not mean rejected: the request may have been committed, so we retry with the same ID. The maximum granted was 120, never more, zero violations, and all three coordinators ended at the same position in the log. This is evidence from one run, not a proof."

**Understand:** The "seed" makes the random schedule repeatable. Among the 1,055 rejections, 1,054 were "capacity full" and 1 was a deliberate changed-payload replay. The honest limit: sampling cannot see a very short problem between two samples.

### Slide 14. Performance: "Decision latency near 100 ms, even at 20x the meters"

**On the slide:** A bar chart of p50 and p95 for 10, 50 and 200 meters, plus a small table with readings per second.

**Say:** "For performance, we measured how long one allocation decision takes with ten, fifty and two hundred simulated meters. The median, p50, is about 90 to 110 milliseconds. p95, the time within which 95 out of 100 requests finish, is about 130 to 170 milliseconds. Each number is the mean of five trials. Meanwhile the readings flowing through the gateways rose from about ten to almost two hundred per second. So twenty times more meters did not make decisions much slower. We are careful about one thing: the decision test itself does not create the meter load, so the readings column is what shows the volume. The laptop was also busy, so the trial spread is large."

**Understand:** p50 values: 86.6, 99.8 and 107.5 ms. p95 values: 133.1, 167.0 and 156.7 ms. Readings per second: 9.6, 48.3 and 191.6. The small differences between rows are within the spread, so do not claim that more meters make it faster or slower.

### Slide 15. Scalability limit: "Throughput plateaus near 47 decisions/s"

**On the slide:** Two line charts against the number of concurrent clients: decisions per second, and median latency.

**Say:** "We also pushed harder by adding more clients at the same time: one, four, sixteen and sixty-four. Throughput climbs and then flattens at about forty-seven decisions per second, while the waiting time keeps growing. That is what you expect when requests queue behind one step, and every grant does go through one Raft leader. But we want to be honest: we did not profile the system, so we cannot say the leader is the bottleneck. Separately, a change in demand showed up on the dashboard in about two thirds of a second on average."

**Understand:** The numbers: 26.0, 42.7, 47.5 and 47.3 decisions per second at 1, 4, 16 and 64 clients. p50 latency 35.9, 86.9, 308.1 and 336.3 ms. The cause of the ceiling is unknown. The test client and the dashboard proxy are also in the path.

### Slide 16. Trade-offs: "Every safety choice has a cost"

**On the slide:** A table of six challenges, our answer, and what it costs.

**Say:** "Here are the hard problems and what each fix costs. When a request times out we cannot know if it was committed, so we retry with the same ID, and the cost is that a valid grant may arrive too late to use. Duplicates are handled by idempotent IDs, and the request history keeps growing. A stale leader cannot erase a newer lease, because expiry is tied to the lease version and the election term. For clocks, we only rely on durations, and we use a two-second margin. If there is no majority we refuse grants, which is safety over availability. And the most interesting one: originally a renewal never shrank a reservation, so after a demand spike one building kept about a hundred amps and starved the others. Capacity was safe, fairness was not. We fixed it in two steps: first lease tiers, so older large grants expire on their own, then fair sharing."

**Understand:** This is the rubric item "solutions and trade-offs" (15 points). Tell it as a story: we found a real problem by testing, fixed it, and tested again. After the spike, every building was back within budget about 17.6 seconds later (Docker run).

### Slide 17. Critical evaluation: "What these results do not show"

**On the slide:** Three columns: not measured, stated limits, next steps. A note: no formal verification and no external review.

**Say:** "We want to be clear about what we have not shown. All tests ran on one machine, with repeats on the same setup, so they are not independent samples, and we did not inject network delay or packet loss. The full Docker evaluation of the fair-sharing build stopped after four phases, because the laptop ran out of memory. Our limits: each gateway has a standby, but the broker and the single database are not replicated. A takeover leaves a gap of about twelve to fifteen seconds, and fair sharing treats every building as equal. We have not formally verified the design and nobody outside the team has reviewed it. Next steps: testing on several machines, finding the real bottleneck, priority classes, and a secured deployment."

**Understand:** This slide earns trust. A doctor who hears the limits from you first will not need to hunt for them.

### Slide 18. Takeaways: "Three things to remember"

**On the slide:** 1. A majority decides. 2. Leases keep it safe. 3. Measured, not assumed.

**Say:** "To finish, three takeaways. One: a majority decides. Every grant needs two of the three coordinators. Two: leases, the expiring tickets, keep the total at or below 120 amps through crashes and delays. Three: we measured it. A new leader accepted grants in under five seconds on average, we saw no violation, and the decision rate tops out around fifty per second. In one sentence: three independent coordinators vote on every grant, so by design a neighbourhood generator is not overloaded, even when computers fail. Thank you. We are happy to take questions."

## Part 4. The live demo script

**Before the day (do not skip):**

1. Close the other heavy Docker containers on the laptop (this machine runs out of memory easily), then start the project with `docker compose up --build -d` and open http://localhost:8088.
2. The standby gateways have never run on the Docker stack yet. Do a full dry run at least a day before, including the Gateway crash test. If something is wrong, you have time to fix it or to say it plainly.
3. Backup plan: open the single-file demo `web\preview\index.html` (double-click). It shows simulated data and is marked "Simulated data" on screen. Build it with `cd web` then `npm run build:preview`.

**In the room, in this order (let each finish before the next):**

| Step | What you do | What you say |
| --- | --- | --- |
| 1 | Show the console. Point at the 120 A limit, the three buildings, the violation counter (0), the Raft cluster. | "Three coordinators, one is the leader. The counter at zero is the safety rule: it counts how many times total granted went over 120." |
| 2 | Top bar: policy switch. Dock, Failure tests tab, Overload test: run it with First come, then with Fair sharing. | "With first come, one building can keep most of the generator. With fair sharing the buildings converge on equal shares. In both cases the total never passes 120." |
| 3 | Failure tests: Leader failover. Press Run, then Confirm. | "We are stopping the leader. Watch the events: leader lost, then a new leader observed. The violation counter stays at zero." |
| 4 | Failure tests: Majority loss. | "Now two of three are down. There is no majority, so new grants stop. This is the correct, safe choice: we prefer to refuse than to risk an overload." |
| 5 | Failure tests: Gateway crash. | "We stop Hamra's gateway. Its standby takes over after the lease runs out, about twelve to fifteen seconds. The building shows Served by standby." |
| 6 | Failure tests: Database outage. | "The database is down but grants continue, because the decisions live in Raft. The audit log catches up when the database returns." |
| 7 | Simulation tab: switch 10, 50, 200 meters. | "More meters, more readings per second. The decisions stay fast." |

If a step fails live, stay calm and say what you see: "The test timed out. This is exactly why we test: the system restores what it stopped." Every test puts the services back.

## Part 5. The brief's rubric, and where to point

The brief (Distributed Systems final project, 40% of the final grade) grades eight things. The weight is in brackets.

| Criterion | What to point to | One sentence to say |
| --- | --- | --- |
| Problem definition (10) | Slide 2 | "A shared generator, many requests at once, and computers that fail: if we get it wrong, it overloads." |
| System design (20) | Slides 3 to 7, 10, 11 | "Three coordinators vote with Raft, grants are leases that expire, and the design is partitioned by building." |
| Implementation (15) | Slides 8, 9, 12 to 15 | "A working system in Go with fourteen Docker services, tested with failure injection and measured." |
| Distributed system challenges (10) | Slides 5, 7, 16 | "Unknown outcomes, duplicates, stale leaders, clock differences, and safety versus availability." |
| Solutions and trade-offs (15) | Slides 16, 11, 10 | "Every fix has a cost, and we found fairness and gateway problems by testing and fixed them." |
| Documentation (10) | The report (docs\PROJECT_REPORT.md and PDF), the README | "A report that explains how it is distributed, with measured results and limits." |
| Creativity and innovation (10) | Slides 9, 11, 13 | "A console that breaks the system on purpose, lease tiers, fair sharing, and a randomized fault checker." |
| Presentation (10) | This deck and the demo | Calm, honest, and the demo works. |

Requirements from the brief, and our answer:

- **At least 3 components.** Database (PostgreSQL), application (meters, gateways, coordinators, dashboard) and logging (the replicated audit log).
- **Adhere to the distributed-systems fundamentals.** Slide 5: processes, consensus, partitioning, communication, concurrency control, fault tolerance.
- **A document describing the project.** The report and the README.
- **Deliverables:** the functional system, this PowerPoint, and the documentation.

## Part 6. What we did not prove (say this before they ask)

- **One machine only.** Everything runs on one laptop in Docker. We simulate crashes of programs. We did not lose a whole computer, and we did not inject network delay or packet loss.
- **The standby gateway was not run on Docker.** It is tested with Go simulations on the real ledger and with a mock console. The first run on Docker is still to do.
- **Fair sharing was measured on three real coordinator processes, not on the full Docker stack.** On Docker, only part of the evaluation ran, and the laptop ran out of memory.
- **No formal proof.** We use tests and sampling. Sampling can miss a very short problem.
- **We used a Raft library.** We did not write Raft. The ledger, the leases, the safety rules, the gateways and the tests are ours.
- **The cause of the 47 decisions-per-second limit is unknown.** We did not profile it.
- **Single database and single broker.** If PostgreSQL or Mosquitto fails, they have no spare.
- **No real security.** There is a demo admin token. Building IDs are not authenticated.
- **The generator and the meters are simulated.**
- **The performance numbers were measured on a busy laptop.** The spread between trials is large.

## Part 7. Questions the doctor may ask

Short answers. Say them in your own words.

### The problem and the design

**1. What problem does your project solve?**
One neighbourhood generator can give 120 amps. Three buildings ask for power at the same time. We built a system that decides who gets how many amps, so the total never goes over 120, even when computers fail.

**2. Why do you need a distributed system? Why not one server and a database?**
One server is a single point of failure: if it crashes, nobody gets a decision. And its replacement would not know what was already promised. With three coordinators that vote, the system keeps working when one fails and never forgets a promise.

**3. Where exactly is it distributed?**
The three coordinators are separate programs. Each has its own log and storage. They only communicate over the network. The gateways, the broker, the database and the dashboard are also separate processes. There is no shared memory.

**4. Why three coordinators? Why not two or five?**
Three is the smallest number that survives one failure: a majority is two. With two, losing one means no majority. Five would survive two failures but costs more messages. Three is enough to show the idea.

**5. What is Raft, in simple words?**
It is a voting rule. One coordinator is the leader and writes each decision into its log. It sends the entry to the others. When a majority has written it down, it is committed and cannot be lost. If the leader dies, the others hold an election.

**6. Why Raft and not Paxos or something else?**
Raft was designed to be easier to understand and there is a mature Go library (HashiCorp Raft), so we could spend our time on the safety rules and testing. We did not write the protocol ourselves.

**7. What is the invariant, and how do you guarantee it?**
The invariant: the sum of granted amps is at most the generator capacity, 120. Three things work together. First, the check happens inside the replicated state machine, in one agreed order, so no two requests can both see the same free amps. Second, a grant only counts once a majority has committed it. Third, grants are leases that expire, and the gateway stops using a grant before the coordinator reclaims it.

**8. What does "committed" mean?**
A majority of coordinators, at least two, have stored the entry. After that, even if the leader crashes, a new leader will have it.

**9. What is a lease, and why does it expire?**
A lease is permission for some amps for a short time. If the gateway crashes it cannot renew, and without expiry its amps would be stuck for ever. Expiry returns them to the pool.

**10. Why does the gateway use ten seconds when the lease lasts twelve?**
The gateway counts ten seconds from when it first sent the request, then stops. The coordinator waits the full twelve before reclaiming. That two-second gap is a safety margin, so the gateway has stopped before anyone else can get the same amps.

**11. What if the gateway's clock runs fast or slow?**
We only rely on durations measured by a monotonic clock, not on the wall-clock time. We assume the clocks tick at nearly the same speed, within one percent. If a clock were much faster or slower, or a computer were suspended, the guarantee could break. We state that as an assumption.

**12. What does idempotent mean, and why do you need it?**
Repeating the same request has the same effect as doing it once. Networks lose replies, so a gateway cannot know if a timed-out request was committed. It retries with the same request ID, and gets the same answer.

**13. What is MQTT, and why QoS 1?**
MQTT is a lightweight messaging system with topics. Meters publish readings and gateways subscribe, one topic per building. QoS 1 means a message is delivered at least once, so duplicates are possible. Gateways remove duplicates using the reading ID.

**14. How do you partition the data?**
By building. Each building has its own MQTT topic and its own gateway, so each gateway only handles its own meters. The capacity itself is one shared number, which is why it is kept in the replicated ledger.

**15. Which communication mechanisms do you use?**
MQTT QoS 1 from meters to gateways, HTTP with JSON from gateways to coordinators, Raft over TCP between coordinators, SQL to PostgreSQL, and WebSocket from coordinators to the dashboard.

**16. How do you handle concurrency?**
Many requests arrive at the same time, but they all go through the leader into one ordered log. Each is applied one at a time by the state machine, so the capacity check is atomic and the order is the same on every coordinator.

### Failures

**17. What happens if the leader crashes?**
The followers notice, hold an election, and a new leader appears. In our tests a replacement accepted a grant after 4.83 seconds on average (three trials). No committed grant is lost, because a majority already has it.

**18. What if two of the three coordinators crash?**
There is no majority, so no new grant can be committed and the system refuses new requests. Leases then expire, and the simulated service falls to zero amps after about thirteen seconds. This is a deliberate choice: safety over availability. When the coordinators come back, service resumes.

**19. Is that the CAP theorem?**
Yes. If the network or computers split so that there is no majority, we choose consistency over availability. We would rather refuse a request than risk giving the same amps to two buildings.

**20. What if there is a network partition?**
Only the side that still has a majority can commit grants. The side with one coordinator cannot. We did not inject real network partitions or packet loss in our tests; we stopped processes. We would add network fault injection as the next step.

**21. What if a gateway crashes?**
Its lease is not renewed, so after about twelve seconds the coordinator expires it and the amps return to the pool. With the standby, a second gateway for that building is granted the lease and serves the building after about twelve to fifteen seconds. Before the standby existed, we measured the reclaim at 13.62 seconds on average.

**22. How does the standby avoid two gateways using the same amps?**
The ledger already refuses a second gateway session for a building while the first one's lease is held. So the standby is refused until the first lease expires. And each gateway only uses a grant until its own ten-second deadline. So at no moment can both use the amps.

**23. Is the standby tested?**
It is tested with Go simulations that use the real ledger and the real expiry rules with a fake clock, and in the console against a mock. We have not run it on the Docker stack yet. We say this clearly on the slide.

**24. What if a gateway and its standby both crash?**
That building has no service until one of them restarts. We do not claim to cover that.

**25. What if PostgreSQL goes down?**
Decisions continue, because they are made by Raft, not by the database. The audit entries wait in the coordinators and are written when the database returns. Readings published in the meantime can be lost if a gateway crashes.

**26. What if the MQTT broker goes down?**
The gateways stop receiving readings, so their data becomes stale. The leases still follow the same safe rules. There is only one broker, so that is a limitation.

**27. What if the whole computer fails?**
Not covered. Everything runs on one host in Docker. We show process and network-level failures, not the loss of a machine.

**28. What is an "unknown outcome"?**
A request that timed out. The coordinator may or may not have committed it. We do not treat it as rejected. The gateway retries with the same ID and gets the stored answer.

**29. What if an old leader keeps acting after a new one is elected?**
Expiry commands carry the building, the lease version and the election term. A stale leader's command is rejected, so it cannot remove a newer lease.

### Performance

**30. How did you measure performance?**
We ran the evaluation script on the Docker stack. For each of 10, 50 and 200 simulated meters we ran five trials of 200 allocation requests, and report the median (p50) and 95th percentile (p95) of the decision time.

**31. What are your results?**
Decision latency is about 87 to 108 ms at the median (p50) and about 130 to 170 ms at p95. Readings per second went from about 10 to about 190. The maximum rate is about 47 decisions per second.

**32. Why does throughput stop at about 47 decisions per second?**
It fits the fact that every grant goes through one leader and one ordered log, so requests queue. But we did not profile it, so we cannot say that is the real cause. The test client and the dashboard proxy are also in the path.

**33. Is it scalable?**
Reading volume scaled twenty times with similar decision times. Decision throughput has a ceiling around 47 per second in our setup. For a neighbourhood with three buildings that is far more than needed. For many more buildings we would partition the capacity across several groups or find the bottleneck first.

### Fairness and design choices

**34. What is fair sharing?**
When buildings want more than 120 amps in total, nobody gets more than they asked for, and the rest is split equally. For example, wants of 102, 99 and 98 amps become 40 each.

**35. Why not just take the power back from the building using too much?**
That is unsafe: the building's gateway may still be using it. We only take power back by letting the lease expire. A building above its share is capped when it renews, so its old grant runs out and the freed amps go to others.

**36. Can fair sharing break the 120 A limit?**
No. Fairness only changes how much each building asks for and gets. Any increase is limited to the amps that are free at that moment, so the total stays at or below 120 whatever the shares are.

**37. What is a lease tier?**
When a building renews, we keep each earlier, larger grant until it can no longer be used. The reservation is the largest one still alive. As old larger grants expire, the reservation steps down by itself.

**38. Why is the policy a Raft command?**
So that every coordinator switches at the same point in the log. If each one decided on its own, they could give different answers to the same request.

### Testing and honesty

**39. How did you test it?**
Go tests with the race detector, including simulations on the real ledger with delayed and reordered messages. An evaluation script on Docker that stops and restarts services. A randomized fault checker. Browser tests of the console. And a three-process test of fair sharing without Docker.

**40. Did you prove it correct?**
No. It is evidence, not a formal proof. We never saw a violation, and we explain how and where we checked. No outside person has reviewed the safety design.

**41. What did you not test?**
See Part 6: a whole machine failing, network delay and packet loss, the standby gateway on Docker, the full Docker evaluation of fair sharing, and what limits the throughput.

**42. How do you know the dashboard is not faking numbers?**
Every number is polled from the running coordinators and gateways, and there is no invented history. The demo mode with simulated data is clearly marked "Simulated data" and never appears in the real mode.

**43. What was the hardest problem you found?**
After a sudden jump in demand, one building kept about a hundred amps and the others got nearly nothing. The generator was safe but unfair. We found it by testing, fixed it first with lease tiers, and then with fair sharing.

**44. What would you do with more time?**
Test on several machines with network faults, find the real throughput bottleneck, add priorities between buildings, authenticate gateways, and replicate the broker and the database.

**45. What is creative about your project?**
A console that breaks the system on purpose with confirmation and automatic restore, lease tiers, fair sharing committed through Raft, a gateway standby that needs no change to the voting rules, and a randomized fault checker.

**46. What did you write yourselves, and what did you use?**
We used the HashiCorp Raft library, Mosquitto, PostgreSQL, Docker Compose, React and Go. We wrote the ledger and its safety rules, the leases and tiers, fair sharing, the gateways and standby, the evaluation and fault-check scripts, and the console.

**47. Is the generator real?**
No. The generator, the meters and the load limiting are simulated. The rule "never more than 120 A" is about granted amps in the software, not about real electrical equipment.

**48. What about security?**
Not production-ready. There is a demo admin token for the policy switch, and building IDs are not authenticated. We list this as a limit and a next step.

**49. Why Go?**
Go handles many concurrent tasks well and the Raft library we used is written in Go. The brief allows any language.

**50. What do you say if you do not know an answer?**
"We did not test that, or we are not sure. Our understanding is X, and this is how we would check it." Never invent a number.

## Part 8. Numbers cheat sheet

| What | Value | Where it comes from |
| --- | --- | --- |
| Generator capacity | 120 A | Fixed in the ledger |
| Buildings, coordinators, majority | 3, 3, 2 | Design |
| Docker services | 14 | 2 + 3 coordinators + 3 gateways + 3 standbys + meters + controller + dashboard |
| Lease (coordinator holds) / gateway uses | 12 s / 10 s | Safety margin 2 s |
| Leader failover | 4.83 s mean (4.05 to 6.39), 3 trials | Docker evaluation |
| Gateway crash, lease reclaimed | 13.62 s mean (12.89 to 14.38), 3 trials | Docker evaluation, before the standby |
| Majority loss | 503 errors; service 0 A after 13 s | Docker evaluation |
| Capacity stress | 40 x 7 A: 17 accepted, 23 rejected, 119 A | Docker evaluation |
| Safety sampling | 323 overviews, 947 coordinator snapshots, 0 violations, max 120 A | Docker evaluation |
| Randomized check | 1,559 requests, 427 accepted, 1,055 rejected, 77 unknown, 0 violations | Seeded 90 s run |
| Decision p50 at 10 / 50 / 200 meters | 86.6 / 99.8 / 107.5 ms | Mean of 5 trials |
| Decision p95 at 10 / 50 / 200 meters | 133.1 / 167.0 / 156.7 ms | Mean of 5 trials |
| Readings per second at 10 / 50 / 200 meters | 9.6 / 48.3 / 191.6 | Gateway counts |
| Throughput ceiling | about 47 decisions/s | Concurrency sweep, cause not profiled |
| Demand change visible on the dashboard | 0.63 s mean | 5 samples |
| Recovery after a demand spike (lease tiers) | within budget after 17.6 s | Docker evaluation |
| Fair sharing | 102/7/4 A became 40/40/40 A in about 13 s | Three real processes, no Docker |
| Gateway standby takeover | about 12 to 15 s (up to 24 s if neighbours take the freed amps) | Go simulation, not on Docker |

When you quote a number, say where it comes from. If the doctor asks for more detail, the full report is `docs\PROJECT_REPORT.md` (and the PDF), Section 6.

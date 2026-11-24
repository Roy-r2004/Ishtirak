# Ishtirak: the easy-to-memorize presentation guide

This guide matches the 19-slide deck. It is built to be learned, not just read: one short card per slide, one line to chain the whole talk, and a small code of numbers. Learn the memory sheet first. Everything else hangs on it.

## 0. How to learn it (three passes)

1. **Pass 1, ten minutes: the memory sheet (Part 1).** Say the story spine out loud, once, without looking.
2. **Pass 2, twenty minutes: the slide cards (Part 3), one act at a time.** Read the card, cover it, say the trigger words and the script, check.
3. **Pass 3, twenty minutes: the questions (Part 7).** Cover the answer. Say it. Check. Repeat the ones you missed the next day.

Say it out loud, standing up, to a friend or a wall. Reading silently does not work for speaking.

## 1. The memory sheet

### The code: 3 - 2 - 12 - 10 - 120

- **3** coordinators (the voters)
- **2** must agree (a majority)
- **12** seconds: how long the coordinator holds a lease
- **10** seconds: how long the gateway trusts it (so there is a 2-second margin)
- **120** amps: the limit that never breaks

### The numbers: 5 - 13 - 47 - 100 - 120

- **5** seconds: a new leader takes over (measured 4.83 s)
- **13** seconds: a crashed gateway's lease is reclaimed (13.62 s, measured before the standby existed)
- **47** decisions per second: the ceiling we measured (cause not profiled)
- **100** milliseconds: a decision, even with 20 times more meters (87 to 108 ms median)
- **120** amps: the generator, never exceeded

Three extra numbers: **12 to 15 s** (standby takeover gap), **40-40-40** (fair sharing of 102/7/4), **0** violations.

### The five acts of the talk

| Act | Slides | One line | Key words |
| --- | --- | --- | --- |
| 1. Problem | 1 to 2 | One generator, three askers, and computers fail. | problem |
| 2. Idea | 3 to 7 | Vote, ticket, margin. | vote, ticket, margin |
| 3. Build | 8 to 11 | See it, break it, spare it, share it. | console, tests, standby, fair |
| 4. Proof | 12 to 15 | Crash, chaos, speed, limit. | crash, chaos, speed, limit |
| 5. Honesty | 16 to 19 | Compare, cost, confess, close. | related work, trade-offs, limits, takeaways |

### The story spine: one line per slide

Say these 19 lines in a row and you have the whole talk.

1. We are Mohamad and Roy, and Ishtirak shares one generator safely.
2. One generator, three buildings, 120 amps, and computers fail.
3. So three computers vote, tickets expire, and 120 never breaks.
4. Meters, broker, gateways, three coordinators, one database: fourteen services.
5. It is distributed in six ways: Please Call Pat; Pat Can Fix.
6. A grant needs two of three votes, and repeats are harmless.
7. The gateway stops at 10, the coordinator waits until 12.
8. The console shows it live, with no invented numbers.
9. We break it on purpose and 120 holds.
10. A gateway drops, its standby takes over in 12 to 15 seconds.
11. Too much demand? Share fairly: 102, 7, 4 becomes 40, 40, 40.
12. Measured: leader back in 5 seconds, never above 120.
13. Random chaos: 1,559 requests, zero violations.
14. A decision takes about 100 milliseconds, even with 20 times the meters.
15. But it tops out near 47 decisions a second.
16. Related work: EVerest models feeder limits, we model agreement between computers.
17. Every safety choice has a cost.
18. We say what we did not prove, first.
19. A majority decides, leases keep it safe, and we measured it.

**Chain word for the whole thing:** Problem, Vote, Ticket, Show, Break, Spare, Share, Prove, Chaos, Speed, Limit, Compare, Cost, Confess, Close.

### Two phrases to learn by heart

- **Slide 5, the six ideas:** "Please Call Pat; Pat Can Fix" = **P**rocesses, **C**onsensus, **P**artitioning, **P**rotocols, **C**oncurrency, **F**ault tolerance.
- **Slide 9, the four tests:** "Little Mice Go Dancing" = **L**eader, **M**ajority, **G**ateway, **D**atabase.
- **Slide 6, the five steps of a grant:** **A**sk, **W**rite, **M**ajority, **L**ease, **S**erve ("A Wise Man Likes Soup").

### What dies, and what happens

This table answers most failure questions.

| What dies | What happens | Number |
| --- | --- | --- |
| The leader | The other two elect a new leader. Nothing committed is lost. | about 5 s |
| One follower | Nothing visible. Two of three still agree. | none |
| Two coordinators | No majority, so no new grants. Safe, not available. Service falls to 0 A. | 13 s to 0 A |
| A gateway | Its lease runs out, the standby is granted the building. | 12 to 15 s gap |
| PostgreSQL | Grants continue. The audit log catches up later. | none |
| The broker | Readings go stale. Leases still follow the same rules. Single broker is a limit. | not replicated |
| The whole laptop | Not covered. Everything runs on one host. | not tested |

### How to answer any question: Answer, Why, Number

1. **Answer** in one sentence.
2. **Why**, in one sentence.
3. **Number** if you have one (and say where it came from).

Then stop. If you did not test it: **"We did not test that. We expect X. We would test it by Y."**

## 2. The words (short list)

| Word | Plain meaning |
| --- | --- |
| Amps (A) | How much power a building uses. The generator gives 120 in total. |
| Coordinator | One of our three decision programs. They keep the same notebook. |
| Gateway | One small program per building. It asks the coordinators for amps. |
| Standby | A second gateway for the same building. A spare tyre. |
| Ledger | The shared notebook of every grant. |
| Raft | The voting rule that keeps the three notebooks identical. (We used HashiCorp's library; we did not write Raft.) |
| Leader / follower | The leader writes first, the others copy. If it dies, they elect a new one. |
| Term | The election round number. |
| Majority | Two of our three. |
| Committed | A majority wrote it down, so it cannot be lost. |
| Lease | A grant that expires. A hotel key card that stops at checkout. |
| Session | A gateway's identity. A restart gives a new one. |
| Idempotent | Doing it twice equals doing it once. Pressing the lift button twice. |
| Invariant | A rule that is always true: never more than 120 A. |
| MQTT, QoS 1 | A noticeboard with topics. QoS 1 means delivered at least once, maybe twice. |
| Monotonic clock | A stopwatch, not a wall clock. |
| p50, p95 | Typical time, and "almost worst" time (95 out of 100 are faster). |
| Max-min fair sharing | Nobody gets more than they asked for. The rest is split equally. A shared pizza. |
| EVerest | An open-source software project for EV charging sites. It splits a site's limited power among chargers using a tree of limits (breakers, fuses). |
| Energy tree | A tree of limits, such as a site limit above a feeder above several chargers. |

## 3. The slide cards

Each card has **Trigger** (the words that start your memory), **Say** (a short script) and **If asked** (one line).

### Act 1. Problem

**Slide 1. Title**
- **Trigger:** names, one generator.
- **Say:** "We are Mohamad and Roy, and our instructor is Dr. Charbel El Gemayel. Our project is Ishtirak. It shares one neighbourhood generator between buildings, safely, even when computers break."
- **If asked:** the generator is simulated; no real breaker is controlled.

**Slide 2. The problem**
- **Trigger:** many ask, one tank, boss fails.
- **Say:** "One generator, 120 amps. Three buildings ask at the same time, and their demand changes all day. If each decides alone, they can overload it. One boss computer fixes that, but if the boss crashes nobody gets a decision, and its replacement does not know what was promised."
- **If asked (why not one server?):** a single server is a single point of failure.

### Act 2. Idea

**Slide 3. The idea**
- **Trigger:** 3 vote, 2 agree, 12 seconds.
- **Say:** "Three coordinators keep the same record. A decision counts when two of them agree. Power is lent as a ticket, a lease, that expires after twelve seconds. And one rule never breaks: never more than 120 amps."
- **If asked (is it proved?):** "By design, and in every run we observed. Not formally proved."

**Slide 4. Architecture**
- **Trigger:** meter, post office, gateway, three, cabinet.
- **Say:** "Meters send readings through the broker, the post office, to three gateways, one per building. The gateways ask the three coordinators, who keep one ledger with Raft. One PostgreSQL keeps the history. The dashboard lets us watch and break things. That is fourteen Docker services, because each gateway also has a standby."
- **If asked (the brief's three components):** database is PostgreSQL, application is the whole system, logging is the replicated audit log.

**Slide 5. Why it is distributed**
- **Trigger:** Please Call Pat; Pat Can Fix.
- **Say:** "Six ways: independent processes, consensus, partitioning by building, five communication protocols, concurrency control with one ordered log, and fault tolerance. To be honest, it all runs on one laptop, so we simulate program crashes, not the loss of a machine."
- **If asked (the five protocols):** MQTT, HTTP with JSON, Raft over TCP, SQL, WebSocket.

**Slide 6. One grant**
- **Trigger:** Ask, Write, Majority, Lease, Serve.
- **Say:** "The gateway asks with a unique request ID. The leader writes it into its log. When two of three have stored it, it is committed. The gateway gets a lease and serves the smaller of what it wants and what it was granted. Repeating the same request returns the same answer, so retries are safe."
- **If asked (idempotent):** pressing the lift button twice does not call two lifts.

**Slide 7. Safety timing**
- **Trigger:** 10 and 12, margin 2.
- **Say:** "A lease lasts twelve seconds. The gateway only trusts it for ten, counted from when it first asked. The coordinator waits the full twelve. That two-second margin means the gateway has stopped before anyone else can get the same amps. We only assume clocks tick at nearly the same speed, within one percent."
- **If asked (new leader):** it restarts the twelve-second wait, which is only safer.

### Act 3. Build

**Slide 8. The console**
- **Trigger:** diagram, capacity, Raft, dock.
- **Say:** "This is our console. A thicker line means more amps reserved. The capacity panel shows the 120 amp limit, the peak, and the violation counter, which should stay at zero. The Raft panel shows the leader. The dock has the log, the failure tests, the simulation and a chart. Every number is real; we invented no history."
- **If asked:** the screen can lag a moment; demo mode with simulated data is always labelled.

**Slide 9. Break it on purpose**
- **Trigger:** Little Mice Go Dancing (leader, majority, gateway, database).
- **Say:** "Four tests: stop the leader, stop two of three coordinators, crash a gateway, stop the database. Each asks you to confirm first, and each restores everything afterwards. Watch the counter: zero violations. First we will run leader failover."
- **If asked:** this screenshot is from a local mock; the demo is live.

**Slide 10. Gateway standby**
- **Trigger:** spare tyre: refused, wait 12, granted.
- **Say:** "Our doctor pointed out that each building had only one gateway. So every building now has a standby. While the first gateway is alive, the ledger refuses a second one for that building, so the standby is told no and asks again every two seconds. If the first one drops, its lease expires after twelve seconds, and the standby is granted the building. About twelve to fifteen seconds. The standby also saves its own copy of every reading."
- **If asked (safe?):** two gateways can never use the same amps: the ledger refuses a second session while a lease is held, and each gateway stops at its own ten-second deadline. **Limits (say them yourself):** 12 to 15 second gap, gateways only, tested in simulation, not yet on Docker.

**Slide 11. Fair sharing**
- **Trigger:** 102, 7, 4 becomes 40, 40, 40.
- **Say:** "Without it, allocation is first come: one building held 102 amps while the others held 7 and 4. Safe, but not fair. With fair sharing, nobody gets more than they asked for, and the rest is split equally. Wants of 102, 99 and 98 become 40 each. A building above its share is not cut off; its old grant simply runs out after twelve seconds. The policy is a Raft command, so all three coordinators switch together."
- **If asked (can it break 120?):** no, a building can only grow by the amps free at that moment. Measured on three real processes in about 13 s; not yet on the full Docker stack.

### Act 4. Proof

**Slide 12. Fault tolerance results**
- **Trigger:** 5, 13, 0 A, 119.
- **Say:** "Leader stopped: a replacement accepted a grant in about 5 seconds. Gateway crashed: lease reclaimed in about 13 and a half seconds, measured before the standby. Two coordinators down: new requests refused, service falls to zero after 13 seconds, which is the safe choice. Database down: grants continue. Stress test: forty requests of 7 amps, seventeen accepted, 119 amps, under 120."
- **If asked (samples):** 323 overviews and 947 coordinator snapshots, no violation, maximum 120.

**Slide 13. Randomized fault check**
- **Trigger:** 1,559 requests, zero violations.
- **Say:** "Hand-picked tests can miss things, so we wrote a random fault checker. With a fixed seed it sent 1,559 requests while services were stopped and restarted, including a window with two coordinators down. 427 accepted, 1,055 rejected, 77 unknown. Maximum granted 120, zero violations, and all three coordinators ended at the same log position. Evidence from one run, not a proof."
- **If asked (unknown):** a timeout may still have committed, so we retry with the same ID.

**Slide 14. Performance**
- **Trigger:** about 100 ms at 10 or 200 meters.
- **Say:** "We timed one allocation decision with 10, 50 and 200 meters. The median is about 90 to 110 milliseconds, and p95 is about 130 to 170. Readings per second grew from about 10 to almost 200. So twenty times more meters did not slow decisions much. The laptop was busy, so the spread is large."
- **If asked (p50 / p95):** typical time, and the time within which 95 of 100 requests finish.

**Slide 15. Scalability limit**
- **Trigger:** 47, and we do not know why.
- **Say:** "With more simultaneous clients, throughput flattens at about 47 decisions a second while waiting time grows. That fits every grant going through one Raft leader, but we did not profile it, so we cannot say the leader is the cause."
- **If asked:** a demand change reached the dashboard in about 0.6 seconds.

### Act 5. Honesty

**Slide 16. Related work: EVerest**
- **Trigger:** EVerest = tree of limits; us = one limit, agreeing computers.
- **Say:** "We compared our approach with EVerest, an open-source EV-charging software project. It also shares limited power among consumers, but it models the whole site as a tree of limits, for example a feeder above several chargers. We have one limit, the 120 amp generator. Our example: suppose the last two buildings share an 80 amp feeder. Their 110 amps fit the generator but exceed the feeder by 30. Our system does not model that, and that is a hypothetical example. What we focus on is that a grant counts only when two of three coordinators commit it."
- **If asked (is EVerest worse?):** "No. It solves a different problem. The documentation we read describes a central energy manager and says nothing about replication. We do not claim our system is better."
- **If asked (do you use EVerest?):** no, it is related work only.

**Slide 17. Trade-offs**
- **Trigger:** every fix has a cost; the spike story.
- **Say:** "Timeouts: retry with the same ID, cost: a grant may arrive too late. Duplicates: idempotent IDs, cost: history grows. Stale leader: expiry is tied to the term. Clocks: only durations, with a margin. No majority: no grants, which is safety over availability. And our best story: after a demand spike, one building kept about 100 amps and starved the others. Safe, but unfair. We fixed it twice: lease tiers, then fair sharing."
- **If asked:** after the spike, every building was back within budget about 17.6 seconds later.

**Slide 18. What these results do not show**
- **Trigger:** say the limits first.
- **Say:** "One machine only, with repeated runs. No network delay or packet loss injected. The full Docker evaluation of fair sharing stopped after four phases because the laptop ran out of memory. The standby covers gateways only; the broker and the database are single. Takeover leaves a gap of 12 to 15 seconds. No formal proof, and no outside review. Next: several machines, find the bottleneck, priorities, a secured deployment."
- **If asked:** an honest list earns trust.

**Slide 19. Takeaways**
- **Trigger:** majority, leases, measured.
- **Say:** "One: a majority decides, two of three. Two: leases keep the total under 120 through crashes. Three: we measured it: leader back in about five seconds, no violation, about 47 decisions a second. In one sentence: three independent coordinators vote on every grant, so by design the generator is not overloaded, even when computers fail. Thank you. Questions?"

## 4. The live demo (short)

**Before the day**
1. Close your other heavy Docker containers, then `docker compose up --build -d` and open http://localhost:8088.
2. **The standby gateways have never run on Docker.** Rehearse the Gateway crash test at least a day early.
3. **Backup:** double-click `web\preview\index.html` (simulated data, clearly labelled).

**In the room, one at a time**
1. **Show the console.** "Zero on the counter means the total never went over 120."
2. **Overload test,** first come, then fair sharing. "First come lets one building keep most; fair sharing converges on equal shares. Both stay under 120."
3. **Leader failover.** "Leader lost, new leader, counter still zero."
4. **Majority loss.** "No majority, no new grants. We prefer to refuse than risk overload."
5. **Gateway crash.** "Its standby takes over after the lease runs out: Served by standby."
6. **Database outage.** "Grants continue. The audit catches up later."
7. **Meters 10, 50, 200.** "More readings, decisions stay fast."

If a step fails live: stay calm. "The test timed out. This is why we test. It restores what it stopped."

## 5. The rubric (what the doctor grades)

| Criterion (weight) | Slides | One sentence |
| --- | --- | --- |
| Problem definition (10) | 2 | A shared generator, many requests at once, and computers that fail. |
| System design (20) | 3 to 7, 10, 11 | Three coordinators vote, grants are leases, data is partitioned by building. |
| Implementation (15) | 8, 9, 12 to 15 | A working system, fourteen services, tested and measured. |
| Distributed system challenges (10) | 5, 7, 17 | Unknown outcomes, duplicates, stale leaders, clocks, safety versus availability. |
| Solutions and trade-offs (15) | 17, 11, 10, 16 | Every fix has a cost, and we found real problems by testing. |
| Documentation (10) | The report and README | How it is distributed, with measured results and limits. |
| Creativity and innovation (10) | 9, 11, 13 | A console that breaks the system on purpose, lease tiers, fair sharing, a random fault checker. |
| Presentation (10) | The deck and demo | Calm, honest, and the demo works. |

The brief requires at least 3 components (database, application, logging), a document, and three deliverables: the system, the PowerPoint, the documentation.

## 6. Say it first: what we did not prove

1. **One machine only.** We simulate program crashes, not a lost computer, and no network delay or packet loss.
2. **The standby was not run on Docker.** Go simulation on the real ledger, and a mock console.
3. **Fair sharing:** measured on three real processes, only partly on Docker (the laptop ran out of memory).
4. **No formal proof,** and no outside review. Sampling can miss a very short problem.
5. **We used a Raft library.** We wrote the ledger, leases, safety rules, gateways, tests and console.
6. **The cause of the 47-per-second limit is unknown.**
7. **Single database, single broker.** No spare.
8. **We model one limit only.** No tree of feeder limits like the EVerest example.
9. **No real security,** only a demo admin token.
10. **Everything is simulated:** the generator and the meters.

## 7. The questions (cover the answer, say it, check)

### The problem and the design

1. **What problem do you solve?** One 120 amp generator, three buildings asking at once. We make sure the total never goes over 120, even when computers fail.
2. **Why distributed, not one server?** One server is a single point of failure, and its replacement would not know what was promised. Three voters keep working when one fails.
3. **Where is it distributed?** Three separate coordinator programs with their own storage, talking only over the network. Gateways, broker, database and dashboard are separate processes too.
4. **Why three coordinators?** Three is the smallest number that survives one failure: two is a majority. Five would survive two but costs more messages.
5. **What is Raft?** A voting rule. The leader writes, followers copy, and when two of three have it, it is committed. If the leader dies, they elect a new one.
6. **Why Raft, not Paxos?** Raft is easier to understand and there is a mature Go library, so we spent our time on the safety rules and testing.
7. **How do you guarantee the 120 A rule?** Three things: the check runs inside one agreed order, a grant counts only after a majority commits it, and grants are leases that expire, with the gateway stopping first.
8. **What is committed?** At least two coordinators stored it, so even a crashed leader cannot lose it.
9. **Why does a lease expire?** A crashed gateway cannot renew, and without expiry its amps would be stuck for ever.
10. **Why 10 seconds for the gateway and 12 for the coordinator?** The two-second gap is a margin so the gateway has stopped before anyone else can get the same amps.
11. **What if a clock is wrong?** We only use durations on a monotonic clock and assume nearly the same speed, within one percent. A big error, or a suspended computer, could break the guarantee. We state that.
12. **What is idempotent, and why?** Doing a request twice equals once. A timed-out request may or may not have committed, so the gateway retries with the same ID and gets the same answer.
13. **MQTT and QoS 1?** Meters publish to topics, gateways subscribe. QoS 1 means at least once, so duplicates happen, and gateways drop them using the reading ID.
14. **How do you partition?** By building: one gateway and one MQTT topic each. The capacity is one shared number, so it lives in the ledger.
15. **Which protocols?** MQTT, HTTP with JSON, Raft over TCP, SQL, WebSocket.
16. **Concurrency?** All requests go through the leader into one ordered log and are applied one at a time, so the capacity check is atomic and identical on every coordinator.

### Failures

17. **Leader crashes?** A new leader is elected. A replacement accepted a grant in 4.83 seconds on average (three trials). Nothing committed is lost.
18. **Two coordinators crash?** No majority, so no new grants. Service falls to zero after about 13 seconds. That is safety over availability.
19. **Is that CAP?** Yes. With no majority we choose consistency over availability.
20. **Network partition?** Only the side with a majority can commit. We did not inject real partitions; we stopped processes. It is a next step.
21. **Gateway crashes?** Its lease expires after about 12 seconds and the standby is granted the building: a gap of about 12 to 15 seconds. Before the standby existed we measured reclamation at 13.62 seconds.
22. **How does the standby avoid double use?** The ledger refuses a second session while a lease is held, and each gateway stops at its own ten-second deadline.
23. **Is the standby tested?** With Go simulations on the real ledger and a mock console. Not yet on Docker, and the slide says so.
24. **Gateway and standby both crash?** That building has no service until one restarts. We do not claim to cover that.
25. **PostgreSQL down?** Decisions continue because Raft makes them. The audit catches up later. Readings can be lost if a gateway crashes in the meantime.
26. **Broker down?** Readings go stale. Leases follow the same rules. A single broker is a limit.
27. **Whole computer fails?** Not covered. Everything runs on one host.
28. **What is an unknown outcome?** A timeout. It may have committed, so we do not treat it as rejected; we retry with the same ID.
29. **Old leader still acting?** Expiry commands carry the building, lease version and election term, so a stale leader cannot remove a newer lease.

### Performance

30. **How did you measure?** An evaluation script on Docker: for 10, 50 and 200 meters, five trials of 200 requests, reporting median (p50) and p95.
31. **Results?** About 87 to 108 ms median, about 130 to 170 ms p95. Readings went from about 10 to about 190 per second. Ceiling about 47 decisions a second.
32. **Why 47?** It fits one leader and one ordered log, so requests queue. We did not profile it, so we cannot say that is the cause.
33. **Scalable?** Reading volume scaled twenty times with similar decision times. Throughput has a ceiling, far above what three buildings need.

### Fairness and design choices

34. **Fair sharing?** Nobody gets more than they asked for, the rest is split equally. 102, 99, 98 becomes 40 each.
35. **Why not take power back?** Unsafe: the gateway may still be using it. We let the lease expire.
36. **Can fairness break 120?** No. A building can only grow by the amps free at that moment.
37. **Lease tier?** We keep each earlier, larger grant until it can no longer be used. The reservation steps down by itself as they expire.
38. **Why is the policy a Raft command?** So all coordinators switch at the same point in the log.

### Related work

39. **How does it compare with existing systems?** EVerest, an open-source EV-charging project, splits a site's power among chargers using a tree of limits. We have one generator limit and focus on safe agreement among computers. Different problems.
40. **Do you handle a feeder limit between buildings?** No. Our slide shows the gap with a hypothetical 80 amp feeder. Modelling a tree of limits is a next step.
41. **Do you use EVerest?** No. It is related work only.
42. **Is your system better than EVerest?** We do not claim that. The EVerest documentation we read describes a central energy manager and says nothing about replication or voting. Different goals.

### Testing and honesty

43. **How did you test?** Go tests with the race detector, simulations on the real ledger, an evaluation script on Docker, a randomized fault checker, browser tests of the console, and a three-process test of fair sharing.
44. **Did you prove it correct?** No. It is evidence. We never saw a violation. Nobody outside the team has reviewed it.
45. **What did you not test?** See Part 6.
46. **Is the dashboard faking numbers?** No. Every number is polled from the running system. Demo mode is clearly labelled "Simulated data".
47. **Hardest problem?** After a demand spike one building kept about 100 amps and starved the others. We fixed it with lease tiers, then fair sharing.
48. **What would you do next?** Several machines with network faults, find the bottleneck, priorities, authentication, replicated broker and database, and a tree of limits.
49. **What did you write, and what did you use?** We used HashiCorp Raft, Mosquitto, PostgreSQL, Docker Compose, React and Go. We wrote the ledger and safety rules, leases and tiers, fair sharing, gateways and standby, the test scripts and the console.
50. **If you do not know?** "We did not test that. We expect X. We would test it by Y." Never invent a number.

## 8. Optional: split the talk between two people

Two voices help memory, because each of you learns half.

| Speaker | Slides | Why |
| --- | --- | --- |
| Person A | 1 to 9 | Problem, idea, build, console and the start of the demo. |
| Person B | 10 to 19 | Standby, fair sharing, proof, comparison, honesty, close. |

Agree who answers which question type: for example A takes design and protocol questions, B takes failures, performance and limits. If the other person is better placed, hand over: "Roy, do you want to take that one?"

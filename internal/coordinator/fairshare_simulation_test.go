package coordinator

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/hashicorp/raft"
	"ishtirak/internal/ledger"
)

// A convergence simulation of the fair-share policy: the real Deadlines and the real FSM, driven by modelled
// gateways. Each gateway ticks once a second like telemetry.Gateway.Run, requests ceil(demand) unless its
// usable grant already covers the demand and it asked less than 3 s ago, keeps every grant until 10 s after
// the request was sent (12 s lease minus the 2 s safety margin) and may use the largest one. Commits are
// delayed and reordered, responses are delayed, and the leader changes occasionally (Deadlines.Reset, late
// observation) exactly as in TestSimulatedReservationNeverBelowUsableGrant.

type fsStage struct {
	from           time.Duration
	demand, target map[string]int
}
type fsScenario struct {
	name   string
	start  []ledger.Request // committed under first_come before the policy switch: the starting reservations
	stages []fsStage
	end    time.Duration
}

// fsOptions are deliberate mutations of the mechanism; the scenarios must fail under each of them.
type fsOptions struct {
	noCap         bool // the policy is never switched on: renewals of an over-share building are not capped
	noWantExpiry  bool // expire_want is never proposed: a silent building's want caps the others forever
	noLeaseExpiry bool // expire is never proposed: an old, larger tier is never released
}
type fsOutcome struct {
	ok      bool
	detail  string
	settled time.Duration // time after the last stage start at which every building stayed within tolerance
}

const fsWindow = 40 * time.Second
const fsTolerance = 1

type fsPending struct {
	commit, sent, respond time.Duration
	b, id                 string
	amps                  int
}
type fsDelivery struct {
	at time.Duration
	g  gwGrant
}

func fsAbs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

func runFairShareSim(t *testing.T, seed int64, sc fsScenario, opt fsOptions) fsOutcome {
	t.Helper()
	const capacity = 120
	buildings := []string{"a", "b", "c"}
	rng := rand.New(rand.NewSource(seed))
	f := ledger.New()
	idx, term := uint64(0), uint64(1)
	app := func(c ledger.Command) ledger.Result {
		idx++
		b, _ := json.Marshal(c)
		return f.Apply(&raft.Log{Index: idx, Term: term, Data: b}).(ledger.Result)
	}
	app(ledger.Command{Kind: "init_capacity", Capacity: capacity})
	var gw []gwGrant
	for _, r := range sc.start {
		if res := app(ledger.Command{Kind: "grant", Request: r}); !res.Accepted {
			t.Fatalf("seed %d: starting grant refused: %+v", seed, res)
		}
		gw = append(gw, gwGrant{r.BuildingID, r.Amps, 10 * time.Second})
	}
	if !opt.noCap {
		if res := app(ledger.Command{Kind: "set_policy", Policy: "fair_share"}); !res.Accepted {
			t.Fatalf("seed %d: %+v", seed, res)
		}
	}
	base := time.Now()
	d := NewDeadlines(12 * time.Second)
	observe := func(at time.Duration) {
		v := f.View()
		d.Observe(strconv.Itoa(int(term)), true, v.Leases, v.Wants, base.Add(at))
	}
	observe(0)
	phase := map[string]time.Duration{}
	last := map[string]time.Duration{}
	for _, b := range buildings {
		phase[b] = time.Duration(rng.Intn(10)) * 100 * time.Millisecond
		last[b] = -time.Hour
	}
	var pending []fsPending
	var responses []fsDelivery
	nid := 0
	tick := 100 * time.Millisecond
	nextChange := time.Duration(8+rng.Intn(10)) * time.Second
	out := fsOutcome{ok: true}
	lastOut := make([]time.Duration, len(sc.stages))
	for now := time.Duration(0); now < sc.end; now += tick {
		if now >= nextChange {
			term++
			d.Reset()
			observe(now + time.Duration(rng.Intn(1000))*time.Millisecond) // the new leader observes late
			nextChange = now + time.Duration(15+rng.Intn(11))*time.Second
		}
		si := 0
		for i, st := range sc.stages {
			if st.from <= now {
				si = i
			}
		}
		stage := sc.stages[si]
		// Gateways renew once a second.
		for _, b := range buildings {
			if now < phase[b] || (now-phase[b])%time.Second != 0 {
				continue
			}
			usable := 0
			for _, g := range gw {
				if g.b == b && g.expires > now && g.amps > usable {
					usable = g.amps
				}
			}
			demand := stage.demand[b]
			if now-last[b] < 3*time.Second && demand <= usable {
				continue
			}
			last[b] = now
			if demand <= 0 {
				continue // the coordinator refuses non-positive requests before they reach the ledger
			}
			nid++
			pending = append(pending, fsPending{commit: now + time.Duration(rng.Intn(3000))*time.Millisecond, sent: now, respond: time.Duration(rng.Intn(2000)) * time.Millisecond, b: b, id: "r" + strconv.Itoa(nid), amps: demand})
		}
		sort.SliceStable(pending, func(i, j int) bool { return pending[i].commit < pending[j].commit })
		for len(pending) > 0 && pending[0].commit <= now {
			p := pending[0]
			pending = pending[1:]
			res := app(ledger.Command{Kind: "grant", Request: ledger.Request{RequestID: p.id, BuildingID: p.b, SessionID: "s", Amps: p.amps}})
			observe(now)
			if res.Accepted {
				if res.Lease.Amps > p.amps {
					t.Fatalf("seed %d t=%s: granted %d for a request of %d", seed, now, res.Lease.Amps, p.amps)
				}
				if exp := p.sent + 10*time.Second; now+p.respond < exp {
					responses = append(responses, fsDelivery{now + p.respond, gwGrant{p.b, res.Lease.Amps, exp}})
				}
			}
		}
		// The leader's expiry loop: lease tiers first, then wants, each re-checked against the committed state.
		observe(now)
		if !opt.noLeaseExpiry {
			due := d.Due(base.Add(now))
			ids := make([]string, 0, len(due))
			for id := range due {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			for _, id := range ids {
				if l, ok := f.View().Leases[id]; !ok || !l.HasTier(due[id]) {
					continue
				}
				app(ledger.Command{Kind: "expire", BuildingID: id, ExpectedVersion: due[id], ExpectedTerm: term})
				observe(now)
			}
		}
		if !opt.noWantExpiry {
			due := d.DueWants(base.Add(now))
			ids := make([]string, 0, len(due))
			for id := range due {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			for _, id := range ids {
				if w, ok := f.View().Wants[id]; !ok || w.Version != due[id] {
					continue
				}
				app(ledger.Command{Kind: "expire_want", BuildingID: id, ExpectedVersion: due[id], ExpectedTerm: term})
				observe(now)
			}
		}
		rest := responses[:0]
		for _, r := range responses {
			if r.at <= now {
				gw = append(gw, r.g)
			} else {
				rest = append(rest, r)
			}
		}
		responses = rest
		// Safety, under every policy and every mutation: reserved <= capacity, and a gateway's usable
		// authority never exceeds what the ledger has reserved for its building.
		view := f.View()
		if ledger.Granted(view) > capacity {
			t.Fatalf("seed %d t=%s: reserved %d exceeds capacity", seed, now, ledger.Granted(view))
		}
		for _, b := range buildings {
			usable := 0
			for _, g := range gw {
				if g.b == b && g.expires > now && g.amps > usable {
					usable = g.amps
				}
			}
			if usable > view.Leases[b].Amps {
				t.Fatalf("seed %d t=%s building %s: gateway can still use %d but reserved %d (%+v)", seed, now, b, usable, view.Leases[b].Amps, view.Leases[b])
			}
		}
		// Convergence: within tolerance of the stage's target for the rest of the stage.
		for _, b := range buildings {
			if fsAbs(view.Leases[b].Amps-stage.target[b]) > fsTolerance {
				lastOut[si] = now
				if now >= stage.from+fsWindow && out.ok {
					out.ok = false
					out.detail = fmt.Sprintf("t=%s (stage %d, %s after its start): reserved a=%d b=%d c=%d, target %v", now, si, now-stage.from, view.Leases["a"].Amps, view.Leases["b"].Amps, view.Leases["c"].Amps, stage.target)
				}
				break
			}
		}
	}
	if from := sc.stages[len(sc.stages)-1].from; lastOut[len(lastOut)-1] > from {
		out.settled = lastOut[len(lastOut)-1] + tick - from
	}
	return out
}

func fsScenarios() []fsScenario {
	all := func(n int) map[string]int { return map[string]int{"a": n, "b": n, "c": n} }
	hog := []ledger.Request{{RequestID: "start-a", BuildingID: "a", SessionID: "s", Amps: 102}, {RequestID: "start-b", BuildingID: "b", SessionID: "s", Amps: 7}, {RequestID: "start-c", BuildingID: "c", SessionID: "s", Amps: 4}}
	return []fsScenario{
		{name: "a: three buildings demanding 100 from a hog state", start: hog, end: 90 * time.Second,
			stages: []fsStage{{0, all(100), map[string]int{"a": 40, "b": 40, "c": 40}}}},
		{name: "b: demands 10/100/100", start: []ledger.Request{{RequestID: "start-b", BuildingID: "b", SessionID: "s", Amps: 100}, {RequestID: "start-a", BuildingID: "a", SessionID: "s", Amps: 10}, {RequestID: "start-c", BuildingID: "c", SessionID: "s", Amps: 10}}, end: 90 * time.Second,
			stages: []fsStage{{0, map[string]int{"a": 10, "b": 100, "c": 100}, map[string]int{"a": 10, "b": 55, "c": 55}}}},
		{name: "c1: a's demand drops to 5 after convergence", start: hog, end: 110 * time.Second,
			stages: []fsStage{
				{0, all(100), map[string]int{"a": 40, "b": 40, "c": 40}},
				{50 * time.Second, map[string]int{"a": 5, "b": 100, "c": 100}, map[string]int{"a": 5, "b": 58, "c": 57}}}},
		{name: "c2: a goes silent after convergence", start: hog, end: 110 * time.Second,
			stages: []fsStage{
				{0, all(100), map[string]int{"a": 40, "b": 40, "c": 40}},
				{50 * time.Second, map[string]int{"a": 0, "b": 100, "c": 100}, map[string]int{"a": 0, "b": 60, "c": 60}}}},
	}
}

func TestFairShareConvergesUnderDelaysReorderingAndLeaderChanges(t *testing.T) {
	var worst time.Duration
	for _, sc := range fsScenarios() {
		t.Run(sc.name, func(t *testing.T) {
			for seed := int64(1); seed <= 12; seed++ {
				out := runFairShareSim(t, seed, sc, fsOptions{})
				if !out.ok {
					t.Fatalf("seed %d did not converge within %s: %s", seed, fsWindow, out.detail)
				}
				if out.settled > worst {
					worst = out.settled
				}
			}
		})
	}
	t.Logf("slowest settling after the last stage began: %s (window %s)", worst, fsWindow)
}

// The simulation must have teeth: breaking any part of the mechanism makes a scenario fail to converge while the
// safety assertions (which run in every mode) still hold.
func TestFairShareSimulationFailsWhenTheMechanismIsBroken(t *testing.T) {
	scenarios := fsScenarios()
	for _, tc := range []struct {
		name     string
		scenario fsScenario
		opt      fsOptions
	}{
		{"renewals are not capped", scenarios[0], fsOptions{noCap: true}},
		{"old tiers are never released", scenarios[0], fsOptions{noLeaseExpiry: true}},
		{"ghost wants never expire", scenarios[3], fsOptions{noWantExpiry: true}},
		{"nothing is capped in the unequal-demand case", scenarios[1], fsOptions{noCap: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for seed := int64(1); seed <= 6; seed++ {
				if out := runFairShareSim(t, seed, tc.scenario, tc.opt); out.ok {
					t.Fatalf("seed %d: the scenario still converged although the mechanism is broken", seed)
				}
			}
		})
	}
}

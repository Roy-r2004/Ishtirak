package ledger

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

func setPolicy(policy string) Command {
	return Command{Kind: "set_policy", Policy: policy, OccurredAt: "2026-11-11T00:00:00Z"}
}
func expireWant(building string, version, term uint64) Command {
	return Command{Kind: "expire_want", BuildingID: building, ExpectedVersion: version, ExpectedTerm: term, OccurredAt: "2026-11-11T00:00:01Z"}
}
func wantsOf(f *FSM) map[string]Want { return f.View().Wants }
func resultCount(f *FSM) int {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return len(f.state.Results)
}
func reserved(f *FSM, building string) int {
	return f.View().Leases[building].Amps
}

// checkWantInvariants asserts every want is a clamped, positive amount keyed by its own building.
func checkWantInvariants(t *testing.T, f *FSM, context string) {
	t.Helper()
	f.mu.RLock()
	defer f.mu.RUnlock()
	if f.state.Wants == nil {
		t.Fatalf("%s: nil wants", context)
	}
	for key, w := range f.state.Wants {
		if w.BuildingID != key || w.Amps <= 0 || w.Amps > f.state.Capacity {
			t.Fatalf("%s: malformed want %q=%+v (capacity %d)", context, key, w, f.state.Capacity)
		}
	}
}
func shares(capacity int, wants map[string]int) map[string]int {
	s := State{Capacity: capacity, Wants: map[string]Want{}}
	for b, a := range wants {
		s.Wants[b] = Want{BuildingID: b, Amps: a, Version: 1}
	}
	return FairShares(s)
}

func TestFairSharesTable(t *testing.T) {
	for _, tc := range []struct {
		name     string
		capacity int
		wants    map[string]int
		want     map[string]int
	}{
		{"the hog scenario", 120, map[string]int{"a": 102, "b": 99, "c": 98}, map[string]int{"a": 40, "b": 40, "c": 40}},
		{"small building keeps its want", 120, map[string]int{"a": 10, "b": 100, "c": 100}, map[string]int{"a": 10, "b": 55, "c": 55}},
		{"equal oversubscribed", 120, map[string]int{"a": 50, "b": 50, "c": 50}, map[string]int{"a": 40, "b": 40, "c": 40}},
		{"undersubscribed", 120, map[string]int{"a": 30, "b": 30, "c": 30}, map[string]int{"a": 30, "b": 30, "c": 30}},
		{"leftover goes to the first in sorted order", 100, map[string]int{"a": 100, "b": 100, "c": 100}, map[string]int{"a": 34, "b": 33, "c": 33}},
		{"leftover ties break by building id not by insertion", 100, map[string]int{"c": 100, "b": 100, "a": 100}, map[string]int{"a": 34, "b": 33, "c": 33}},
		{"leftover prefers the smaller want", 100, map[string]int{"a": 1, "b": 100, "c": 100}, map[string]int{"a": 1, "b": 50, "c": 49}},
		{"one building", 120, map[string]int{"a": 50}, map[string]int{"a": 50}},
		{"one building above capacity is clamped", 120, map[string]int{"a": 500}, map[string]int{"a": 120}},
		{"wants above capacity are clamped", 120, map[string]int{"a": 500, "b": 500}, map[string]int{"a": 60, "b": 60}},
		{"no wants", 120, map[string]int{}, map[string]int{}},
		{"exactly full", 120, map[string]int{"a": 20, "b": 40, "c": 60}, map[string]int{"a": 20, "b": 40, "c": 60}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := shares(tc.capacity, tc.wants); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
	if got := FairShares(State{Capacity: 120}); got == nil || len(got) != 0 {
		t.Fatalf("nil wants must give an empty, non-nil map: %v", got)
	}
}
func TestFairSharesProperties(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for i := 0; i < 3000; i++ {
		capacity, n := 1+rng.Intn(200), 1+rng.Intn(8)
		wants := map[string]int{}
		for j := 0; j < n; j++ {
			wants[fmt.Sprint("b", j)] = 1 + rng.Intn(300)
		}
		got := shares(capacity, wants)
		sum, want := 0, 0
		for b, w := range wants {
			clamped := min(w, capacity)
			want += clamped
			a, ok := got[b]
			if !ok || a < 0 || a > clamped {
				t.Fatalf("case %d: building %s allocation %d outside 0..%d (%v)", i, b, a, clamped, got)
			}
			sum += a
		}
		if len(got) != n || sum > capacity {
			t.Fatalf("case %d: capacity %d wants %v -> %v", i, capacity, wants, got)
		}
		if want <= capacity && sum != want {
			t.Fatalf("case %d: undersubscribed but not every building got its want: %v -> %v", i, wants, got)
		}
		if want > capacity && sum < capacity-(n-1) {
			t.Fatalf("case %d: not work-conserving: sum %d capacity %d (%v)", i, sum, capacity, got)
		}
		// Integer max-min: a building below its want is at most one amp below any other allocation,
		// otherwise moving an amp from the larger to it would be a strict improvement.
		for b, w := range wants {
			if got[b] >= min(w, capacity) {
				continue
			}
			for o, a := range got {
				if a > got[b]+1 {
					t.Fatalf("case %d: %s=%d is below its want %d while %s=%d: %v", i, b, got[b], w, o, a, got)
				}
			}
		}
		// Map iteration order must not matter.
		for k := 0; k < 5; k++ {
			if again := shares(capacity, wants); !reflect.DeepEqual(again, got) {
				t.Fatalf("case %d: unstable result %v / %v", i, again, got)
			}
		}
	}
}

func TestHogIsCappedAndShrinksWhileStarvedGrow(t *testing.T) {
	f := initializedFSM(120)
	step := func(index uint64, term uint64, c Command) Result {
		t.Helper()
		r := apply(f, index, term, c)
		if Granted(f.View()) > 120 {
			t.Fatalf("index %d: granted %d exceeds capacity", index, Granted(f.View()))
		}
		checkInvariants(t, f, fmt.Sprint("index ", index))
		checkWantInvariants(t, f, fmt.Sprint("index ", index))
		return r
	}
	// first_come: A takes 102, B and C get 7 and 4, their larger requests are refused but recorded as wants.
	if r := step(1, 1, grant("a1", "A", "s", 102)); !r.Accepted {
		t.Fatal(r)
	}
	step(2, 1, grant("b1", "B", "s", 7))
	step(3, 1, grant("c1", "C", "s", 4))
	if r := step(4, 1, grant("b2", "B", "s", 99)); r.Reason != "capacity_exhausted" {
		t.Fatal(r)
	}
	if r := step(5, 1, grant("c2", "C", "s", 98)); r.Reason != "capacity_exhausted" {
		t.Fatal(r)
	}
	if got := wantsOf(f); !reflect.DeepEqual(got, map[string]Want{"A": {"A", 102, 1}, "B": {"B", 99, 4}, "C": {"C", 98, 5}}) {
		t.Fatalf("wants=%v", got)
	}
	if Granted(f.View()) != 113 {
		t.Fatalf("granted=%d", Granted(f.View()))
	}
	if r := step(6, 1, setPolicy("fair_share")); !r.Accepted || r.Reason != "policy_set" {
		t.Fatal(r)
	}
	// The hog's renewal is capped at its fair share; nothing is released yet.
	r := step(7, 1, grant("a2", "A", "s", 102))
	if !r.Accepted || r.Reason != "granted_partial" || r.Lease.Amps != 40 || r.Lease.Version != 7 {
		t.Fatalf("hog renewal: %+v %+v", r, r.Lease)
	}
	if Granted(f.View()) != 113 || reserved(f, "A") != 102 {
		t.Fatalf("a cap must not release the old tier: granted=%d", Granted(f.View()))
	}
	wantTiers(t, f, "A", Tier{1, 102}, Tier{7, 40})
	// Starved buildings grow only into free capacity: partial first.
	if r = step(8, 1, grant("b3", "B", "s", 99)); !r.Accepted || r.Reason != "granted_partial" || r.Lease.Amps != 14 {
		t.Fatalf("B grows by the free 7 A only: %+v %+v", r, r.Lease)
	}
	if r = step(9, 1, grant("c3", "C", "s", 98)); !r.Accepted || r.Reason != "granted_partial" || r.Lease.Amps != 4 || reserved(f, "C") != 4 {
		t.Fatalf("C has no free capacity to grow into: %+v %+v", r, r.Lease)
	}
	if Granted(f.View()) != 120 {
		t.Fatalf("granted=%d", Granted(f.View()))
	}
	// The hog's 102 tier expires on its own hold; the reservation falls to the capped tier.
	if r = step(10, 1, expire("A", 1, 1)); !r.Accepted {
		t.Fatal(r)
	}
	if reserved(f, "A") != 40 || Granted(f.View()) != 58 {
		t.Fatalf("A=%d granted=%d", reserved(f, "A"), Granted(f.View()))
	}
	if r = step(11, 1, grant("b4", "B", "s", 99)); !r.Accepted || r.Lease.Amps != 40 || r.Reason != "granted_partial" {
		t.Fatalf("%+v %+v", r, r.Lease)
	}
	if r = step(12, 1, grant("c4", "C", "s", 98)); !r.Accepted || r.Lease.Amps != 40 {
		t.Fatalf("%+v %+v", r, r.Lease)
	}
	if reserved(f, "A") != 40 || reserved(f, "B") != 40 || reserved(f, "C") != 40 || Granted(f.View()) != 120 {
		t.Fatalf("not converged: %v", f.View().Leases)
	}
	if e := lastEvent(f); e.Kind != "granted" || e.Amps != 40 {
		t.Fatalf("granted event must record the authorized amount, not the request: %+v", e)
	}
}

func TestPartialGrowthNeverExceedsFreeAndRejectionNeedsNothingToStandOn(t *testing.T) {
	f := initializedFSM(30)
	apply(f, 1, 1, setPolicy("fair_share"))
	if r := apply(f, 2, 1, grant("a", "A", "s", 25)); !r.Accepted || r.Reason != "granted" || r.Lease.Amps != 25 {
		t.Fatalf("a lone building gets what it asks for: %+v", r)
	}
	// wants {A:25, B:20}: B's fair share is 15 but only 5 A are free.
	r := apply(f, 3, 1, grant("b", "B", "s", 20))
	if !r.Accepted || r.Reason != "granted_partial" || r.Lease.Amps != 5 || reserved(f, "B") != 5 || Granted(f.View()) != 30 {
		t.Fatalf("growth must be limited to the free capacity: %+v %+v", r, r.Lease)
	}
	// B renews with nothing free: it keeps what it holds (a renewal at its reservation is never refused).
	if r = apply(f, 4, 1, grant("b2", "B", "s", 20)); !r.Accepted || r.Lease.Amps != 5 || Granted(f.View()) != 30 {
		t.Fatalf("%+v %+v", r, r.Lease)
	}
	// A building with no lease and nothing free is the only refused case.
	r = apply(f, 5, 1, grant("c", "C", "s", 10))
	if r.Accepted || r.Reason != "capacity_exhausted" || r.Lease != nil || reserved(f, "C") != 0 {
		t.Fatalf("%+v", r)
	}
	if w := wantsOf(f)["C"]; w != (Want{"C", 10, 5}) {
		t.Fatalf("a refused request still records its want: %+v", w)
	}
	checkInvariants(t, f, "end")
	checkWantInvariants(t, f, "end")
}

func TestExpireWantFencesAndGhostWantsStopCapping(t *testing.T) {
	f := initializedFSM(120)
	apply(f, 1, 1, setPolicy("fair_share"))
	apply(f, 2, 1, grant("a1", "A", "s", 100))
	apply(f, 3, 1, grant("b1", "B", "s", 100)) // B stops here: its want becomes a ghost
	if r := apply(f, 4, 1, grant("a2", "A", "s", 100)); r.Lease.Amps != 60 {
		t.Fatalf("A capped by B's want: %+v", r.Lease)
	}
	apply(f, 5, 1, expire("A", 2, 1))
	if reserved(f, "A") != 60 || reserved(f, "B") != 20 {
		t.Fatalf("A=%d B=%d", reserved(f, "A"), reserved(f, "B"))
	}
	if r := apply(f, 6, 1, grant("a3", "A", "s", 100)); r.Lease.Amps != 60 || reserved(f, "A") != 60 {
		t.Fatalf("a ghost want must keep capping A at 60 although 40 A are free: %+v", r.Lease)
	}
	before := fullState(t, f)
	for i, c := range []struct {
		building      string
		version, term uint64
	}{{"B", 99, 1}, {"B", 0, 1}, {"B", 3, 2}, {"B", 3, 0}, {"nobody", 3, 1}} {
		if r := apply(f, uint64(10+i), 1, expireWant(c.building, c.version, c.term)); !r.Accepted || r.Reason != "want_expired" {
			t.Fatalf("case %d: %+v", i, r)
		}
		if fullState(t, f) != before {
			t.Fatalf("case %d changed state", i)
		}
	}
	// A stale version (B refreshed its want after the hold started) must not remove the fresh want.
	apply(f, 20, 1, grant("b2", "B", "s", 100))
	if w := wantsOf(f)["B"]; w.Version != 20 || reserved(f, "B") != 60 {
		t.Fatalf("%+v B=%d", w, reserved(f, "B"))
	}
	pre := fullState(t, f)
	apply(f, 21, 1, expireWant("B", 3, 1))
	if fullState(t, f) != pre {
		t.Fatal("stale want version removed a refreshed want")
	}
	// B goes silent for good: its last want is removed, then its reservation expires.
	if r := apply(f, 22, 1, expireWant("B", 20, 1)); !r.Accepted {
		t.Fatal(r)
	}
	if _, ok := wantsOf(f)["B"]; ok {
		t.Fatal("matching expire_want did not remove the want")
	}
	if got := FairShares(f.View())["A"]; got != 100 {
		t.Fatalf("A's fair share after the ghost is gone: %d", got)
	}
	// Removing a want releases nothing: A still cannot grow past the free capacity.
	if r := apply(f, 23, 1, grant("a4", "A", "s", 100)); !r.Accepted || r.Lease.Amps != 60 || reserved(f, "A") != 60 {
		t.Fatalf("%+v %+v", r, r.Lease)
	}
	apply(f, 24, 1, expire("B", 20, 1))
	if r := apply(f, 25, 1, grant("a5", "A", "s", 100)); !r.Accepted || r.Reason != "granted" || r.Lease.Amps != 100 || reserved(f, "A") != 100 {
		t.Fatalf("A must grow into the freed share: %+v %+v", r, r.Lease)
	}
	checkInvariants(t, f, "end")
	checkWantInvariants(t, f, "end")
}

func TestClampingOfRequestsAboveCapacity(t *testing.T) {
	f := initializedFSM(120)
	apply(f, 1, 1, setPolicy("fair_share"))
	r := apply(f, 2, 1, grant("big", "A", "s", 500))
	if !r.Accepted || r.Reason != "granted_partial" || r.Lease.Amps != 120 {
		t.Fatalf("fair_share clamps instead of rejecting: %+v %+v", r, r.Lease)
	}
	if w := wantsOf(f)["A"]; w != (Want{"A", 120, 2}) {
		t.Fatalf("want must be clamped to capacity: %+v", w)
	}
	// A competitor with an absurd request is refused (nothing is free) but its clamped want caps the hog.
	if r = apply(f, 3, 1, grant("big2", "B", "s", 1<<30)); r.Accepted || r.Reason != "capacity_exhausted" {
		t.Fatalf("%+v", r)
	}
	if w := wantsOf(f)["B"]; w != (Want{"B", 120, 3}) {
		t.Fatalf("%+v", w)
	}
	if got := FairShares(f.View()); !reflect.DeepEqual(got, map[string]int{"A": 60, "B": 60}) {
		t.Fatalf("%v", got)
	}
	if r = apply(f, 4, 1, grant("big3", "A", "s", 500)); !r.Accepted || r.Lease.Amps != 60 || reserved(f, "A") != 120 {
		t.Fatalf("hog renewal must be capped at its share: %+v %+v", r, r.Lease)
	}
	if r = apply(f, 5, 1, grant("bad", "C", "s", 0)); r.Accepted || r.Reason != "invalid_request" {
		t.Fatalf("zero stays invalid: %+v", r)
	}
	if r = apply(f, 6, 1, grant("bad2", "C", "s", -5)); r.Accepted || r.Reason != "invalid_request" {
		t.Fatalf("negative stays invalid: %+v", r)
	}
	if _, ok := wantsOf(f)["C"]; ok {
		t.Fatal("invalid request recorded a want")
	}
	g := initializedFSM(120)
	if r = apply(g, 1, 1, grant("big", "A", "s", 121)); r.Accepted || r.Reason != "invalid_request" {
		t.Fatalf("first_come must still reject requests above capacity: %+v", r)
	}
	if len(wantsOf(g)) != 0 || Granted(g.View()) != 0 {
		t.Fatal("invalid request left state behind")
	}
	apply(g, 2, 1, setPolicy("first_come"))
	if r = apply(g, 3, 1, grant("big2", "A", "s", 500)); r.Reason != "invalid_request" {
		t.Fatalf("explicit first_come must reject requests above capacity: %+v", r)
	}
}

func TestRejectedAndReplayedRequestsRecordNoWant(t *testing.T) {
	f := initializedFSM(120)
	apply(f, 1, 1, setPolicy("fair_share"))
	first := apply(f, 5, 1, grant("r1", "A", "s", 50))
	if w := wantsOf(f)["A"]; w != (Want{"A", 50, 5}) {
		t.Fatalf("%+v", w)
	}
	// Another session of the same building is refused and records nothing.
	if r := apply(f, 6, 1, grant("r2", "A", "other", 70)); r.Reason != "building_session_active" {
		t.Fatal(r)
	}
	if w := wantsOf(f)["A"]; w != (Want{"A", 50, 5}) {
		t.Fatalf("session_active request changed the want: %+v", w)
	}
	for i, req := range []Request{{"", "A", "s", 10}, {"x1", "", "s", 10}, {"x2", "A", "", 10}, {"x3", "A", "s", 0}, {string(bytes.Repeat([]byte("i"), 129)), "A", "s", 10}} {
		if r := apply(f, uint64(10+i), 1, Command{Kind: "grant", Request: req}); r.Accepted || r.Reason != "invalid_request" {
			t.Fatalf("case %d: %+v", i, r)
		}
	}
	if w := wantsOf(f)["A"]; w != (Want{"A", 50, 5}) || len(wantsOf(f)) != 1 {
		t.Fatalf("invalid requests changed wants: %v", wantsOf(f))
	}
	apply(f, 7, 1, grant("r3", "A", "s", 30)) // refreshes the want
	if w := wantsOf(f)["A"]; w != (Want{"A", 30, 7}) {
		t.Fatalf("%+v", w)
	}
	before := fullState(t, f)
	replay := apply(f, 8, 1, grant("r1", "A", "s", 50))
	a, _ := json.Marshal(first)
	b, _ := json.Marshal(replay)
	if !bytes.Equal(a, b) || fullState(t, f) != before {
		t.Fatalf("a replayed request must return the stored result and change nothing: %s / %s", a, b)
	}
	if r := apply(f, 9, 1, grant("r1", "A", "s", 51)); r.Reason != "request_id_conflict" || fullState(t, f) != before {
		t.Fatalf("%+v", r)
	}
}

func TestSetPolicy(t *testing.T) {
	f := initializedFSM(120)
	before := fullState(t, f)
	for _, p := range []string{"", "FAIR_SHARE", "fair-share", "bogus", " first_come"} {
		if r := apply(f, 1, 1, setPolicy(p)); r.Accepted || r.Reason != "invalid_policy" || fullState(t, f) != before {
			t.Fatalf("policy %q: %+v", p, r)
		}
	}
	if s := f.View(); s.FairShare || s.PolicyConfigured {
		t.Fatalf("%+v", s)
	}
	if r := apply(f, 2, 1, setPolicy("first_come")); !r.Accepted || r.Reason != "policy_set" {
		t.Fatal(r)
	}
	if s := f.View(); s.FairShare || !s.PolicyConfigured {
		t.Fatalf("explicit first_come must mark the policy configured: %+v", s)
	}
	apply(f, 3, 1, setPolicy("fair_share"))
	if s := f.View(); !s.FairShare || !s.PolicyConfigured {
		t.Fatalf("%+v", s)
	}
	apply(f, 4, 1, setPolicy("first_come"))
	if s := f.View(); s.FairShare || !s.PolicyConfigured {
		t.Fatalf("%+v", s)
	}
	if f.View().EventCounter != 0 {
		t.Fatal("set_policy must not touch the outbox")
	}
}
func TestPolicySwitchReplaysIdenticallyOnEveryReplica(t *testing.T) {
	// The same committed log must give the same decisions on every replica and on a replay: the policy is
	// switched by a log entry, never by node-local state.
	log := []logEntry{
		{1, 1, grant("a1", "A", "s", 102)}, {2, 1, grant("b1", "B", "s", 7)}, {3, 1, grant("c1", "C", "s", 99)},
		{4, 1, setPolicy("fair_share")},
		{5, 1, grant("a2", "A", "s", 102)}, {6, 1, grant("b2", "B", "s", 99)}, {7, 2, grant("c2", "C", "s", 500)},
		{8, 2, expire("A", 1, 2)}, {9, 2, expireWant("C", 7, 2)}, {10, 2, setPolicy("first_come")},
		{11, 2, grant("a3", "A", "s", 90)}, {12, 3, setPolicy("fair_share")}, {13, 3, grant("c3", "C", "s", 500)},
	}
	var states, results []string
	for replica := 0; replica < 3; replica++ {
		f := initializedFSM(120)
		var rs string
		for _, e := range log {
			b, _ := json.Marshal(apply(f, e.index, e.term, e.cmd))
			rs += string(b)
		}
		results, states = append(results, rs), append(states, fullState(t, f))
	}
	for i := 1; i < 3; i++ {
		if results[i] != results[0] || states[i] != states[0] {
			t.Fatalf("replica %d diverged:\n%s\n%s", i, states[i], states[0])
		}
	}
	// The policy in force is decided by the position of set_policy in the log.
	g := initializedFSM(120)
	for _, e := range log[:4] {
		apply(g, e.index, e.term, e.cmd)
	}
	if !g.View().FairShare {
		t.Fatal("policy not switched at its log index")
	}
	h := initializedFSM(120)
	for _, e := range log[:3] {
		apply(h, e.index, e.term, e.cmd)
	}
	if h.View().FairShare || h.View().PolicyConfigured {
		t.Fatal("policy applied before its log index")
	}
}

func snapshotRoundTrip(t *testing.T, f *FSM) *FSM {
	t.Helper()
	snap, err := f.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	sink := &memorySink{}
	if err = snap.Persist(sink); err != nil {
		t.Fatal(err)
	}
	restored, err := restoreFrom(t, sink.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	return restored
}
func TestSnapshotRoundTripPreservesWantsAndPolicy(t *testing.T) {
	f := initializedFSM(120)
	apply(f, 1, 1, setPolicy("fair_share"))
	apply(f, 2, 1, grant("a", "A", "s", 102))
	apply(f, 3, 1, grant("b", "B", "s", 99))
	apply(f, 4, 1, grant("c", "C", "s", 500))
	apply(f, 5, 1, expireWant("B", 3, 1))
	restored := snapshotRoundTrip(t, f)
	if fullState(t, f) != fullState(t, restored) {
		t.Fatal("round trip changed state")
	}
	if s := restored.View(); !s.FairShare || !s.PolicyConfigured || len(s.Wants) != 2 || s.Wants["A"] != (Want{"A", 102, 2}) || s.Wants["C"] != (Want{"C", 120, 4}) {
		t.Fatalf("%+v", s)
	}
	for i, c := range []Command{grant("d", "B", "s", 99), expire("A", 2, 1), grant("e", "A", "s", 102), expireWant("C", 4, 1), setPolicy("first_come"), grant("f", "C", "s", 50)} {
		x, y := apply(f, uint64(10+i), 1, c), apply(restored, uint64(10+i), 1, c)
		xb, _ := json.Marshal(x)
		yb, _ := json.Marshal(y)
		if !bytes.Equal(xb, yb) || fullState(t, f) != fullState(t, restored) {
			t.Fatalf("diverged at %d: %s / %s", i, xb, yb)
		}
	}
	checkInvariants(t, restored, "after restore")
	checkWantInvariants(t, restored, "after restore")
}
func TestViewDoesNotAliasWants(t *testing.T) {
	f := initializedFSM(120)
	apply(f, 1, 1, grant("a", "A", "s", 50))
	v := f.View()
	v.Wants["A"] = Want{"A", 1, 99}
	v.Wants["ghost"] = Want{"ghost", 1, 1}
	if w := wantsOf(f); len(w) != 1 || w["A"] != (Want{"A", 50, 1}) {
		t.Fatalf("view aliased the live wants: %v", w)
	}
}
func TestSnapshotWrittenBeforeFairShareStillRestores(t *testing.T) {
	legacy := `{"initialized":true,"capacity_amps":120,"leases":{"b":{"building_id":"b","session_id":"s","amps":50,"version":7}},"results":{},"events":[],"event_counter":1}`
	f, err := restoreFrom(t, []byte(legacy))
	if err != nil {
		t.Fatal(err)
	}
	if s := f.View(); s.FairShare || s.PolicyConfigured || s.Wants == nil || len(s.Wants) != 0 {
		t.Fatalf("%+v", s)
	}
	if got := fullState(t, f); !bytes.Contains([]byte(got), []byte(`"wants":{}`)) {
		t.Fatalf("restored state must carry an empty (not null) wants map: %s", got)
	}
	// It behaves as first_come: requests above capacity are invalid, growth must fit.
	if r := apply(f, 20, 3, grant("big", "b", "s", 500)); r.Reason != "invalid_request" {
		t.Fatal(r)
	}
	if r := apply(f, 21, 3, grant("g", "c", "s", 100)); r.Reason != "capacity_exhausted" {
		t.Fatal(r)
	}
	if r := apply(f, 22, 3, grant("h", "c", "s", 70)); !r.Accepted || r.Reason != "granted" || r.Lease.Amps != 70 {
		t.Fatal(r)
	}
	if w := wantsOf(f); len(w) != 1 || w["c"] != (Want{"c", 70, 22}) {
		t.Fatalf("%v", w)
	}
	// Setting the policy afterwards works on the restored state.
	apply(f, 23, 3, setPolicy("fair_share"))
	if r := apply(f, 24, 3, grant("i", "b", "s", 500)); !r.Accepted || r.Lease.Amps > 50 {
		t.Fatalf("%+v %+v", r, r.Lease)
	}
	checkInvariants(t, f, "legacy")
}
func TestRestoreRejectsMalformedWants(t *testing.T) {
	const head = `{"initialized":true,"capacity_amps":120,"results":{},"events":[],"event_counter":0,"leases":{},"wants":{`
	for name, want := range map[string]string{
		"key mismatch":  `"a":{"building_id":"b","amps":10,"version":1}`,
		"zero amps":     `"a":{"building_id":"a","amps":0,"version":1}`,
		"negative amps": `"a":{"building_id":"a","amps":-3,"version":1}`,
		"over capacity": `"a":{"building_id":"a","amps":121,"version":1}`,
	} {
		if _, err := restoreFrom(t, []byte(head+want+`}}`)); err == nil {
			t.Errorf("%s: malformed wants accepted", name)
		}
	}
	good := `"a":{"building_id":"a","amps":120,"version":1},"b":{"building_id":"b","amps":1,"version":2}`
	if f, err := restoreFrom(t, []byte(head+good+`},"fair_share":true,"policy_configured":true}`)); err != nil || !f.View().FairShare || len(f.View().Wants) != 2 {
		t.Fatalf("valid wants refused: %v", err)
	}
	if _, err := restoreFrom(t, []byte(`{"initialized":false,"capacity_amps":0,"leases":{},"results":{},"wants":{"a":{"building_id":"a","amps":1,"version":1}}}`)); err == nil {
		t.Error("wants without capacity accepted")
	}
}

// tierModel is an independent, stripped-down copy of the first_come tier rules as they were before fair
// sharing existed. With the policy off the FSM must agree with it on every result and every reservation.
type tierModel struct {
	capacity int
	leases   map[string]Lease
	results  map[string]RecordedResult
}

func (m *tierModel) granted() int {
	n := 0
	for _, l := range m.leases {
		n += l.Amps
	}
	return n
}
func (m *tierModel) grant(r Request, index uint64) Result {
	if prev, ok := m.results[r.RequestID]; ok {
		if prev.Hash != Hash(r) {
			return Result{RequestID: r.RequestID, Reason: "request_id_conflict"}
		}
		return prev.Result
	}
	res := Result{RequestID: r.RequestID}
	defer func() { m.results[r.RequestID] = RecordedResult{Hash: Hash(r), Result: res} }()
	cur, exists := m.leases[r.BuildingID]
	switch {
	case r.RequestID == "" || r.BuildingID == "" || r.SessionID == "" || len(r.RequestID) > 128 || len(r.BuildingID) > 128 || len(r.SessionID) > 128 || r.Amps <= 0 || r.Amps > m.capacity:
		res.Reason = "invalid_request"
	case exists && cur.SessionID != r.SessionID:
		res.Reason = "building_session_active"
	default:
		delta := 0
		if r.Amps > cur.Amps {
			delta = r.Amps - cur.Amps
		}
		if delta > m.capacity-m.granted() {
			res.Reason = "capacity_exhausted"
			break
		}
		var tiers []Tier
		for _, t := range cur.Tiers {
			if t.Amps > r.Amps {
				tiers = append(tiers, t)
			}
		}
		tiers = append(tiers, Tier{Version: index, Amps: r.Amps})
		m.leases[r.BuildingID] = Lease{BuildingID: r.BuildingID, SessionID: r.SessionID, Amps: tiers[0].Amps, Version: index, Tiers: tiers}
		res.Accepted, res.Reason = true, "granted"
		res.Lease = &Lease{BuildingID: r.BuildingID, SessionID: r.SessionID, Amps: r.Amps, Version: index}
	}
	return res
}
func (m *tierModel) expire(b string, version, term, logTerm uint64) {
	l, ok := m.leases[b]
	if !ok || term != logTerm || !l.HasTier(version) {
		return
	}
	var kept []Tier
	for _, t := range l.Tiers {
		if t.Version > version {
			kept = append(kept, t)
		}
	}
	if len(kept) == 0 {
		delete(m.leases, b)
		return
	}
	l.Tiers, l.Amps = kept, kept[0].Amps
	m.leases[b] = l
}
func TestPolicyOffMatchesTheTierRulesOnMixedCommandStreams(t *testing.T) {
	const capacity = 120
	for seed := int64(1); seed <= 8; seed++ {
		rng := rand.New(rand.NewSource(seed))
		f := initializedFSM(capacity)
		m := &tierModel{capacity: capacity, leases: map[string]Lease{}, results: map[string]RecordedResult{}}
		term := uint64(1)
		var ids []Request
		for i := 1; i <= 2500; i++ {
			if rng.Intn(30) == 0 {
				term++
			}
			b := buildingNames[rng.Intn(len(buildingNames))]
			switch k := rng.Intn(100); {
			case k < 62:
				session := fmt.Sprint("s", rng.Intn(2))
				if cur, ok := m.leases[b]; ok && rng.Intn(10) < 8 {
					session = cur.SessionID
				}
				req := Request{RequestID: fmt.Sprint("r", i), BuildingID: b, SessionID: session, Amps: rng.Intn(capacity+40) - 5}
				switch {
				case len(ids) > 0 && rng.Intn(12) == 0:
					req = ids[rng.Intn(len(ids))] // exact duplicate
				case len(ids) > 0 && rng.Intn(25) == 0:
					req.RequestID = ids[rng.Intn(len(ids))].RequestID // changed payload under an old id
				}
				ids = append(ids, req)
				wb, _ := json.Marshal(m.grant(req, uint64(i)))
				gb, _ := json.Marshal(apply(f, uint64(i), term, Command{Kind: "grant", Request: req, OccurredAt: "t"}))
				if !bytes.Equal(wb, gb) {
					t.Fatalf("seed %d step %d: FSM %s model %s", seed, i, gb, wb)
				}
			case k < 85:
				cur, ok := m.leases[b]
				version := uint64(rng.Intn(i + 3))
				if ok && rng.Intn(10) < 7 {
					version = cur.Tiers[rng.Intn(len(cur.Tiers))].Version
				}
				exp := term
				if rng.Intn(4) == 0 {
					exp = term + 1
				}
				m.expire(b, version, exp, term)
				apply(f, uint64(i), term, expire(b, version, exp))
			default:
				// expire_want and a malformed command never touch leases.
				apply(f, uint64(i), term, expireWant(b, uint64(rng.Intn(i+3)), term))
				if rng.Intn(5) == 0 {
					apply(f, uint64(i), term, Command{Kind: "bogus"})
				}
			}
			checkInvariants(t, f, fmt.Sprint("seed ", seed, " step ", i))
			checkWantInvariants(t, f, fmt.Sprint("seed ", seed, " step ", i))
			view := f.View()
			if view.FairShare || view.PolicyConfigured {
				t.Fatal("policy changed without set_policy")
			}
			for _, name := range buildingNames {
				if !reflect.DeepEqual(view.Leases[name], m.leases[name]) {
					t.Fatalf("seed %d step %d %s: FSM %+v model %+v", seed, i, name, view.Leases[name], m.leases[name])
				}
			}
		}
	}
}

func TestFirstComeRecordsWantsWithoutChangingDecisions(t *testing.T) {
	f := initializedFSM(120)
	apply(f, 1, 1, grant("a", "A", "s", 100))
	if r := apply(f, 2, 1, grant("b", "B", "s", 90)); r.Reason != "capacity_exhausted" {
		t.Fatal(r)
	}
	if got := wantsOf(f); got["A"] != (Want{"A", 100, 1}) || got["B"] != (Want{"B", 90, 2}) {
		t.Fatalf("first_come must record wants so that switching on has data: %v", got)
	}
	if r := apply(f, 3, 1, grant("c", "B", "s", 20)); !r.Accepted || r.Lease.Amps != 20 {
		t.Fatalf("%+v", r)
	}
	if got := wantsOf(f)["B"]; got != (Want{"B", 20, 3}) {
		t.Fatalf("%+v", got)
	}
}

func TestFairSharePropertyInvariantsAndDeterministicReplay(t *testing.T) {
	const capacity, steps = 120, 9000
	names := []string{"b0", "b1", "b2", "b3"}
	rng := rand.New(rand.NewSource(20261111))
	f := initializedFSM(capacity)
	var shadow *FSM // restored from a snapshot half way and kept in lock step
	var log []logEntry
	var results []string
	var ids []Request
	term := uint64(1)
	counts := map[string]int{}
	for i := 1; i <= steps; i++ {
		if rng.Intn(40) == 0 {
			term++
		}
		b := names[rng.Intn(len(names))]
		cur, has := f.View().Leases[b]
		var c Command
		switch k := rng.Intn(100); {
		case k < 66:
			session := fmt.Sprint("s", rng.Intn(2))
			if has && rng.Intn(10) < 8 {
				session = cur.SessionID
			}
			amps := 1 + rng.Intn(2*capacity)
			if rng.Intn(3) == 0 {
				amps = 15 + rng.Intn(60)
			}
			req := Request{RequestID: fmt.Sprint("r", i), BuildingID: b, SessionID: session, Amps: amps}
			switch {
			case len(ids) > 0 && rng.Intn(15) == 0:
				req = ids[rng.Intn(len(ids))]
			case len(ids) > 0 && rng.Intn(30) == 0:
				req.RequestID = ids[rng.Intn(len(ids))].RequestID
			}
			ids = append(ids, req)
			c = Command{Kind: "grant", Request: req, OccurredAt: "t"}
		case k < 82:
			version := uint64(rng.Intn(i + 3))
			if has && rng.Intn(10) < 7 {
				version = cur.Tiers[rng.Intn(len(cur.Tiers))].Version
			}
			exp := term
			if rng.Intn(4) == 0 {
				exp = term + 1
			}
			c = expire(b, version, exp)
		case k < 97:
			version := uint64(rng.Intn(i + 3)) // usually bogus
			if w, ok := f.View().Wants[b]; ok && rng.Intn(10) < 6 {
				version = w.Version
			}
			exp := term
			if rng.Intn(4) == 0 {
				exp = term + 1 + uint64(rng.Intn(2))
				if rng.Intn(2) == 0 && term > 1 {
					exp = term - 1
				}
			}
			c = expireWant(b, version, exp)
		default:
			c = setPolicy([]string{"fair_share", "fair_share", "first_come", "bogus"}[rng.Intn(4)])
			if i < 5 {
				c = setPolicy("fair_share")
			}
		}
		if i == steps/2 {
			shadow = snapshotRoundTrip(t, f)
		}
		before, resultsBefore := f.View(), resultCount(f)
		res := apply(f, uint64(i), term, c)
		after := f.View()
		log = append(log, logEntry{uint64(i), term, c})
		rb, _ := json.Marshal(res)
		results = append(results, string(rb))
		if shadow != nil {
			sb, _ := json.Marshal(apply(shadow, uint64(i), term, c))
			if string(sb) != string(rb) {
				t.Fatalf("step %d: restored replica diverged: %s / %s", i, sb, rb)
			}
		}
		ctx := fmt.Sprint("step ", i, " ", c.Kind)
		checkInvariants(t, f, ctx)
		checkWantInvariants(t, f, ctx)
		free := capacity - Granted(before)
		for _, name := range names {
			grew := after.Leases[name].Amps - before.Leases[name].Amps
			if grew > free || (c.Kind != "grant" && grew > 0) {
				t.Fatalf("%s: %s reservation grew by %d with %d free", ctx, name, grew, free)
			}
		}
		fresh := resultCount(f) > resultsBefore // a request id seen for the first time
		recorded := fresh && (res.Reason == "granted" || res.Reason == "granted_partial" || res.Reason == "capacity_exhausted")
		switch c.Kind {
		case "grant":
			r := c.Request
			if recorded {
				if w := after.Wants[r.BuildingID]; w != (Want{r.BuildingID, min(r.Amps, capacity), uint64(i)}) {
					t.Fatalf("%s: want %+v for request %d", ctx, w, r.Amps)
				}
			}
			for _, name := range names {
				if (!recorded || name != r.BuildingID) && after.Wants[name] != before.Wants[name] {
					t.Fatalf("%s: %s: changed the want of %s (%s)", ctx, res.Reason, name, rb)
				}
			}
			if res.Accepted && fresh {
				if res.Lease == nil || res.Lease.Version != uint64(i) || len(res.Lease.Tiers) != 0 || res.Lease.Amps <= 0 || res.Lease.Amps > r.Amps || res.Lease.Amps > capacity {
					t.Fatalf("%s: lease %+v for request %d", ctx, res.Lease, r.Amps)
				}
				if before.FairShare {
					if share := FairShares(after)[r.BuildingID]; res.Lease.Amps > share {
						t.Fatalf("%s: authorized %d above fair share %d", ctx, res.Lease.Amps, share)
					}
					if (res.Reason == "granted") != (res.Lease.Amps == r.Amps) {
						t.Fatalf("%s: reason %s for %d of %d", ctx, res.Reason, res.Lease.Amps, r.Amps)
					}
					if res.Reason == "granted_partial" {
						counts["partial"]++
					}
					if before.Leases[r.BuildingID].Amps > res.Lease.Amps {
						counts["capped-renewal"]++
					}
				} else if res.Reason != "granted" || res.Lease.Amps != r.Amps {
					t.Fatalf("%s: first_come lease %+v reason %s", ctx, res.Lease, res.Reason)
				}
			}
			if fresh && before.FairShare && res.Reason == "capacity_exhausted" {
				if before.Leases[r.BuildingID].Amps != 0 || free != 0 {
					t.Fatalf("%s: fair_share refused a building holding %d with %d A free", ctx, before.Leases[r.BuildingID].Amps, free)
				}
				counts["fair-refused"]++
			}
			if fresh && res.Reason == "granted_partial" && !before.FairShare { // a replayed id returns its stored result
				t.Fatalf("%s: partial grant under first_come", ctx)
			}
			if fresh && res.Reason == "invalid_request" && before.FairShare && r.Amps > 0 {
				t.Fatalf("%s: fair_share rejected a valid request of %d", ctx, r.Amps)
			}
		case "expire_want":
			w, had := before.Wants[b]
			removed := had && w.Version == c.ExpectedVersion && c.ExpectedTerm == term
			if _, still := after.Wants[b]; still != (had && !removed) || len(after.Wants) != len(before.Wants)-btoi(removed) {
				t.Fatalf("%s: removed=%v after=%v", ctx, removed, after.Wants)
			}
			if !reflect.DeepEqual(before.Leases, after.Leases) || after.EventCounter != before.EventCounter {
				t.Fatalf("%s: expire_want touched leases", ctx)
			}
			counts["want-removed"] += btoi(removed)
			counts["want-kept"] += btoi(!removed)
		case "set_policy":
			if (res.Reason == "policy_set") != (c.Policy == "fair_share" || c.Policy == "first_come") || res.Accepted != (res.Reason == "policy_set") {
				t.Fatalf("%s: %q -> %+v", ctx, c.Policy, res)
			}
			if res.Accepted && (after.FairShare != (c.Policy == "fair_share") || !after.PolicyConfigured) {
				t.Fatalf("%s: policy not applied", ctx)
			}
			if !res.Accepted && (after.FairShare != before.FairShare || after.PolicyConfigured != before.PolicyConfigured) {
				t.Fatalf("%s: invalid policy changed state", ctx)
			}
			counts["set_policy:"+res.Reason]++
			if !reflect.DeepEqual(before.Wants, after.Wants) || !reflect.DeepEqual(before.Leases, after.Leases) {
				t.Fatalf("%s: set_policy changed wants or leases", ctx)
			}
		}
		counts[fmt.Sprint(res.Reason, "/fair=", before.FairShare)]++
	}
	for _, k := range []string{"partial", "capped-renewal", "fair-refused", "want-removed", "want-kept", "set_policy:policy_set", "set_policy:invalid_policy", "granted/fair=true", "granted/fair=false", "granted_partial/fair=true", "capacity_exhausted/fair=false", "building_session_active/fair=true", "request_id_conflict/fair=true"} {
		if counts[k] == 0 {
			t.Fatalf("property run never exercised %s: %v", k, counts)
		}
	}
	t.Logf("coverage: %v", counts)
	replayed := initializedFSM(capacity)
	for i, e := range log {
		got, _ := json.Marshal(apply(replayed, e.index, e.term, e.cmd))
		if string(got) != results[i] {
			t.Fatalf("replay result %d differs: %s / %s", i, got, results[i])
		}
	}
	if fullState(t, f) != fullState(t, replayed) || fullState(t, f) != fullState(t, shadow) {
		t.Fatal("replay or snapshot restore produced a different full state")
	}
}
func btoi(b bool) int {
	if b {
		return 1
	}
	return 0
}

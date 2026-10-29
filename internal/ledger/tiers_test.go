package ledger

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"reflect"
	"testing"
)

func expire(building string, version, term uint64) Command {
	return Command{Kind: "expire", BuildingID: building, ExpectedVersion: version, ExpectedTerm: term, OccurredAt: "2026-10-28T00:00:01Z"}
}
func tiersOf(f *FSM, building string) []Tier {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.state.Leases[building].Tiers
}
func fullState(t *testing.T, f *FSM) string {
	t.Helper()
	f.mu.RLock()
	defer f.mu.RUnlock()
	b, err := json.Marshal(f.state)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
func lastEvent(f *FSM) Event {
	e := f.EventsAfter(0, 1<<20)
	return e[len(e)-1]
}

// checkInvariants asserts every stored-lease invariant of the tier model plus the capacity bound.
func checkInvariants(t *testing.T, f *FSM, context string) {
	t.Helper()
	f.mu.RLock()
	defer f.mu.RUnlock()
	total := 0
	for key, l := range f.state.Leases {
		if l.BuildingID != key || l.SessionID == "" || len(l.Tiers) < 1 {
			t.Fatalf("%s: malformed lease %+v", context, l)
		}
		for i, tier := range l.Tiers {
			if tier.Amps <= 0 || (i > 0 && (tier.Version <= l.Tiers[i-1].Version || tier.Amps >= l.Tiers[i-1].Amps)) {
				t.Fatalf("%s: tier order violated %+v", context, l)
			}
		}
		if l.Amps != l.Tiers[0].Amps || l.Version != l.Tiers[len(l.Tiers)-1].Version {
			t.Fatalf("%s: lease does not match tiers %+v", context, l)
		}
		total += l.Amps
	}
	if total > f.state.Capacity || Granted(f.state) != total {
		t.Fatalf("%s: granted %d exceeds capacity %d", context, total, f.state.Capacity)
	}
}
func wantTiers(t *testing.T, f *FSM, building string, want ...Tier) {
	t.Helper()
	if got := tiersOf(f, building); !reflect.DeepEqual(got, want) {
		t.Fatalf("tiers=%v want %v", got, want)
	}
	checkInvariants(t, f, "wantTiers")
}

func TestRenewalBelowReservationShrinksOnlyAfterExpiry(t *testing.T) {
	f := initializedFSM(120)
	if r := apply(f, 1, 1, grant("r1", "b1", "s", 107)); !r.Accepted || r.Lease.Amps != 107 {
		t.Fatal(r)
	}
	r := apply(f, 2, 1, grant("r2", "b1", "s", 26))
	if !r.Accepted || r.Lease.Amps != 26 || r.Lease.Version != 2 || len(r.Lease.Tiers) != 0 {
		t.Fatalf("renewal must return its own authorization: %+v", r.Lease)
	}
	if Granted(f.View()) != 107 {
		t.Fatal("reservation shrank before the larger grant could have expired")
	}
	wantTiers(t, f, "b1", Tier{1, 107}, Tier{2, 26})
	if l := f.View().Leases["b1"]; l.Amps != 107 || l.Version != 2 {
		t.Fatalf("%+v", l)
	}
	if e := lastEvent(f); e.Kind != "granted" || e.Amps != 26 || e.Version != 2 {
		t.Fatalf("granted event must record the grant's own amps: %+v", e)
	}
	if r = apply(f, 3, 1, grant("other", "b2", "s", 81)); r.Accepted || r.Reason != "capacity_exhausted" {
		t.Fatalf("freed amps granted before the large tier expired: %+v", r)
	}
}
func TestExpiringLargeTierShrinksAndFreesCapacity(t *testing.T) {
	f := initializedFSM(120)
	apply(f, 1, 1, grant("r1", "b1", "s", 107))
	apply(f, 2, 1, grant("r2", "b1", "s", 26))
	if r := apply(f, 3, 1, expire("b1", 1, 1)); !r.Accepted || r.Reason != "expiry_applied" {
		t.Fatal(r)
	}
	if Granted(f.View()) != 26 {
		t.Fatalf("granted=%d", Granted(f.View()))
	}
	if e := lastEvent(f); e.Kind != "shrunk" || e.Amps != 26 || e.Version != 2 || e.BuildingID != "b1" {
		t.Fatalf("event=%+v", e)
	}
	wantTiers(t, f, "b1", Tier{2, 26})
	if r := apply(f, 4, 1, grant("other", "b2", "s2", 81)); !r.Accepted || Granted(f.View()) != 107 {
		t.Fatalf("freed amps not reusable: %+v", r)
	}
	if r := apply(f, 5, 1, expire("b1", 2, 1)); !r.Accepted || lastEvent(f).Kind != "reclaimed" || lastEvent(f).Amps != 26 {
		t.Fatalf("last tier must reclaim: %+v", lastEvent(f))
	}
	if _, ok := f.View().Leases["b1"]; ok {
		t.Fatal("lease not deleted")
	}
}
func TestExpiringMiddleTierDropsOlderTiersToo(t *testing.T) {
	f := initializedFSM(120)
	apply(f, 1, 1, grant("a", "b", "s", 100))
	apply(f, 2, 1, grant("b", "b", "s", 60))
	apply(f, 3, 1, grant("c", "b", "s", 20))
	wantTiers(t, f, "b", Tier{1, 100}, Tier{2, 60}, Tier{3, 20})
	apply(f, 4, 1, expire("b", 2, 1))
	wantTiers(t, f, "b", Tier{3, 20})
	if Granted(f.View()) != 20 {
		t.Fatal("older tiers must go with the newer expired one")
	}
}
func TestExpireWithUnknownVersionWrongTermOrNoLeaseChangesNothing(t *testing.T) {
	f := initializedFSM(120)
	apply(f, 1, 1, grant("r1", "b1", "s", 107))
	apply(f, 2, 1, grant("r2", "b1", "s", 26))
	before := fullState(t, f)
	for i, c := range []struct {
		building      string
		version, term uint64
	}{{"b1", 99, 1}, {"b1", 0, 1}, {"b1", 1, 2}, {"b1", 2, 0}, {"nobody", 1, 1}} {
		if r := apply(f, uint64(10+i), 1, expire(c.building, c.version, c.term)); !r.Accepted || r.Reason != "expiry_applied" {
			t.Fatalf("result changed: %+v", r)
		}
		if fullState(t, f) != before {
			t.Fatalf("case %d changed state", i)
		}
	}
	apply(f, 20, 1, expire("b1", 2, 1))
	gone := fullState(t, f)
	if r := apply(f, 21, 1, expire("b1", 2, 1)); !r.Accepted || fullState(t, f) != gone {
		t.Fatal("expire after the lease is gone changed state")
	}
}
func TestDominatedTiersArePruned(t *testing.T) {
	f := initializedFSM(120)
	apply(f, 1, 1, grant("a", "b", "s", 107))
	apply(f, 2, 1, grant("b", "b", "s", 26))
	apply(f, 3, 1, grant("c", "b", "s", 107))
	wantTiers(t, f, "b", Tier{3, 107})
	g := initializedFSM(120)
	apply(g, 1, 1, grant("a", "b", "s", 26))
	apply(g, 2, 1, grant("b", "b", "s", 40))
	apply(g, 3, 1, grant("c", "b", "s", 30))
	wantTiers(t, g, "b", Tier{2, 40}, Tier{3, 30})
	apply(g, 4, 1, grant("d", "b", "s", 40)) // equal amps dominates the equal older tier
	wantTiers(t, g, "b", Tier{4, 40})
}
func TestDelayedCommitOrder(t *testing.T) {
	// A larger grant sent earlier may commit after a smaller one sent later.
	f := initializedFSM(120)
	apply(f, 1, 1, grant("small", "b", "s", 10))
	apply(f, 2, 1, grant("large", "b", "s", 50))
	wantTiers(t, f, "b", Tier{2, 50})
	if Granted(f.View()) != 50 {
		t.Fatal("reservation below the larger grant")
	}
	g := initializedFSM(120)
	apply(g, 1, 1, grant("large", "b", "s", 50))
	apply(g, 2, 1, grant("small", "b", "s", 10))
	wantTiers(t, g, "b", Tier{1, 50}, Tier{2, 10})
}
func TestRequestAtOrBelowReservationAcceptedWhenFull(t *testing.T) {
	f := initializedFSM(120)
	apply(f, 1, 1, grant("a", "b1", "s", 100))
	apply(f, 2, 1, grant("b", "b2", "s", 20))
	if Granted(f.View()) != 120 {
		t.Fatal("setup")
	}
	for i, amps := range []int{100, 50, 100, 1} {
		if r := apply(f, uint64(3+i), 1, grant(fmt.Sprint("n", i), "b1", "s", amps)); !r.Accepted || r.Lease.Amps != amps {
			t.Fatalf("delta-0 request %d refused: %+v", amps, r)
		}
	}
	if r := apply(f, 10, 1, grant("big", "b1", "s", 101)); r.Accepted || r.Reason != "capacity_exhausted" {
		t.Fatalf("%+v", r)
	}
	if r := apply(f, 11, 1, grant("big2", "b2", "s", 21)); r.Accepted || r.Reason != "capacity_exhausted" {
		t.Fatalf("%+v", r)
	}
	if Granted(f.View()) != 120 {
		t.Fatal("capacity changed")
	}
	checkInvariants(t, f, "full")
}
func TestOtherSessionBlockedWhileAnyTierRemains(t *testing.T) {
	f := initializedFSM(120)
	apply(f, 1, 1, grant("a", "b", "s1", 30))
	apply(f, 2, 1, grant("b", "b", "s1", 10))
	if r := apply(f, 3, 1, grant("c", "b", "s2", 5)); r.Reason != "building_session_active" {
		t.Fatal(r)
	}
	apply(f, 4, 1, expire("b", 1, 1))
	wantTiers(t, f, "b", Tier{2, 10})
	if r := apply(f, 5, 1, grant("d", "b", "s2", 5)); r.Reason != "building_session_active" {
		t.Fatalf("session replaced while a tier remains: %+v", r)
	}
	apply(f, 6, 1, expire("b", 2, 1))
	if r := apply(f, 7, 1, grant("e", "b", "s2", 5)); !r.Accepted || f.View().Leases["b"].SessionID != "s2" {
		t.Fatalf("new session refused after reclaim: %+v", r)
	}
}
func TestIdempotentReplayOfTierGrants(t *testing.T) {
	f := initializedFSM(120)
	apply(f, 1, 1, grant("r1", "b", "s", 107))
	first := apply(f, 2, 1, grant("r2", "b", "s", 26))
	apply(f, 3, 1, expire("b", 1, 1))
	before := fullState(t, f)
	replay := apply(f, 4, 1, grant("r2", "b", "s", 26))
	a, _ := json.Marshal(first)
	b, _ := json.Marshal(replay)
	if !bytes.Equal(a, b) || fullState(t, f) != before {
		t.Fatalf("replay differs or mutated state: %s / %s", a, b)
	}
	if r := apply(f, 5, 1, grant("r2", "b", "s", 27)); r.Reason != "request_id_conflict" || fullState(t, f) != before {
		t.Fatalf("%+v", r)
	}
}
func restoreFrom(t *testing.T, data []byte) (*FSM, error) {
	t.Helper()
	f := New()
	return f, f.Restore(io.NopCloser(bytes.NewReader(data)))
}
func TestSnapshotRoundTripPreservesTiers(t *testing.T) {
	f := initializedFSM(120)
	apply(f, 1, 1, grant("a", "b1", "s", 107))
	apply(f, 2, 1, grant("b", "b1", "s", 26))
	apply(f, 3, 1, grant("c", "b2", "s", 10))
	apply(f, 4, 1, grant("d", "b2", "s", 5))
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
	if fullState(t, f) != fullState(t, restored) {
		t.Fatal("round trip changed state")
	}
	wantTiers(t, restored, "b1", Tier{1, 107}, Tier{2, 26})
	for i, c := range []Command{expire("b1", 1, 1), grant("e", "b2", "s", 8), expire("b2", 4, 1), grant("f", "b3", "s", 90)} {
		x, y := apply(f, uint64(10+i), 1, c), apply(restored, uint64(10+i), 1, c)
		xb, _ := json.Marshal(x)
		yb, _ := json.Marshal(y)
		if !bytes.Equal(xb, yb) || fullState(t, f) != fullState(t, restored) {
			t.Fatalf("diverged at %d: %s / %s", i, xb, yb)
		}
	}
	checkInvariants(t, restored, "after restore")
}
func TestViewDoesNotAliasTiers(t *testing.T) {
	f := initializedFSM(120)
	apply(f, 1, 1, grant("a", "b", "s", 50))
	apply(f, 2, 1, grant("b", "b", "s", 10))
	v := f.View()
	v.Leases["b"].Tiers[0].Amps = 1
	wantTiers(t, f, "b", Tier{1, 50}, Tier{2, 10})
}
func TestLegacySnapshotWithoutTiersRestores(t *testing.T) {
	legacy := `{"initialized":true,"capacity_amps":120,"leases":{"b":{"building_id":"b","session_id":"s","amps":50,"version":7}},"results":{},"events":[],"event_counter":1}`
	f, err := restoreFrom(t, []byte(legacy))
	if err != nil {
		t.Fatal(err)
	}
	wantTiers(t, f, "b", Tier{7, 50})
	if r := apply(f, 20, 3, expire("b", 7, 3)); !r.Accepted {
		t.Fatal(r)
	}
	if _, ok := f.View().Leases["b"]; ok || Granted(f.View()) != 0 {
		t.Fatal("legacy lease not deleted by an expire for its latest version")
	}
	if e := lastEvent(f); e.Kind != "reclaimed" || e.Amps != 50 || e.Version != 7 {
		t.Fatalf("%+v", e)
	}
}
func TestRestoreRejectsMalformedTiers(t *testing.T) {
	const head = `{"initialized":true,"capacity_amps":120,"results":{},"events":[],"event_counter":0,"leases":{"b":`
	for name, lease := range map[string]string{
		"unsorted versions":  `{"building_id":"b","session_id":"s","amps":50,"version":3,"tiers":[{"version":3,"amps":50},{"version":2,"amps":20}]}`,
		"duplicate versions": `{"building_id":"b","session_id":"s","amps":50,"version":2,"tiers":[{"version":2,"amps":50},{"version":2,"amps":20}]}`,
		"equal amps":         `{"building_id":"b","session_id":"s","amps":50,"version":3,"tiers":[{"version":2,"amps":50},{"version":3,"amps":50}]}`,
		"increasing amps":    `{"building_id":"b","session_id":"s","amps":20,"version":3,"tiers":[{"version":2,"amps":20},{"version":3,"amps":50}]}`,
		"lease amps":         `{"building_id":"b","session_id":"s","amps":40,"version":3,"tiers":[{"version":2,"amps":50},{"version":3,"amps":20}]}`,
		"lease version":      `{"building_id":"b","session_id":"s","amps":50,"version":9,"tiers":[{"version":2,"amps":50},{"version":3,"amps":20}]}`,
		"zero tier amps":     `{"building_id":"b","session_id":"s","amps":50,"version":3,"tiers":[{"version":2,"amps":50},{"version":3,"amps":0}]}`,
		"over capacity":      `{"building_id":"b","session_id":"s","amps":121,"version":2,"tiers":[{"version":2,"amps":121}]}`,
	} {
		if _, err := restoreFrom(t, []byte(head+lease+`}}`)); err == nil {
			t.Errorf("%s: malformed snapshot accepted", name)
		}
	}
	good := `{"building_id":"b","session_id":"s","amps":50,"version":3,"tiers":[{"version":2,"amps":50},{"version":3,"amps":20}]}`
	if _, err := restoreFrom(t, []byte(head+good+`}}`)); err != nil {
		t.Fatal(err)
	}
}

var buildingNames = []string{"b0", "b1", "b2"}

type logEntry struct {
	index, term uint64
	cmd         Command
}

func TestPropertyInvariantsAndDeterministicReplay(t *testing.T) {
	const capacity, steps = 120, 6000
	rng := rand.New(rand.NewSource(20261029))
	f := initializedFSM(capacity)
	var log []logEntry
	var results []string
	var ids []Request
	term := uint64(1)
	counts := map[string]int{}
	for i := 1; i <= steps; i++ {
		if rng.Intn(40) == 0 {
			term++
		}
		building := buildingNames[rng.Intn(len(buildingNames))]
		cur, has := f.View().Leases[building]
		var c Command
		if rng.Intn(100) < 68 {
			session := fmt.Sprint("s", rng.Intn(2))
			if has && rng.Intn(10) < 8 {
				session = cur.SessionID
			}
			req := Request{RequestID: fmt.Sprint("r", i), BuildingID: building, SessionID: session, Amps: 1 + rng.Intn(capacity/2)}
			switch {
			case len(ids) > 0 && rng.Intn(15) == 0:
				req = ids[rng.Intn(len(ids))] // exact duplicate
			case len(ids) > 0 && rng.Intn(30) == 0:
				req.RequestID = ids[rng.Intn(len(ids))].RequestID // changed payload under an old id
			}
			ids = append(ids, req)
			c = Command{Kind: "grant", Request: req, OccurredAt: "t"}
		} else {
			version := uint64(rng.Intn(i + 3))
			if has && rng.Intn(10) < 7 {
				version = cur.Tiers[rng.Intn(len(cur.Tiers))].Version
			}
			exp := term
			if rng.Intn(4) == 0 {
				exp = term + uint64(rng.Intn(2)) + 1
				if rng.Intn(2) == 0 && term > 1 {
					exp = term - 1
				}
			}
			c = Command{Kind: "expire", BuildingID: building, ExpectedVersion: version, ExpectedTerm: exp, OccurredAt: "t"}
		}
		before := f.View()
		res := apply(f, uint64(i), term, c)
		after := f.View()
		log = append(log, logEntry{uint64(i), term, c})
		rb, _ := json.Marshal(res)
		results = append(results, string(rb))
		checkInvariants(t, f, fmt.Sprint("step ", i))
		fresh := after.EventCounter > before.EventCounter // false for idempotent replays and rejections
		if c.Kind == "grant" && res.Reason == "granted" && fresh {
			if res.Lease == nil || res.Lease.Amps != c.Request.Amps || res.Lease.Version != uint64(i) || len(res.Lease.Tiers) != 0 {
				t.Fatalf("step %d: result must be the grant's own authorization: %+v", i, res.Lease)
			}
			want := c.Request.Amps
			if has && cur.Amps > want {
				want = cur.Amps
			}
			if after.Leases[building].Amps != want || after.Leases[building].Version != uint64(i) {
				t.Fatalf("step %d: reserved %+v want %d", i, after.Leases[building], want)
			}
			if has && len(after.Leases[building].Tiers) > len(cur.Tiers)+1 {
				t.Fatalf("step %d: tier growth", i)
			}
			if len(after.Leases[building].Tiers) > 1 {
				counts["multi-tier"]++
			}
		}
		if res.Reason == "capacity_exhausted" && (Granted(before) != Granted(after) || fresh) {
			t.Fatalf("step %d: rejected grant changed state", i)
		}
		counts[res.Reason]++
		if fresh {
			counts["event:"+after.Events[len(after.Events)-1].Kind]++
		}
	}
	for _, k := range []string{"granted", "capacity_exhausted", "building_session_active", "request_id_conflict", "multi-tier", "event:shrunk", "event:reclaimed"} {
		if counts[k] == 0 {
			t.Fatalf("property run never exercised %s: %v", k, counts)
		}
	}
	t.Logf("coverage: %v", counts)
	replayed := New()
	apply(replayed, 0, 0, Command{Kind: "init_capacity", Capacity: capacity})
	for i, e := range log {
		got, _ := json.Marshal(apply(replayed, e.index, e.term, e.cmd))
		if string(got) != results[i] {
			t.Fatalf("replay result %d differs: %s / %s", i, got, results[i])
		}
	}
	if fullState(t, f) != fullState(t, replayed) {
		t.Fatal("replay produced a different full state")
	}
}

// oldModel is the pre-tier semantics: one lease per building, amps = max, expire(latest version) deletes.
type oldModel struct {
	capacity int
	leases   map[string]Lease
}

func (m *oldModel) granted() int {
	n := 0
	for _, l := range m.leases {
		n += l.Amps
	}
	return n
}
func (m *oldModel) grant(r Request, index uint64) (bool, string) {
	cur, exists := m.leases[r.BuildingID]
	switch {
	case r.Amps <= 0 || r.Amps > m.capacity:
		return false, "invalid_request"
	case exists && cur.SessionID != r.SessionID:
		return false, "building_session_active"
	}
	amps := r.Amps
	if exists && cur.Amps > amps {
		amps = cur.Amps
	}
	delta := amps
	if exists {
		delta -= cur.Amps
	}
	if delta > m.capacity-m.granted() {
		return false, "capacity_exhausted"
	}
	m.leases[r.BuildingID] = Lease{BuildingID: r.BuildingID, SessionID: r.SessionID, Amps: amps, Version: index}
	return true, "granted"
}
func TestMatchesOldRulesOnOldStyleCommandStreams(t *testing.T) {
	const capacity = 120
	for seed := int64(1); seed <= 5; seed++ {
		rng := rand.New(rand.NewSource(seed))
		f := initializedFSM(capacity)
		m := &oldModel{capacity: capacity, leases: map[string]Lease{}}
		term := uint64(1)
		for i := 1; i <= 2500; i++ {
			if rng.Intn(30) == 0 {
				term++
			}
			b := buildingNames[rng.Intn(len(buildingNames))]
			if rng.Intn(100) < 70 {
				session := fmt.Sprint("s", rng.Intn(2))
				if cur, ok := m.leases[b]; ok && rng.Intn(10) < 8 {
					session = cur.SessionID
				}
				req := Request{RequestID: fmt.Sprint("r", i), BuildingID: b, SessionID: session, Amps: 1 + rng.Intn(capacity)}
				wantOK, wantReason := m.grant(req, uint64(i))
				got := apply(f, uint64(i), term, Command{Kind: "grant", Request: req, OccurredAt: "t"})
				if got.Accepted != wantOK || got.Reason != wantReason {
					t.Fatalf("seed %d step %d: new=%v/%s old=%v/%s", seed, i, got.Accepted, got.Reason, wantOK, wantReason)
				}
			} else {
				// Old coordinators only ever proposed expire for the lease's latest version.
				cur, ok := m.leases[b]
				version, exp := cur.Version, term
				switch rng.Intn(4) {
				case 0:
					version = cur.Version + 1000000
				case 1:
					exp = term + 1
				}
				if !ok {
					version = uint64(rng.Intn(i + 1))
				}
				if ok && version == cur.Version && exp == term {
					delete(m.leases, b)
				}
				apply(f, uint64(i), term, expire(b, version, exp))
			}
			checkInvariants(t, f, fmt.Sprint("seed ", seed, " step ", i))
			for _, name := range buildingNames {
				old, oldOK := m.leases[name]
				got, gotOK := f.View().Leases[name]
				if oldOK != gotOK || old.Amps != got.Amps || old.Version != got.Version || old.SessionID != got.SessionID {
					t.Fatalf("seed %d step %d building %s: new=%+v old=%+v", seed, i, name, got, old)
				}
			}
		}
	}
}

package ledger

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/hashicorp/raft"
	"io"
	"sync"
	"sync/atomic"
	"testing"
)

func apply(f *FSM, index, term uint64, c Command) Result {
	b, _ := json.Marshal(c)
	return f.Apply(&raft.Log{Index: index, Term: term, Data: b}).(Result)
}
func grant(id, building, session string, amps int) Command {
	return Command{Kind: "grant", Request: Request{RequestID: id, BuildingID: building, SessionID: session, Amps: amps}, OccurredAt: "2026-10-28T00:00:00Z"}
}
func initializedFSM(capacity int) *FSM {
	f := New()
	apply(f, 0, 0, Command{Kind: "init_capacity", Capacity: capacity})
	return f
}
func TestConcurrentLastCapacity(t *testing.T) {
	f := initializedFSM(120)
	var seq atomic.Uint64
	var accepted atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r := apply(f, seq.Add(1), 1, grant(fmt.Sprint(i), fmt.Sprint(i), "session", 7))
			if r.Accepted {
				accepted.Add(1)
			}
		}(i)
	}
	wg.Wait()
	s := f.View()
	if Granted(s) != 119 || accepted.Load() != 17 {
		t.Fatalf("granted=%d accepted=%d", Granted(s), accepted.Load())
	}
}
func TestDuplicateConflictAndSessionIsolation(t *testing.T) {
	f := initializedFSM(120)
	first := apply(f, 1, 1, grant("r1", "b", "s", 30))
	duplicate := apply(f, 2, 1, grant("r1", "b", "s", 30))
	if !first.Accepted || duplicate.Lease.Version != 1 || f.View().EventCounter != 1 {
		t.Fatal("duplicate changed allocation")
	}
	conflict := apply(f, 3, 1, grant("r1", "b", "s", 40))
	if conflict.Reason != "request_id_conflict" {
		t.Fatal(conflict)
	}
	other := apply(f, 4, 1, grant("r2", "b", "restart", 5))
	if other.Reason != "building_session_active" {
		t.Fatal(other)
	}
	renew := apply(f, 5, 1, grant("r3", "b", "s", 5))
	// A renewal returns only its own authorization; the reservation stays at the larger, still usable tier.
	if renew.Lease.Amps != 5 || renew.Lease.Version != 5 || f.View().Leases["b"].Amps != 30 {
		t.Fatal("renew shrank existing usable grant")
	}
	if Granted(f.View()) != 30 {
		t.Fatal("bad sum")
	}
}
func TestExpiryVersionAndTermFence(t *testing.T) {
	f := initializedFSM(30)
	apply(f, 1, 1, grant("a", "b", "s", 20))
	apply(f, 2, 1, grant("b", "b", "s", 25))
	apply(f, 3, 1, Command{Kind: "expire", BuildingID: "b", ExpectedVersion: 1, ExpectedTerm: 1})
	if Granted(f.View()) != 25 {
		t.Fatal("stale version expired renewal")
	}
	apply(f, 4, 2, Command{Kind: "expire", BuildingID: "b", ExpectedVersion: 2, ExpectedTerm: 1})
	if Granted(f.View()) != 25 {
		t.Fatal("old term expired inherited lease")
	}
	apply(f, 5, 2, Command{Kind: "expire", BuildingID: "b", ExpectedVersion: 2, ExpectedTerm: 2})
	if Granted(f.View()) != 0 {
		t.Fatal("expiry did not reclaim")
	}
	duplicate := apply(f, 6, 2, grant("b", "b", "s", 25))
	if !duplicate.Accepted || duplicate.Lease.Version != 2 || Granted(f.View()) != 0 {
		t.Fatal("historical duplicate recreated lease")
	}
}

type memorySink struct {
	bytes.Buffer
	closed, cancelled bool
}

func (s *memorySink) ID() string    { return "test" }
func (s *memorySink) Close() error  { s.closed = true; return nil }
func (s *memorySink) Cancel() error { s.cancelled = true; return nil }
func TestSnapshotRestoresResultsOutboxAndCapacity(t *testing.T) {
	f := initializedFSM(50)
	apply(f, 10, 1, grant("a", "b", "s", 40))
	apply(f, 11, 1, grant("rejected", "other", "other", 20))
	apply(f, 12, 1, Command{Kind: "expire", BuildingID: "b", ExpectedVersion: 10, ExpectedTerm: 1})
	snapshot, err := f.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	sink := &memorySink{}
	if err = snapshot.Persist(sink); err != nil || !sink.closed {
		t.Fatal(err)
	}
	restored := New()
	if err = restored.Restore(io.NopCloser(bytes.NewReader(sink.Bytes()))); err != nil {
		t.Fatal(err)
	}
	if restored.View().Capacity != 50 || Granted(restored.View()) != 0 {
		t.Fatal("capacity snapshot lost")
	}
	result := apply(restored, 20, 2, grant("a", "b", "s", 40))
	if !result.Accepted || result.Lease.Version != 10 || Granted(restored.View()) != 0 {
		t.Fatal("idempotency snapshot lost")
	}
	if got := apply(restored, 21, 2, grant("rejected", "other", "other", 20)); got.Reason != "capacity_exhausted" {
		t.Fatal("rejected result lost")
	}
	apply(restored, 22, 2, grant("new", "other", "other", 20))
	events := restored.EventsAfter(0, 100)
	if len(events) != 3 || events[2].EventID != 3 || events[1].Kind != "reclaimed" {
		t.Fatalf("outbox=%+v", events)
	}
}
func TestRejectSnapshotOverCapacity(t *testing.T) {
	f := New()
	bad := `{"initialized":true,"capacity_amps":10,"leases":{"b":{"building_id":"b","amps":11}},"results":{}}`
	if err := f.Restore(io.NopCloser(bytes.NewBufferString(bad))); err == nil {
		t.Fatal("accepted invalid snapshot")
	}
}

func TestCapacityIsCommittedOnceAndReplaysIdentically(t *testing.T) {
	// Node-local proposals deliberately differ; once the first command commits,
	// every replica and a restarted replica makes the same capacity decisions.
	first, second := New(), New()
	commands := []Command{{Kind: "init_capacity", Capacity: 120}, grant("g1", "b1", "s1", 100), {Kind: "init_capacity", Capacity: 30}, grant("g2", "b2", "s2", 25), {Kind: "init_capacity", Capacity: 120}, grant("g3", "b3", "s3", 20)}
	for i, c := range commands {
		a := apply(first, uint64(i+1), 1, c)
		b := apply(second, uint64(i+1), 1, c)
		ab, _ := json.Marshal(a)
		bb, _ := json.Marshal(b)
		if !bytes.Equal(ab, bb) {
			t.Fatalf("divergent result at %d: %s / %s", i, ab, bb)
		}
		if i == 2 && a.Reason != "capacity_already_initialized" {
			t.Fatal(a)
		}
	}
	if !first.View().Initialized || first.View().Capacity != 120 || second.View().Capacity != 120 || Granted(first.View()) != 120 || Granted(second.View()) != 120 {
		t.Fatal("committed capacity was replaced by later local proposal")
	}
	restarted := New()
	for i, c := range commands {
		apply(restarted, uint64(i+1), 1, c)
	}
	if restarted.View().Capacity != 120 || Granted(restarted.View()) != 120 {
		t.Fatal("replay recomputed capacity")
	}
}

func TestUninitializedAndLegacyHistoryFailClosed(t *testing.T) {
	f := New()
	result := apply(f, 1, 1, grant("old", "b", "s", 10))
	if result.Accepted || Granted(f.View()) != 0 || result.Reason != "capacity_uninitialized" {
		t.Fatal("uninitialized ledger granted capacity")
	}
	if result = apply(f, 2, 1, Command{Kind: "init_capacity", Capacity: 120}); result.Accepted || result.Reason != "legacy_log_requires_reset" {
		t.Fatal("old logs were silently reinterpreted")
	}
	clean := New()
	for _, capacity := range []int{0, -1, 1000001} {
		if result = apply(clean, 1, 1, Command{Kind: "init_capacity", Capacity: capacity}); result.Accepted || clean.View().Initialized {
			t.Fatal("invalid initialization accepted")
		}
	}
}

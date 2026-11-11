package coordinator

import (
	"ishtirak/internal/ledger"
	"testing"
	"time"
)

func wantSet(wants ...ledger.Want) map[string]ledger.Want {
	m := map[string]ledger.Want{}
	for _, w := range wants {
		m[w.BuildingID] = w
	}
	return m
}

func TestWantsHaveIndependentHolds(t *testing.T) {
	ttl := 12 * time.Second
	d := NewDeadlines(ttl)
	t0 := time.Now()
	d.Observe("1", true, nil, wantSet(ledger.Want{BuildingID: "a", Amps: 40, Version: 1}), t0)
	d.Observe("1", true, nil, wantSet(ledger.Want{BuildingID: "a", Amps: 40, Version: 1}, ledger.Want{BuildingID: "b", Amps: 40, Version: 2}), t0.Add(5*time.Second))
	if len(d.DueWants(t0.Add(ttl-time.Nanosecond))) != 0 {
		t.Fatal("early want expiry")
	}
	if got := d.DueWants(t0.Add(ttl)); len(got) != 1 || got["a"] != 1 {
		t.Fatalf("a's hold missing or moved: %v", got)
	}
	if got := d.DueWants(t0.Add(16 * time.Second)); len(got) != 1 || got["a"] != 1 {
		t.Fatalf("b due too early: %v", got)
	}
	if got := d.DueWants(t0.Add(17 * time.Second)); len(got) != 2 || got["a"] != 1 || got["b"] != 2 {
		t.Fatalf("b's hold missing: %v", got)
	}
}
func TestRefreshedWantResetsOnlyItsOwnHold(t *testing.T) {
	d := NewDeadlines(12 * time.Second)
	t0 := time.Now()
	both := wantSet(ledger.Want{BuildingID: "a", Amps: 40, Version: 1}, ledger.Want{BuildingID: "b", Amps: 40, Version: 2})
	d.Observe("1", true, nil, both, t0)
	// Observing the same version again, at any later time, never moves its hold.
	d.Observe("1", true, nil, both, t0.Add(6*time.Second))
	// a is refreshed (new version, so a new hold); b is untouched.
	d.Observe("1", true, nil, wantSet(ledger.Want{BuildingID: "a", Amps: 40, Version: 3}, ledger.Want{BuildingID: "b", Amps: 40, Version: 2}), t0.Add(8*time.Second))
	if got := d.DueWants(t0.Add(12 * time.Second)); len(got) != 1 || got["b"] != 2 {
		t.Fatalf("only the unrefreshed want is due: %v", got)
	}
	if got := d.DueWants(t0.Add(19*time.Second + 999*time.Millisecond)); len(got) != 1 || got["b"] != 2 {
		t.Fatalf("refreshed want expired early: %v", got)
	}
	if got := d.DueWants(t0.Add(20 * time.Second)); len(got) != 2 || got["a"] != 3 || got["b"] != 2 {
		t.Fatalf("the refreshed version must be the one reported: %v", got)
	}
}
func TestWantTermAndLeadershipChangesClearHolds(t *testing.T) {
	d := NewDeadlines(12 * time.Second)
	t0 := time.Now()
	wants := wantSet(ledger.Want{BuildingID: "a", Amps: 40, Version: 1})
	d.Observe("1", true, nil, wants, t0)
	if len(d.DueWants(t0.Add(12*time.Second))) != 1 {
		t.Fatal("hold missing")
	}
	d.Observe("2", true, nil, wants, t0.Add(20*time.Second))
	if len(d.DueWants(t0.Add(31*time.Second))) != 0 {
		t.Fatal("inherited want did not receive a full hold from the new leader")
	}
	if got := d.DueWants(t0.Add(32 * time.Second)); got["a"] != 1 {
		t.Fatalf("inherited want hold absent: %v", got)
	}
	d.Observe("2", false, nil, wants, t0.Add(40*time.Second))
	if len(d.DueWants(t0.Add(time.Hour))) != 0 {
		t.Fatal("a follower proposes want expiry")
	}
	d.Observe("2", true, nil, wants, t0.Add(50*time.Second))
	d.Reset()
	d.Observe("2", true, nil, wants, t0.Add(60*time.Second))
	if len(d.DueWants(t0.Add(71*time.Second))) != 0 {
		t.Fatal("a leadership event did not conservatively reset want holds")
	}
	if len(d.DueWants(t0.Add(72*time.Second))) != 1 {
		t.Fatal("hold after the reset missing")
	}
}
func TestRemovedWantVersionsAreDropped(t *testing.T) {
	d := NewDeadlines(12 * time.Second)
	t0 := time.Now()
	d.Observe("1", true, nil, wantSet(ledger.Want{BuildingID: "a", Amps: 40, Version: 1}, ledger.Want{BuildingID: "b", Amps: 5, Version: 2}), t0)
	// a's want expired by consensus; b's was replaced by version 7.
	d.Observe("1", true, nil, wantSet(ledger.Want{BuildingID: "b", Amps: 5, Version: 7}), t0.Add(5*time.Second))
	if n := len(d.wants); n != 1 {
		t.Fatalf("tracked wants=%d", n)
	}
	if got := d.DueWants(t0.Add(12 * time.Second)); len(got) != 0 {
		t.Fatalf("removed or replaced want versions still reported due: %v", got)
	}
	if got := d.DueWants(t0.Add(17 * time.Second)); len(got) != 1 || got["b"] != 7 {
		t.Fatalf("replacement version lost its hold: %v", got)
	}
	// A building whose want returns later is a new observation with a new hold.
	d.Observe("1", true, nil, wantSet(), t0.Add(18*time.Second))
	d.Observe("1", true, nil, wantSet(ledger.Want{BuildingID: "b", Amps: 5, Version: 9}), t0.Add(30*time.Second))
	if len(d.DueWants(t0.Add(41*time.Second))) != 0 || len(d.DueWants(t0.Add(42*time.Second))) != 1 {
		t.Fatal("a returning want must get a fresh hold")
	}
	d.Observe("1", true, nil, nil, t0.Add(43*time.Second))
	if len(d.wants) != 0 || len(d.DueWants(t0.Add(time.Hour))) != 0 {
		t.Fatal("empty wants kept holds")
	}
}
func TestWantAndLeaseHoldsAreIndependent(t *testing.T) {
	d := NewDeadlines(12 * time.Second)
	t0 := time.Now()
	leases := tiered("a", ledger.Tier{Version: 5, Amps: 40})
	wants := wantSet(ledger.Want{BuildingID: "a", Amps: 100, Version: 6})
	d.Observe("1", true, leases, wants, t0)
	d.Observe("1", true, leases, wantSet(ledger.Want{BuildingID: "a", Amps: 100, Version: 8}), t0.Add(6*time.Second))
	if got := d.Due(t0.Add(12 * time.Second)); len(got) != 1 || got["a"] != 5 {
		t.Fatalf("lease hold changed by want observations: %v", got)
	}
	if got := d.DueWants(t0.Add(12 * time.Second)); len(got) != 0 {
		t.Fatalf("want refresh did not reset the want hold: %v", got)
	}
	if got := d.DueWants(t0.Add(18 * time.Second)); len(got) != 1 || got["a"] != 8 {
		t.Fatalf("%v", got)
	}
	// Wants may exist without a lease (and the reverse): neither side prunes the other.
	d.Observe("1", true, map[string]ledger.Lease{}, wantSet(ledger.Want{BuildingID: "a", Amps: 100, Version: 8}), t0.Add(19*time.Second))
	if len(d.Due(t0.Add(time.Hour))) != 0 || d.DueWants(t0.Add(time.Hour))["a"] != 8 {
		t.Fatal("lease removal disturbed the want hold")
	}
}

package coordinator

import (
	"ishtirak/internal/ledger"
	"testing"
	"time"
)

func TestFailoverGetsFullInheritedHold(t *testing.T) {
	ttl := 12 * time.Second
	d := NewDeadlines(ttl)
	t0 := time.Now()
	leases := map[string]ledger.Lease{"a": {Version: 1}}
	d.Observe("1", true, leases, t0)
	if len(d.Due(t0.Add(ttl-time.Nanosecond))) != 0 {
		t.Fatal("early expiry")
	}
	if len(d.Due(t0.Add(ttl))) != 1 {
		t.Fatal("deadline missing")
	}
	d.Observe("2", true, leases, t0.Add(20*time.Second))
	if len(d.Due(t0.Add(31*time.Second))) != 0 {
		t.Fatal("inherited lease did not receive full hold")
	}
	if len(d.Due(t0.Add(32*time.Second))) != 1 {
		t.Fatal("inherited deadline absent")
	}
}
func tiered(building string, tiers ...ledger.Tier) map[string]ledger.Lease {
	return map[string]ledger.Lease{building: {BuildingID: building, Amps: tiers[0].Amps, Version: tiers[len(tiers)-1].Version, Tiers: tiers}}
}
func TestTiersHaveIndependentDeadlines(t *testing.T) {
	ttl := 12 * time.Second
	d := NewDeadlines(ttl)
	t0 := time.Now()
	d.Observe("1", true, tiered("a", ledger.Tier{Version: 1, Amps: 107}), t0)
	// The renewal creates a second tier; it must not delay the older tier's deadline.
	d.Observe("1", true, tiered("a", ledger.Tier{Version: 1, Amps: 107}, ledger.Tier{Version: 2, Amps: 26}), t0.Add(5*time.Second))
	if len(d.Due(t0.Add(ttl-time.Nanosecond))) != 0 {
		t.Fatal("early expiry")
	}
	if got := d.Due(t0.Add(ttl)); len(got) != 1 || got["a"] != 1 {
		t.Fatalf("older tier deadline moved or missing: %v", got)
	}
	if got := d.Due(t0.Add(16 * time.Second)); got["a"] != 1 {
		t.Fatalf("newer tier due too early: %v", got)
	}
	if got := d.Due(t0.Add(17 * time.Second)); got["a"] != 2 {
		t.Fatalf("newer tier deadline missing: %v", got)
	}
}
func TestDueReturnsHighestDueVersion(t *testing.T) {
	d := NewDeadlines(12 * time.Second)
	t0 := time.Now()
	d.Observe("1", true, tiered("a", ledger.Tier{Version: 1, Amps: 90}), t0)
	d.Observe("1", true, tiered("a", ledger.Tier{Version: 1, Amps: 90}, ledger.Tier{Version: 2, Amps: 60}), t0.Add(time.Second))
	d.Observe("1", true, tiered("a", ledger.Tier{Version: 1, Amps: 90}, ledger.Tier{Version: 2, Amps: 60}, ledger.Tier{Version: 3, Amps: 30}), t0.Add(2*time.Second))
	for at, want := range map[time.Duration]uint64{12 * time.Second: 1, 13 * time.Second: 2, 14 * time.Second: 3, time.Hour: 3} {
		if got := d.Due(t0.Add(at)); got["a"] != want {
			t.Fatalf("at %s: due=%v want %d", at, got, want)
		}
	}
	if len(d.Due(t0.Add(11*time.Second))) != 0 {
		t.Fatal("nothing should be due yet")
	}
}
func TestTermChangeClearsEveryTierDeadline(t *testing.T) {
	d := NewDeadlines(12 * time.Second)
	t0 := time.Now()
	leases := tiered("a", ledger.Tier{Version: 1, Amps: 90}, ledger.Tier{Version: 2, Amps: 60})
	d.Observe("1", true, leases, t0)
	if d.Due(t0.Add(12 * time.Second))["a"] != 2 {
		t.Fatal("tiers first seen together share a deadline; the highest is due")
	}
	d.Observe("2", true, leases, t0.Add(20*time.Second))
	if len(d.Due(t0.Add(31*time.Second))) != 0 {
		t.Fatal("inherited tiers did not receive a full hold")
	}
	if d.Due(t0.Add(32 * time.Second))["a"] != 2 {
		t.Fatal("both inherited tiers share the new deadline; the highest is due")
	}
	d.Observe("2", false, leases, t0.Add(40*time.Second))
	if len(d.Due(t0.Add(time.Hour))) != 0 {
		t.Fatal("follower expires tiers")
	}
}
func TestRemovedVersionsAreDropped(t *testing.T) {
	d := NewDeadlines(12 * time.Second)
	t0 := time.Now()
	d.Observe("1", true, tiered("a", ledger.Tier{Version: 1, Amps: 90}), t0)
	d.Observe("1", true, tiered("a", ledger.Tier{Version: 1, Amps: 90}, ledger.Tier{Version: 2, Amps: 60}), t0.Add(5*time.Second))
	// Tier 1 expired and was removed by consensus.
	d.Observe("1", true, tiered("a", ledger.Tier{Version: 2, Amps: 60}), t0.Add(6*time.Second))
	if n := len(d.items["a"]); n != 1 {
		t.Fatalf("tracked versions=%d", n)
	}
	if len(d.Due(t0.Add(12*time.Second))) != 0 {
		t.Fatal("removed tier still reported due")
	}
	if d.Due(t0.Add(17 * time.Second))["a"] != 2 {
		t.Fatal("surviving tier lost its deadline")
	}
	d.Observe("1", true, map[string]ledger.Lease{}, t0.Add(18*time.Second))
	if len(d.items) != 0 || len(d.Due(t0.Add(time.Hour))) != 0 {
		t.Fatal("deleted lease kept deadlines")
	}
}
func TestRenewalExtendsButDuplicateDoesNot(t *testing.T) {
	d := NewDeadlines(12 * time.Second)
	t0 := time.Now()
	leases := map[string]ledger.Lease{"a": {Version: 1}}
	d.Observe("1", true, leases, t0)
	d.Observe("1", true, leases, t0.Add(5*time.Second))
	if len(d.Due(t0.Add(12*time.Second))) != 1 {
		t.Fatal("duplicate extended deadline")
	}
	leases["a"] = ledger.Lease{Version: 2}
	d.Observe("1", true, leases, t0.Add(13*time.Second))
	if len(d.Due(t0.Add(24*time.Second))) != 0 {
		t.Fatal("renewal expired early")
	}
	d.Reset()
	d.Observe("1", true, leases, t0.Add(30*time.Second))
	if len(d.Due(t0.Add(41*time.Second))) != 0 {
		t.Fatal("leadership event did not conservatively reset")
	}
	d.Observe("1", false, leases, t0.Add(50*time.Second))
	if len(d.Due(t0.Add(99*time.Second))) != 0 {
		t.Fatal("follower expires leases")
	}
}

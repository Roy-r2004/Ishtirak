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

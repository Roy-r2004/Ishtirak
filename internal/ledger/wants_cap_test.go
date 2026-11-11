package ledger

import (
	"fmt"
	"testing"
)

// fillWants records a want for MaxWants distinct buildings (1 A each, the policy decides whether they are granted).
func fillWants(t *testing.T, f *FSM, index *uint64) {
	t.Helper()
	for i := 0; i < MaxWants; i++ {
		*index++
		apply(f, *index, 1, grant(fmt.Sprintf("fill-%d", i), fmt.Sprintf("fill-%d", i), "s", 1))
	}
	if got := len(wantsOf(f)); got != MaxWants {
		t.Fatalf("expected %d wants after filling, got %d", MaxWants, got)
	}
}

func TestWantsAreBoundedUnderFairShare(t *testing.T) {
	f := initializedFSM(1000)
	var index uint64 = 1
	apply(f, index, 1, setPolicy("fair_share"))
	fillWants(t, f, &index)
	// A new building beyond the bound records no want and, having a share of 0, is refused.
	index++
	res := apply(f, index, 1, grant("new-1", "newcomer", "s", 5))
	if res.Accepted || res.Reason != "capacity_exhausted" {
		t.Fatalf("a building beyond the want bound must be refused, got %+v", res)
	}
	if _, ok := wantsOf(f)["newcomer"]; ok || len(wantsOf(f)) != MaxWants {
		t.Fatalf("the bound was exceeded: %d wants, newcomer recorded=%v", len(wantsOf(f)), ok)
	}
	if reserved(f, "newcomer") != 0 || Granted(f.View()) > 1000 {
		t.Fatalf("a refused newcomer must reserve nothing; granted %d", Granted(f.View()))
	}
	// A building already in the set can always refresh its want and keeps being served.
	index++
	res = apply(f, index, 1, grant("fill-0-again", "fill-0", "s", 7))
	if !res.Accepted || wantsOf(f)["fill-0"].Amps != 7 || len(wantsOf(f)) != MaxWants {
		t.Fatalf("a known building must refresh its want: %+v wants=%d", res, len(wantsOf(f)))
	}
	checkWantInvariants(t, f, "bounded wants")
	checkInvariants(t, f, "bounded wants")
}

func TestExpiringAWantMakesRoomForANewBuilding(t *testing.T) {
	f := initializedFSM(1000)
	var index uint64 = 1
	apply(f, index, 1, setPolicy("fair_share"))
	fillWants(t, f, &index)
	version := wantsOf(f)["fill-3"].Version
	index++
	apply(f, index, 1, expireWant("fill-3", version, 1))
	if _, ok := wantsOf(f)["fill-3"]; ok {
		t.Fatal("the want did not expire")
	}
	index++
	res := apply(f, index, 1, grant("new-2", "newcomer", "s", 5))
	if !res.Accepted || wantsOf(f)["newcomer"].Amps != 5 {
		t.Fatalf("after a want expired there is room for a new building: %+v", res)
	}
}

func TestFirstComeIgnoresTheWantBound(t *testing.T) {
	f := initializedFSM(1000)
	var index uint64 = 1
	fillWants(t, f, &index) // policy is the zero value: first_come
	index++
	res := apply(f, index, 1, grant("new-3", "newcomer", "s", 5))
	if !res.Accepted || res.Reason != "granted" || res.Lease == nil || res.Lease.Amps != 5 {
		t.Fatalf("first_come must serve a building beyond the want bound unchanged: %+v", res)
	}
	if _, ok := wantsOf(f)["newcomer"]; ok || len(wantsOf(f)) != MaxWants {
		t.Fatalf("no want may be recorded beyond the bound: %d wants", len(wantsOf(f)))
	}
}

// With a tiny capacity most of the 64 buildings are refused (they hold no lease) yet still record a want. A newcomer
// then displaces the OLDEST lease-less want, never the want of a building that holds a lease.
func TestANewcomerEvictsTheOldestLeaseLessWantAndNeverALeaseholder(t *testing.T) {
	f := initializedFSM(10)
	var index uint64 = 1
	apply(f, index, 1, setPolicy("fair_share"))
	fillWants(t, f, &index)
	holders := []string{}
	oldestLeaseLess := ""
	for i := 0; i < MaxWants; i++ {
		name := fmt.Sprintf("fill-%d", i)
		if reserved(f, name) > 0 {
			holders = append(holders, name)
		} else if oldestLeaseLess == "" {
			oldestLeaseLess = name
		}
	}
	if len(holders) == 0 || oldestLeaseLess == "" {
		t.Fatalf("the scenario needs both leaseholders and refused buildings: holders=%v", holders)
	}
	index++
	apply(f, index, 1, grant("real-1", "real", "s", 5))
	w := wantsOf(f)
	if _, ok := w["real"]; !ok {
		t.Fatal("the newcomer must be able to record a want by displacing a lease-less one")
	}
	if _, ok := w[oldestLeaseLess]; ok {
		t.Fatalf("the oldest lease-less want %s must have been evicted", oldestLeaseLess)
	}
	for _, h := range holders {
		if _, ok := w[h]; !ok {
			t.Fatalf("the want of leaseholder %s must never be evicted", h)
		}
	}
	if len(w) != MaxWants {
		t.Fatalf("the set must stay at its bound, got %d", len(w))
	}
	checkWantInvariants(t, f, "eviction")
	checkInvariants(t, f, "eviction")
}

// A building that holds a lease is always admitted, even when the set is full of other leaseholders.
func TestALeaseholderWhoseWantExpiredIsAlwaysAdmitted(t *testing.T) {
	f := initializedFSM(1000)
	var index uint64 = 1
	apply(f, index, 1, setPolicy("fair_share"))
	fillWants(t, f, &index) // everyone holds a 1 A lease
	version := wantsOf(f)["fill-3"].Version
	index++
	apply(f, index, 1, expireWant("fill-3", version, 1))
	index++
	apply(f, index, 1, grant("late-1", "latecomer", "s", 5)) // takes the freed slot: the set is full again
	if len(wantsOf(f)) != MaxWants {
		t.Fatalf("expected a full set, got %d", len(wantsOf(f)))
	}
	index++
	res := apply(f, index, 1, grant("fill-3-again", "fill-3", "s", 2))
	if !res.Accepted {
		t.Fatalf("a leaseholder must be served: %+v", res)
	}
	if _, ok := wantsOf(f)["fill-3"]; !ok {
		t.Fatal("a leaseholder must always be able to record its want")
	}
	if len(wantsOf(f)) > MaxWants+len(f.View().Leases) {
		t.Fatalf("the set may exceed the bound only by the number of leaseholders, got %d", len(wantsOf(f)))
	}
}

// Leaseholders may exceed the soft bound, but never the hard ceiling, whatever the generator's capacity is.
func TestLeaseholderBypassHasAHardBound(t *testing.T) {
	f := initializedFSM(100000)
	var index uint64 = 1
	const buildings = MaxWantsHard + 50
	for i := 0; i < buildings; i++ { // first_come: every building is served, only the first MaxWants record a want
		index++
		res := apply(f, index, 1, grant(fmt.Sprintf("a-%d", i), fmt.Sprintf("b-%d", i), "s", 1))
		if !res.Accepted {
			t.Fatalf("first_come must serve building %d: %+v", i, res)
		}
	}
	if got := len(wantsOf(f)); got != MaxWants {
		t.Fatalf("only %d wants may be recorded while the buildings hold no lease, got %d", MaxWants, got)
	}
	for i := 0; i < buildings; i++ { // renewals: now every building holds a lease and asks to record its want
		index++
		apply(f, index, 1, grant(fmt.Sprintf("r-%d", i), fmt.Sprintf("b-%d", i), "s", 1))
	}
	if got := len(wantsOf(f)); got != MaxWantsHard {
		t.Fatalf("leaseholders must fill the set up to the hard ceiling %d and no further, got %d", MaxWantsHard, got)
	}
	checkWantInvariants(t, f, "hard bound")
	checkInvariants(t, f, "hard bound")
}

// A leaseholder that cannot get a want slot (the set is full of other leaseholders) keeps what it holds under
// fair_share instead of falling to a share of 0, and never grows.
func TestLeaseholderWithoutAWantSlotKeepsItsReservation(t *testing.T) {
	f := initializedFSM(100000)
	var index uint64 = 1
	const buildings = MaxWantsHard + 20
	for round := 0; round < 2; round++ { // grant, then renew so every building holds a lease and asks for a want slot
		for i := 0; i < buildings; i++ {
			index++
			apply(f, index, 1, grant(fmt.Sprintf("a%d-%d", round, i), fmt.Sprintf("b-%d", i), "s", 1))
		}
	}
	if got := len(wantsOf(f)); got != MaxWantsHard {
		t.Fatalf("setup: expected the set at its hard ceiling %d, got %d", MaxWantsHard, got)
	}
	var starved string
	for i := 0; i < buildings; i++ {
		if _, ok := wantsOf(f)[fmt.Sprintf("b-%d", i)]; !ok {
			starved = fmt.Sprintf("b-%d", i)
			break
		}
	}
	if starved == "" {
		t.Fatal("setup: expected a leaseholder without a want slot")
	}
	index++
	apply(f, index, 1, setPolicy("fair_share"))
	before := Granted(f.View())
	index++
	res := apply(f, index, 1, grant("renew-1", starved, "s", 5))
	if !res.Accepted || res.Lease == nil || res.Lease.Amps != 1 || res.Reason != "granted_partial" {
		t.Fatalf("a leaseholder without a want slot must keep its reservation without growth: %+v", res)
	}
	if reserved(f, starved) != 1 || Granted(f.View()) != before {
		t.Fatalf("no growth is allowed: reserved %d, total %d -> %d", reserved(f, starved), before, Granted(f.View()))
	}
	// Freed room lets it back in: eviction is attempted first, so a lease-less want makes space.
	checkWantInvariants(t, f, "no slot")
	checkInvariants(t, f, "no slot")
}

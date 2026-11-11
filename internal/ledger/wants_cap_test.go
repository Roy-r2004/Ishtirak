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

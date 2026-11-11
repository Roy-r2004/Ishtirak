package ledger

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

// ---- 1. FairShares against two independent oracles -------------------------------------------------------------

// atkBruteForce returns the sorted-ascending allocation vector that is lexicographically greatest among all
// feasible integer allocations (the definition of max-min fairness), by exhaustive search.
func atkBruteForce(capacity int, wants []int) []int {
	n := len(wants)
	best := []int(nil)
	cur := make([]int, n)
	var rec func(i, left int)
	rec = func(i, left int) {
		if i == n {
			v := append([]int(nil), cur...)
			sort.Ints(v)
			if best == nil {
				best = v
				return
			}
			for k := range v {
				if v[k] != best[k] {
					if v[k] > best[k] {
						best = v
					}
					return
				}
			}
			return
		}
		for a := 0; a <= min(wants[i], capacity, left); a++ {
			cur[i] = a
			rec(i+1, left-a)
		}
	}
	rec(0, capacity)
	return best
}

func TestAdversarialFairSharesAgainstBruteForceMaxMin(t *testing.T) {
	rng := rand.New(rand.NewSource(99))
	for i := 0; i < 4000; i++ {
		capacity, n := 1+rng.Intn(9), 1+rng.Intn(4)
		wants := make([]int, n)
		m := map[string]int{}
		for j := range wants {
			wants[j] = 1 + rng.Intn(capacity+3)
			m[fmt.Sprintf("b%d", j)] = wants[j]
		}
		got := shares(capacity, m)
		vec := make([]int, 0, n)
		total, wantSum := 0, 0
		for b, a := range got {
			vec = append(vec, a)
			total += a
			wantSum += min(m[b], capacity)
		}
		sort.Ints(vec)
		if want := atkBruteForce(capacity, wants); !reflect.DeepEqual(vec, want) {
			t.Fatalf("capacity %d wants %v: FairShares %v is not the max-min vector %v", capacity, wants, vec, want)
		}
		if total != min(capacity, wantSum) {
			t.Fatalf("capacity %d wants %v: not work-conserving, sum %d", capacity, wants, total)
		}
	}
}

// atkWaterFill is a different algorithm (find the largest water level) with the same tie rule as the spec.
func atkWaterFill(capacity int, wants map[string]int) map[string]int {
	type bw struct {
		id string
		w  int
	}
	var all []bw
	for id, w := range wants {
		all = append(all, bw{id, min(w, capacity)})
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].w != all[j].w {
			return all[i].w < all[j].w
		}
		return all[i].id < all[j].id
	})
	sum := func(level int) int {
		s := 0
		for _, x := range all {
			s += min(x.w, level)
		}
		return s
	}
	level := 0
	for sum(level+1) <= capacity && level < capacity {
		level++
	}
	out := map[string]int{}
	left := capacity - sum(level)
	for _, x := range all {
		a := min(x.w, level)
		if x.w > level && left > 0 {
			a++
			left--
		}
		out[x.id] = a
	}
	return out
}

func TestAdversarialFairSharesAgainstWaterFillingOracle(t *testing.T) {
	rng := rand.New(rand.NewSource(5))
	for i := 0; i < 20000; i++ {
		capacity, n := 1+rng.Intn(400), 1+rng.Intn(40)
		wants := map[string]int{}
		for j := 0; j < n; j++ {
			w := 1 + rng.Intn(500)
			if rng.Intn(3) == 0 {
				w = 1 + rng.Intn(10)
			}
			wants[fmt.Sprintf("b%02d", rng.Intn(60))] = w
		}
		if got, want := shares(capacity, wants), atkWaterFill(capacity, wants); !reflect.DeepEqual(got, want) {
			t.Fatalf("capacity %d wants %v\n FairShares %v\n oracle     %v", capacity, wants, got, want)
		}
	}
}

// ---- 2. Extreme integers and malformed commands never break an invariant or panic --------------------------------

func TestAdversarialExtremeValuesKeepInvariants(t *testing.T) {
	extremes := []int{math.MaxInt64, math.MinInt64, math.MaxInt32, 1 << 40, -1, 0, 1, 119, 120, 121}
	rng := rand.New(rand.NewSource(3))
	f := initializedFSM(120)
	term := uint64(1)
	for i := 1; i <= 6000; i++ {
		if rng.Intn(50) == 0 {
			term++
		}
		b := fmt.Sprintf("b%d", rng.Intn(5))
		var c Command
		switch rng.Intn(8) {
		case 0, 1, 2, 3:
			c = grant(fmt.Sprint("r", rng.Intn(i+1)), b, fmt.Sprint("s", rng.Intn(2)), extremes[rng.Intn(len(extremes))])
			if rng.Intn(2) == 0 {
				c.Request.Amps = 1 + rng.Intn(300)
			}
		case 4:
			c = expire(b, uint64(rng.Intn(i+1)), term)
		case 5:
			c = expireWant(b, uint64(rng.Intn(i+1)), term)
		case 6:
			c = setPolicy([]string{"fair_share", "first_come"}[rng.Intn(2)])
		default:
			c = Command{Kind: "init_capacity", Capacity: extremes[rng.Intn(len(extremes))]}
		}
		apply(f, uint64(i), term, c)
		checkInvariants(t, f, fmt.Sprint("step ", i))
		checkWantInvariants(t, f, fmt.Sprint("step ", i))
	}
}

// ---- 3. An exact conformance model of SPEC.md (written from the spec, not from the implementation) ---------------

type atkModel struct {
	capacity   int
	fair       bool
	leases     map[string]Lease
	wants      map[string]Want
	results    map[string]RecordedResult
	configured bool
}

func (m *atkModel) granted() int {
	n := 0
	for _, l := range m.leases {
		n += l.Amps
	}
	return n
}
func (m *atkModel) grant(r Request, index uint64) Result {
	if prev, ok := m.results[r.RequestID]; ok {
		if prev.Hash != Hash(r) {
			return Result{RequestID: r.RequestID, Reason: "request_id_conflict"}
		}
		return prev.Result
	}
	res := Result{RequestID: r.RequestID}
	defer func() { m.results[r.RequestID] = RecordedResult{Hash: Hash(r), Result: res} }()
	cur, exists := m.leases[r.BuildingID]
	if r.RequestID == "" || r.BuildingID == "" || r.SessionID == "" || len(r.RequestID) > 128 || len(r.BuildingID) > 128 || len(r.SessionID) > 128 || r.Amps <= 0 || (!m.fair && r.Amps > m.capacity) {
		res.Reason = "invalid_request"
		return res
	}
	if exists && cur.SessionID != r.SessionID {
		res.Reason = "building_session_active"
		return res
	}
	m.wants[r.BuildingID] = Want{r.BuildingID, min(r.Amps, m.capacity), index}
	t := r.Amps
	if m.fair {
		t = min(m.wants[r.BuildingID].Amps, atkWaterFill(m.capacity, func() map[string]int {
			x := map[string]int{}
			for id, w := range m.wants {
				x[id] = w.Amps
			}
			return x
		}())[r.BuildingID])
		if free := m.capacity - m.granted(); t > cur.Amps {
			t = cur.Amps + min(t-cur.Amps, free)
		}
	}
	if t <= 0 || max(t-cur.Amps, 0) > m.capacity-m.granted() {
		res.Reason = "capacity_exhausted"
		return res
	}
	var tiers []Tier
	for _, x := range cur.Tiers {
		if x.Amps > t {
			tiers = append(tiers, x)
		}
	}
	tiers = append(tiers, Tier{index, t})
	m.leases[r.BuildingID] = Lease{BuildingID: r.BuildingID, SessionID: r.SessionID, Amps: tiers[0].Amps, Version: index, Tiers: tiers}
	res.Accepted, res.Reason = true, "granted"
	if t != r.Amps {
		res.Reason = "granted_partial"
	}
	res.Lease = &Lease{BuildingID: r.BuildingID, SessionID: r.SessionID, Amps: t, Version: index}
	return res
}
func (m *atkModel) expire(b string, version, term, logTerm uint64) {
	l, ok := m.leases[b]
	if !ok || term != logTerm || !l.HasTier(version) {
		return
	}
	var kept []Tier
	for _, x := range l.Tiers {
		if x.Version > version {
			kept = append(kept, x)
		}
	}
	if len(kept) == 0 {
		delete(m.leases, b)
		return
	}
	l.Tiers, l.Amps = kept, kept[0].Amps
	m.leases[b] = l
}

func TestAdversarialExactConformanceWithSpecModelUnderBothPolicies(t *testing.T) {
	const capacity = 120
	for seed := int64(1); seed <= 12; seed++ {
		rng := rand.New(rand.NewSource(seed))
		f := initializedFSM(capacity)
		m := &atkModel{capacity: capacity, leases: map[string]Lease{}, wants: map[string]Want{}, results: map[string]RecordedResult{}}
		term := uint64(1)
		var ids []Request
		names := []string{"b0", "b1", "b2", "b3", "b4"}
		for i := 1; i <= 3000; i++ {
			if rng.Intn(30) == 0 {
				term++
			}
			b := names[rng.Intn(len(names))]
			switch k := rng.Intn(100); {
			case k < 60:
				session := fmt.Sprint("s", rng.Intn(2))
				if cur, ok := m.leases[b]; ok && rng.Intn(10) < 8 {
					session = cur.SessionID
				}
				req := Request{RequestID: fmt.Sprint("r", i), BuildingID: b, SessionID: session, Amps: rng.Intn(2*capacity+20) - 5}
				switch {
				case len(ids) > 0 && rng.Intn(12) == 0:
					req = ids[rng.Intn(len(ids))]
				case len(ids) > 0 && rng.Intn(25) == 0:
					req.RequestID = ids[rng.Intn(len(ids))].RequestID
				}
				ids = append(ids, req)
				wb, _ := json.Marshal(m.grant(req, uint64(i)))
				gb, _ := json.Marshal(apply(f, uint64(i), term, Command{Kind: "grant", Request: req, OccurredAt: "t"}))
				if !bytes.Equal(wb, gb) {
					t.Fatalf("seed %d step %d: FSM %s model %s", seed, i, gb, wb)
				}
			case k < 80:
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
			case k < 92:
				version := uint64(rng.Intn(i + 3))
				if w, ok := m.wants[b]; ok && rng.Intn(10) < 6 {
					version = w.Version
				}
				exp := term
				if rng.Intn(4) == 0 {
					exp = term + 1
				}
				if w, ok := m.wants[b]; ok && w.Version == version && exp == term {
					delete(m.wants, b)
				}
				apply(f, uint64(i), term, expireWant(b, version, exp))
			default:
				p := []string{"fair_share", "first_come"}[rng.Intn(2)]
				m.fair, m.configured = p == "fair_share", true
				apply(f, uint64(i), term, setPolicy(p))
			}
			checkInvariants(t, f, fmt.Sprint("seed ", seed, " step ", i))
			view := f.View()
			if view.FairShare != m.fair || !reflect.DeepEqual(view.Wants, m.wants) {
				t.Fatalf("seed %d step %d: policy/wants diverge FSM fair=%v wants=%v model fair=%v wants=%v", seed, i, view.FairShare, view.Wants, m.fair, m.wants)
			}
			for _, name := range names {
				if !reflect.DeepEqual(view.Leases[name], m.leases[name]) {
					t.Fatalf("seed %d step %d %s: FSM %+v model %+v", seed, i, name, view.Leases[name], m.leases[name])
				}
			}
		}
	}
}

// ---- 4. Demonstrations (documented limits) -----------------------------------------------------------------------

// A holder whose fair share is zero (more wanting buildings than amps) is refused, keeps its tiers untouched and
// never gets a zero-amp tier. The author's property test cannot reach this (4 buildings on 120 A).
func TestAdversarialZeroShareHolderIsRefusedWithoutCorruptingItsTiers(t *testing.T) {
	f := initializedFSM(3)
	apply(f, 1, 1, setPolicy("fair_share"))
	if r := apply(f, 2, 1, grant("d1", "d", "s", 3)); !r.Accepted {
		t.Fatal(r)
	}
	for i, b := range []string{"a", "b", "c"} {
		apply(f, uint64(3+i), 1, grant(fmt.Sprint("w", b), b, "s", 10)) // refused (nothing free) but each records a want
	}
	if got := FairShares(f.View())["d"]; got != 0 {
		t.Fatalf("setup: d's share is %d", got)
	}
	r := apply(f, 10, 1, grant("d2", "d", "s", 10))
	if r.Accepted || r.Reason != "capacity_exhausted" {
		t.Fatalf("zero share with a reservation: %+v", r)
	}
	checkInvariants(t, f, "zero share")
	wantTiers(t, f, "d", Tier{2, 3})
}

// The policy may never come from node-local configuration inside Apply.
func TestAdversarialPolicyIsNotReadFromTheEnvironmentInsideApply(t *testing.T) {
	t.Setenv("FAIR_SHARE", "true")
	f := initializedFSM(120)
	if r := apply(f, 1, 1, grant("big", "a", "s", 500)); r.Reason != "invalid_request" {
		t.Fatalf("an unconfigured ledger must behave as first_come whatever the environment says: %+v", r)
	}
}

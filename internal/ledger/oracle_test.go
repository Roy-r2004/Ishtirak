package ledger

import (
	"fmt"
	"math/rand"
	"testing"
)

// Unpruned oracle: remembers every committed grant of a building; expire(v) forgets grants with version<=v
// (applied whenever v is the version of any committed, not-yet-forgotten grant). reserved = max remembered.
type og struct {
	v    uint64
	amps int
}

func TestOracleAgreesWithUnprunedModel(t *testing.T) {
	for seed := int64(1); seed <= 30; seed++ {
		rng := rand.New(rand.NewSource(seed))
		const capacity = 120
		f := initializedFSM(capacity)
		sess := map[string]string{}
		mem := map[string][]og{}  // unpruned, expire applies for any remembered version
		memL := map[string][]og{} // unpruned, expire applies only if v is live in the real FSM (must match exactly)
		max := func(l []og) int {
			m := 0
			for _, g := range l {
				if g.amps > m {
					m = g.amps
				}
			}
			return m
		}
		total := func(m map[string][]og) int {
			n := 0
			for _, l := range m {
				n += max(l)
			}
			return n
		}
		term := uint64(1)
		for i := 1; i <= 4000; i++ {
			b := buildingNames[rng.Intn(3)]
			if rng.Intn(100) < 65 {
				amps := 1 + rng.Intn(capacity)
				if rng.Intn(2) == 0 {
					amps = 1 + rng.Intn(30)
				}
				s := "s0"
				if x, ok := sess[b]; ok {
					s = x
				}
				got := apply(f, uint64(i), term, grant(fmt.Sprint("r", i), b, s, amps))
				if got.Accepted {
					sess[b] = s
					mem[b] = append(mem[b], og{uint64(i), amps})
					memL[b] = append(memL[b], og{uint64(i), amps})
				}
			} else {
				cur, has := f.View().Leases[b]
				v := uint64(rng.Intn(i + 1))
				if has && rng.Intn(10) < 7 {
					v = cur.Tiers[rng.Intn(len(cur.Tiers))].Version
				}
				live := has && cur.HasTier(v)
				apply(f, uint64(i), term, expire(b, v, term))
				// oracle A: any remembered version
				for _, g := range mem[b] {
					if g.v == v {
						var k []og
						for _, h := range mem[b] {
							if h.v > v {
								k = append(k, h)
							}
						}
						mem[b] = k
						break
					}
				}
				if live {
					var k []og
					for _, h := range memL[b] {
						if h.v > v {
							k = append(k, h)
						}
					}
					memL[b] = k
				}
				if len(mem[b]) == 0 {
					delete(sess, b)
				}
				_ = live
			}
			view := f.View()
			for _, n := range buildingNames {
				if view.Leases[n].Amps != max(memL[n]) {
					t.Fatalf("seed %d step %d %s: real reserved %d, unpruned oracle %d (%+v)", seed, i, n, view.Leases[n].Amps, max(memL[n]), view.Leases[n])
				}
				if view.Leases[n].Amps < max(mem[n]) {
					t.Fatalf("seed %d step %d %s: real %d below lenient oracle %d", seed, i, n, view.Leases[n].Amps, max(mem[n]))
				}
				if _, ok := view.Leases[n]; ok != (len(memL[n]) > 0) {
					t.Fatalf("seed %d step %d %s lease presence mismatch", seed, i, n)
				}
			}
			if Granted(view) != total(memL) {
				t.Fatalf("granted mismatch")
			}
			// session map for oracle: leases gone => session free
			for _, n := range buildingNames {
				if _, ok := view.Leases[n]; !ok {
					delete(sess, n)
				}
			}
		}
	}
}

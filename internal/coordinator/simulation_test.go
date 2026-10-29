package coordinator

import (
	"encoding/json"
	"math/rand"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/hashicorp/raft"
	"ishtirak/internal/ledger"
)

type pend struct {
	at      time.Duration // commit time
	b       string
	sent    time.Duration
	amps    int
	id      string
	respond time.Duration // response delivery delay after commit
}
type gwGrant struct {
	b       string
	amps    int
	expires time.Duration
}

// Simulates leader loop + FSM + gateways with reordered/delayed commits, retries, term changes.
func TestSimulatedReservationNeverBelowUsableGrant(t *testing.T) {
	for seed := int64(1); seed <= 40; seed++ {
		rng := rand.New(rand.NewSource(seed))
		f := ledger.New()
		idx := uint64(0)
		term := uint64(1)
		app := func(c ledger.Command) ledger.Result {
			idx++
			b, _ := json.Marshal(c)
			return f.Apply(&raft.Log{Index: idx, Term: term, Data: b}).(ledger.Result)
		}
		app(ledger.Command{Kind: "init_capacity", Capacity: 120})
		base := time.Now()
		d := NewDeadlines(12 * time.Second)
		bs := []string{"a", "b", "c"}
		var pending []pend
		var gw []gwGrant
		var responses []struct {
			at time.Duration
			g  gwGrant
		}
		nid := 0
		tick := 100 * time.Millisecond
		observe := func(now time.Duration) {
			d.Observe(strconv.Itoa(int(term)), true, f.View().Leases, base.Add(now))
		}
		observe(0)
		nextTermChange := time.Duration(5+rng.Intn(40)) * time.Second
		shrinks := 0
		for now := time.Duration(0); now < 600*time.Second; now += tick {
			if now >= nextTermChange {
				term++
				d.Reset()
				// new leader observes late by up to 1 s
				observe(now + time.Duration(rng.Intn(1000))*time.Millisecond)
				nextTermChange = now + time.Duration(5+rng.Intn(40))*time.Second
			}
			// gateways send requests
			for _, b := range bs {
				if rng.Intn(15) == 0 {
					nid++
					amps := 1 + rng.Intn(60)
					if rng.Intn(3) == 0 {
						amps = 1 + rng.Intn(10)
					}
					delay := time.Duration(rng.Intn(4000)) * time.Millisecond
					pending = append(pending, pend{at: now + delay, b: b, sent: now, amps: amps, id: "r" + strconv.Itoa(nid), respond: time.Duration(rng.Intn(2000)) * time.Millisecond})
				}
			}
			sort.SliceStable(pending, func(i, j int) bool { return pending[i].at < pending[j].at })
			for len(pending) > 0 && pending[0].at <= now {
				p := pending[0]
				pending = pending[1:]
				res := app(ledger.Command{Kind: "grant", Request: ledger.Request{RequestID: p.id, BuildingID: p.b, SessionID: "s", Amps: p.amps}})
				observe(now)
				if res.Accepted {
					exp := p.sent + 10*time.Second
					if now+p.respond < exp {
						responses = append(responses, struct {
							at time.Duration
							g  gwGrant
						}{now + p.respond, gwGrant{p.b, res.Lease.Amps, exp}})
					}
				}
			}
			// leader expiry loop
			observe(now)
			for id, v := range d.Due(base.Add(now)) {
				l, ok := f.View().Leases[id]
				if !ok || !l.HasTier(v) {
					continue
				}
				before := ledger.Granted(f.View())
				app(ledger.Command{Kind: "expire", BuildingID: id, ExpectedVersion: v, ExpectedTerm: term})
				if ledger.Granted(f.View()) < before {
					shrinks++
				}
				observe(now)
			}
			// deliver responses
			rest := responses[:0]
			for _, r := range responses {
				if r.at <= now {
					gw = append(gw, r.g)
				} else {
					rest = append(rest, r)
				}
			}
			responses = rest
			// invariant: reserved >= max usable grant for each building
			view := f.View()
			if ledger.Granted(view) > 120 {
				t.Fatalf("seed %d: over capacity", seed)
			}
			for _, b := range bs {
				mx := 0
				for _, g := range gw {
					if g.b == b && g.expires > now && g.amps > mx {
						mx = g.amps
					}
				}
				if mx > view.Leases[b].Amps {
					t.Fatalf("seed %d t=%s building %s: gateway can still use %d but reserved %d (lease %+v)", seed, now, b, mx, view.Leases[b].Amps, view.Leases[b])
				}
			}
		}
		if shrinks == 0 {
			t.Fatalf("seed %d: never shrank", seed)
		}
	}
}

package coordinator

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"os"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/hashicorp/raft"
	"ishtirak/internal/ledger"
)

// Adversarial safety simulation: real FSM + real Deadlines + modelled gateways, with things the author's
// simulations do not do: policy toggles in both directions in the middle of holds, gateway restarts (new session),
// duplicate (retried) requests committed late, stale-term expire/expire_want commands, requests above capacity,
// demand random walks, and the safety check after EVERY command rather than once per tick.

type atkGrant struct {
	amps    int
	expires time.Duration
}
type atkPending struct {
	commit, sent, respond time.Duration
	b, session, id        string
	amps                  int
	dup                   bool
}
type atkDelivery struct {
	at      time.Duration
	b       string
	session string
	g       atkGrant
}

var atkSlow = func() float64 {
	if v, err := strconv.ParseFloat(os.Getenv("ATK_SLOW"), 64); err == nil {
		return v
	}
	return 1
}()
var atkPolicy = os.Getenv("ATK_POLICY")

func TestAdversarialSafetyUnderToggledPolicyRestartsDuplicatesAndStaleTerms(t *testing.T) {
	const capacity = 120
	buildings := []string{"a", "b", "c", "d"}
	policyFlips, restarts, dups, staleNoops, shrinks, partials, capped := 0, 0, 0, 0, 0, 0, 0
	for seed := int64(1); seed <= 60; seed++ {
		rng := rand.New(rand.NewSource(seed))
		f := ledger.New()
		idx, term := uint64(0), uint64(1)
		app := func(c ledger.Command, logTerm uint64) ledger.Result {
			idx++
			b, _ := json.Marshal(c)
			return f.Apply(&raft.Log{Index: idx, Term: logTerm, Data: b}).(ledger.Result)
		}
		app(ledger.Command{Kind: "init_capacity", Capacity: capacity}, term)
		initial := []string{"fair_share", "first_come"}[rng.Intn(2)]
		if atkPolicy != "" {
			initial = atkPolicy
		}
		app(ledger.Command{Kind: "set_policy", Policy: initial}, term)
		base := time.Now()
		d := NewDeadlines(12 * time.Second)
		observe := func(at time.Duration) {
			v := f.View()
			d.Observe(strconv.Itoa(int(term)), true, v.Leases, v.Wants, base.Add(at))
		}
		observe(0)
		gw := map[string][]atkGrant{}
		session := map[string]string{}
		demand := map[string]float64{}
		phase := map[string]time.Duration{}
		last := map[string]time.Duration{}
		for i, b := range buildings {
			session[b] = "s0"
			demand[b] = float64(10 + rng.Intn(100))
			phase[b] = time.Duration(rng.Intn(10)) * 100 * time.Millisecond
			last[b] = -time.Hour
			_ = i
		}
		var pending []atkPending
		var responses []atkDelivery
		var sent []atkPending
		nid := 0
		tick := 100 * time.Millisecond
		nextChange := time.Duration(8+rng.Intn(30)) * time.Second
		nextFlip := time.Duration(5+rng.Intn(25)) * time.Second
		usable := func(b string, now time.Duration) int {
			m := 0
			for _, g := range gw[b] {
				if g.expires > now && g.amps > m {
					m = g.amps
				}
			}
			return m
		}
		check := func(now time.Duration, what string) {
			view := f.View()
			if ledger.Granted(view) > capacity {
				t.Fatalf("seed %d t=%s after %s: reserved %d exceeds capacity", seed, now, what, ledger.Granted(view))
			}
			for _, b := range buildings {
				if u := usable(b, now); u > view.Leases[b].Amps {
					t.Fatalf("seed %d t=%s after %s: building %s gateway can still use %d but reserved %d (%+v) policy fair=%v", seed, now, what, b, u, view.Leases[b].Amps, view.Leases[b], view.FairShare)
				}
			}
		}
		for now := time.Duration(0); now < 400*time.Second; now += tick {
			if now >= nextChange {
				term++
				d.Reset()
				observe(now + time.Duration(rng.Intn(1000))*time.Millisecond)
				nextChange = now + time.Duration(8+rng.Intn(30))*time.Second
			}
			if now >= nextFlip {
				p := []string{"fair_share", "first_come"}[rng.Intn(2)]
				if atkPolicy != "" {
					p = atkPolicy
				}
				app(ledger.Command{Kind: "set_policy", Policy: p}, term)
				policyFlips++
				observe(now)
				check(now, "set_policy")
				nextFlip = now + time.Duration(3+rng.Intn(25))*time.Second
			}
			for _, b := range buildings {
				// Demand random walk with occasional bursts and silence.
				if rng.Intn(20) == 0 {
					demand[b] = math.Max(0, demand[b]+float64(rng.Intn(81)-40))
					if rng.Intn(25) == 0 {
						demand[b] = float64(100 + rng.Intn(100))
					}
				}
				// A gateway restart loses its grants and starts a new session.
				if rng.Intn(1500) == 0 {
					session[b] = "s" + strconv.Itoa(rng.Intn(1000000))
					gw[b] = nil
					restarts++
				}
				if now < phase[b] || (now-phase[b])%time.Second != 0 {
					continue
				}
				u := usable(b, now)
				req := int(math.Ceil(demand[b]))
				if now-last[b] < 3*time.Second && req <= u {
					continue
				}
				last[b] = now
				if req <= 0 || req > 1000000 {
					continue
				}
				nid++
				p := atkPending{commit: now + time.Duration(rng.Intn(3000))*time.Millisecond, sent: now, respond: time.Duration(rng.Intn(2000)) * time.Millisecond, b: b, session: session[b], id: "r" + strconv.Itoa(nid), amps: req}
				pending = append(pending, p)
				sent = append(sent, p)
			}
			// A retried request: the same id and payload committed again, later.
			if len(sent) > 0 && rng.Intn(40) == 0 {
				p := sent[rng.Intn(len(sent))]
				p.commit = now + time.Duration(rng.Intn(5000))*time.Millisecond
				p.dup = true
				pending = append(pending, p)
				dups++
			}
			// A stale leader's expire commands (right fields, wrong term) must never do anything.
			if term > 1 && rng.Intn(30) == 0 {
				view := f.View()
				for _, b := range buildings {
					if l, ok := view.Leases[b]; ok {
						before := f.View()
						app(ledger.Command{Kind: "expire", BuildingID: b, ExpectedVersion: l.Tiers[rng.Intn(len(l.Tiers))].Version, ExpectedTerm: term - 1}, term)
						if fmt.Sprint(f.View().Leases) != fmt.Sprint(before.Leases) {
							t.Fatalf("seed %d: stale-term expire changed leases", seed)
						}
						staleNoops++
						break
					}
				}
				if w, ok := f.View().Wants["a"]; ok {
					before := f.View()
					app(ledger.Command{Kind: "expire_want", BuildingID: "a", ExpectedVersion: w.Version, ExpectedTerm: term - 1}, term)
					if fmt.Sprint(f.View().Wants) != fmt.Sprint(before.Wants) {
						t.Fatalf("seed %d: stale-term expire_want changed wants", seed)
					}
				}
			}
			sort.SliceStable(pending, func(i, j int) bool { return pending[i].commit < pending[j].commit })
			for len(pending) > 0 && pending[0].commit <= now {
				p := pending[0]
				pending = pending[1:]
				before := f.View()
				res := app(ledger.Command{Kind: "grant", Request: ledger.Request{RequestID: p.id, BuildingID: p.b, SessionID: p.session, Amps: p.amps}}, term)
				observe(now)
				if res.Accepted {
					if res.Lease.Amps > p.amps {
						t.Fatalf("seed %d: granted %d for %d", seed, res.Lease.Amps, p.amps)
					}
					if res.Reason == "granted_partial" {
						partials++
					}
					if before.Leases[p.b].Amps > res.Lease.Amps {
						capped++
					}
					exp := p.sent + time.Duration(float64(10*time.Second)*atkSlow)
					// Only a response for the building's CURRENT session is usable by its gateway.
					if now+p.respond < exp && session[p.b] == p.session {
						responses = append(responses, atkDelivery{now + p.respond, p.b, p.session, atkGrant{res.Lease.Amps, exp}})
					}
				}
				check(now, "grant "+res.Reason)
			}
			observe(now)
			due := d.Due(base.Add(now))
			ids := make([]string, 0, len(due))
			for id := range due {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			for _, id := range ids {
				if l, ok := f.View().Leases[id]; !ok || !l.HasTier(due[id]) {
					continue
				}
				before := ledger.Granted(f.View())
				app(ledger.Command{Kind: "expire", BuildingID: id, ExpectedVersion: due[id], ExpectedTerm: term}, term)
				if ledger.Granted(f.View()) < before {
					shrinks++
				}
				observe(now)
				check(now, "expire")
			}
			dw := d.DueWants(base.Add(now))
			ids = ids[:0]
			for id := range dw {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			for _, id := range ids {
				if w, ok := f.View().Wants[id]; !ok || w.Version != dw[id] {
					continue
				}
				app(ledger.Command{Kind: "expire_want", BuildingID: id, ExpectedVersion: dw[id], ExpectedTerm: term}, term)
				observe(now)
				check(now, "expire_want")
			}
			rest := responses[:0]
			for _, r := range responses {
				if r.at <= now {
					if session[r.b] == r.session {
						gw[r.b] = append(gw[r.b], r.g)
					}
				} else {
					rest = append(rest, r)
				}
			}
			responses = rest
			check(now, "tick")
		}
	}
	t.Logf("flips=%d restarts=%d dups=%d staleNoops=%d shrinks=%d partials=%d cappedRenewals=%d", policyFlips, restarts, dups, staleNoops, shrinks, partials, capped)
}

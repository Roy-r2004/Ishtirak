package coordinator

import (
	"ishtirak/internal/ledger"
	"sort"
	"time"
)

// Deadlines must only be accessed under the server operation mutex. All supplied
// times originate from time.Now and retain Go's process-local monotonic clock.
// Every committed tier (building, tier version) has its own hold, set when the current
// leader term first observes it and never moved by later renewals.
type Deadlines struct {
	term   string
	active bool
	items  map[string]map[uint64]time.Time
	ttl    time.Duration
}

func NewDeadlines(ttl time.Duration) *Deadlines {
	return &Deadlines{ttl: ttl, items: map[string]map[uint64]time.Time{}}
}
func (d *Deadlines) Reset() {
	d.term = ""
	d.active = false
	d.items = map[string]map[uint64]time.Time{}
}
func (d *Deadlines) Observe(term string, active bool, leases map[string]ledger.Lease, now time.Time) {
	if term != d.term || active != d.active {
		d.items = map[string]map[uint64]time.Time{}
		d.term = term
		d.active = active
	}
	if !active {
		return
	}
	for id, l := range leases {
		tiers := l.TierList()
		held := d.items[id]
		if held == nil {
			held = map[uint64]time.Time{}
			d.items[id] = held
		}
		live := make(map[uint64]bool, len(tiers))
		for _, t := range tiers {
			live[t.Version] = true
			if _, ok := held[t.Version]; !ok {
				held[t.Version] = now.Add(d.ttl)
			}
		}
		for version := range held {
			if !live[version] {
				delete(held, version)
			}
		}
	}
	for id := range d.items {
		if _, ok := leases[id]; !ok {
			delete(d.items, id)
		}
	}
}

// Due returns, per building, the highest tier version whose hold has passed. Expiring a tier also removes
// every older one, so only a contiguous run of due tiers starting at the oldest may be reported.
func (d *Deadlines) Due(now time.Time) map[string]uint64 {
	out := map[string]uint64{}
	if !d.active {
		return out
	}
	for id, held := range d.items {
		versions := make([]uint64, 0, len(held))
		for v := range held {
			versions = append(versions, v)
		}
		sort.Slice(versions, func(i, j int) bool { return versions[i] < versions[j] })
		for _, v := range versions {
			if now.Before(held[v]) {
				break
			}
			out[id] = v
		}
	}
	return out
}

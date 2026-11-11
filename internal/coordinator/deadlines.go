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
	wants  map[string]wantHold
	ttl    time.Duration
}

// wantHold is the hold of a building's current want version.
type wantHold struct {
	version uint64
	due     time.Time
}

func NewDeadlines(ttl time.Duration) *Deadlines {
	return &Deadlines{ttl: ttl, items: map[string]map[uint64]time.Time{}, wants: map[string]wantHold{}}
}
func (d *Deadlines) Reset() {
	d.term = ""
	d.active = false
	d.items = map[string]map[uint64]time.Time{}
	d.wants = map[string]wantHold{}
}
func (d *Deadlines) Observe(term string, active bool, leases map[string]ledger.Lease, wants map[string]ledger.Want, now time.Time) {
	if term != d.term || active != d.active {
		d.items = map[string]map[uint64]time.Time{}
		d.wants = map[string]wantHold{}
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
	// A want's hold starts when this leader term first sees its version; a refreshed want is a new version and
	// so a new hold, and versions the ledger no longer carries are dropped.
	for id, w := range wants {
		if held, ok := d.wants[id]; !ok || held.version != w.Version {
			d.wants[id] = wantHold{version: w.Version, due: now.Add(d.ttl)}
		}
	}
	for id := range d.wants {
		if _, ok := wants[id]; !ok {
			delete(d.wants, id)
		}
	}
}

// DueWants returns, per building, the want version whose hold has passed. Expiring a want releases no
// reservation (it only stops a silent building's old want from capping the others), so no ordering is needed.
func (d *Deadlines) DueWants(now time.Time) map[string]uint64 {
	out := map[string]uint64{}
	if !d.active {
		return out
	}
	for id, h := range d.wants {
		if !now.Before(h.due) {
			out[id] = h.version
		}
	}
	return out
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

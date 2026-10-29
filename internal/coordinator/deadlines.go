package coordinator

import (
	"ishtirak/internal/ledger"
	"time"
)

type deadline struct {
	version uint64
	at      time.Time
}

// Deadlines must only be accessed under the server operation mutex. All supplied
// times originate from time.Now and retain Go's process-local monotonic clock.
type Deadlines struct {
	term   string
	active bool
	items  map[string]deadline
	ttl    time.Duration
}

func NewDeadlines(ttl time.Duration) *Deadlines {
	return &Deadlines{ttl: ttl, items: map[string]deadline{}}
}
func (d *Deadlines) Reset() { d.term = ""; d.active = false; d.items = map[string]deadline{} }
func (d *Deadlines) Observe(term string, active bool, leases map[string]ledger.Lease, now time.Time) {
	if term != d.term || active != d.active {
		d.items = map[string]deadline{}
		d.term = term
		d.active = active
	}
	if !active {
		return
	}
	for id, l := range leases {
		old, ok := d.items[id]
		if !ok || old.version != l.Version {
			d.items[id] = deadline{version: l.Version, at: now.Add(d.ttl)}
		}
	}
	for id := range d.items {
		if _, ok := leases[id]; !ok {
			delete(d.items, id)
		}
	}
}
func (d *Deadlines) Due(now time.Time) map[string]uint64 {
	out := map[string]uint64{}
	if !d.active {
		return out
	}
	for id, x := range d.items {
		if !now.Before(x.at) {
			out[id] = x.version
		}
	}
	return out
}

// Package ledger contains the deterministic, authoritative capacity state machine.
// Time is supplied only as audit metadata. Expiry is an explicit consensus command.
package ledger

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"sync"

	"github.com/hashicorp/raft"
)

type Request struct {
	RequestID  string `json:"request_id"`
	BuildingID string `json:"building_id"`
	SessionID  string `json:"session_id"`
	Amps       int    `json:"amps"`
}

// Tier is one committed grant that a gateway may still be using. Amps is the grant's own amount.
type Tier struct {
	Version uint64 `json:"version"`
	Amps    int    `json:"amps"`
}

// Lease is a building's reservation. Amps is the largest tier (the reserved amount) and Version the newest
// tier. Stored leases always carry Tiers (ascending Version, strictly decreasing Amps); a Result.Lease
// returned to a gateway is only that grant's own authorization and carries none.
type Lease struct {
	BuildingID string `json:"building_id"`
	SessionID  string `json:"session_id"`
	Amps       int    `json:"amps"`
	Version    uint64 `json:"version"`
	Tiers      []Tier `json:"tiers,omitempty"`
}
type Result struct {
	Accepted  bool   `json:"accepted"`
	Reason    string `json:"reason"`
	RequestID string `json:"request_id"`
	Lease     *Lease `json:"lease,omitempty"`
}
type Event struct {
	EventID    uint64 `json:"event_id"`
	Kind       string `json:"kind"`
	RequestID  string `json:"request_id,omitempty"`
	BuildingID string `json:"building_id"`
	SessionID  string `json:"session_id"`
	Amps       int    `json:"amps"`
	Version    uint64 `json:"version"`
	OccurredAt string `json:"occurred_at"`
}

// MaxWants bounds how many distinct buildings can have a recorded want at once (see admitWant). Buildings that hold
// a lease may exceed it up to MaxWantsHard, a ceiling that does not depend on the generator's capacity.
const (
	MaxWants     = 64
	MaxWantsHard = 4 * MaxWants
)

// Want is a building's most recent processed request amount (clamped to Capacity) and the log index that recorded it.
// Wants only steer fair-share caps; they never reserve anything.
type Want struct {
	BuildingID string `json:"building_id"`
	Amps       int    `json:"amps"`
	Version    uint64 `json:"version"`
}
type Command struct {
	Kind            string  `json:"kind"`
	Capacity        int     `json:"capacity_amps,omitempty"`
	Request         Request `json:"request,omitempty"`
	BuildingID      string  `json:"building_id,omitempty"`
	ExpectedVersion uint64  `json:"expected_version,omitempty"`
	ExpectedTerm    uint64  `json:"expected_term,omitempty"`
	Policy          string  `json:"policy,omitempty"`
	OccurredAt      string  `json:"occurred_at"`
}
type RecordedResult struct {
	Hash   string `json:"hash"`
	Result Result `json:"result"`
}
type State struct {
	Initialized          bool                      `json:"initialized"`
	UninitializedHistory bool                      `json:"uninitialized_history,omitempty"`
	Capacity             int                       `json:"capacity_amps"`
	Leases               map[string]Lease          `json:"leases"`
	Results              map[string]RecordedResult `json:"results"`
	Events               []Event                   `json:"events"`
	EventCounter         uint64                    `json:"event_counter"`
	// FairShare selects the admission policy and PolicyConfigured records that a committed set_policy chose it.
	// Both change only through the log, so every replica and every replay switches at the same entry.
	FairShare        bool            `json:"fair_share"`
	PolicyConfigured bool            `json:"policy_configured"`
	Wants            map[string]Want `json:"wants"`
}
type FSM struct {
	mu    sync.RWMutex
	state State
}

// New has no node-local capacity input. The first committed init_capacity
// command establishes the capacity for every replica and all future replays.
func New() *FSM {
	return &FSM{state: State{Leases: map[string]Lease{}, Results: map[string]RecordedResult{}, Events: []Event{}, Wants: map[string]Want{}}}
}
func (f *FSM) View() State {
	f.mu.RLock()
	defer f.mu.RUnlock()
	start := len(f.state.Events) - 100
	if start < 0 {
		start = 0
	}
	s := State{Initialized: f.state.Initialized, UninitializedHistory: f.state.UninitializedHistory, Capacity: f.state.Capacity, EventCounter: f.state.EventCounter, FairShare: f.state.FairShare, PolicyConfigured: f.state.PolicyConfigured, Leases: make(map[string]Lease, len(f.state.Leases)), Wants: make(map[string]Want, len(f.state.Wants)), Events: append([]Event{}, f.state.Events[start:]...)}
	for key, l := range f.state.Leases {
		l.Tiers = append([]Tier(nil), l.Tiers...)
		s.Leases[key] = l
	}
	for key, w := range f.state.Wants {
		s.Wants[key] = w
	}
	return s
}
func (f *FSM) EventsAfter(cursor uint64, limit int) []Event {
	f.mu.RLock()
	defer f.mu.RUnlock()
	start := sort.Search(len(f.state.Events), func(i int) bool { return f.state.Events[i].EventID > cursor })
	end := start + limit
	if end > len(f.state.Events) {
		end = len(f.state.Events)
	}
	return append([]Event{}, f.state.Events[start:end]...)
}
func Hash(r Request) string {
	b, _ := json.Marshal(r)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
func Granted(s State) int {
	n := 0
	for _, l := range s.Leases {
		n += l.Amps
	}
	return n
}

// FairShares is the integer max-min fair allocation of s.Capacity over s.Wants (each want clamped to Capacity).
// Buildings are taken in ascending (want, building id) order; one whose want fits the equal share of what
// remains gets its full want, and from the first one that does not, every remaining building gets that equal
// share, the leftover amps going one each to the first of them in the same order. Pure and independent of map
// iteration order, so every replica computes the same shares. Shares only cap grants; they reserve nothing.
func FairShares(s State) map[string]int {
	wants := make([]Want, 0, len(s.Wants))
	for _, w := range s.Wants {
		w.Amps = min(w.Amps, s.Capacity)
		wants = append(wants, w)
	}
	sort.Slice(wants, func(i, j int) bool {
		if wants[i].Amps != wants[j].Amps {
			return wants[i].Amps < wants[j].Amps
		}
		return wants[i].BuildingID < wants[j].BuildingID
	})
	shares := make(map[string]int, len(wants))
	rem := max(s.Capacity, 0)
	for i, w := range wants {
		n := len(wants) - i
		if share := rem / n; w.Amps <= share {
			shares[w.BuildingID] = w.Amps
			rem -= w.Amps
			continue
		}
		share, extra := rem/n, rem%n
		for _, o := range wants[i:] {
			shares[o.BuildingID] = share
			if extra > 0 {
				shares[o.BuildingID]++
				extra--
			}
		}
		break
	}
	return shares
}
func SortedLeases(s State) []Lease {
	a := make([]Lease, 0, len(s.Leases))
	for _, l := range s.Leases {
		a = append(a, l)
	}
	sort.Slice(a, func(i, j int) bool { return a[i].BuildingID < a[j].BuildingID })
	return a
}
func SortedWants(s State) []Want {
	a := make([]Want, 0, len(s.Wants))
	for _, w := range s.Wants {
		a = append(a, w)
	}
	sort.Slice(a, func(i, j int) bool { return a[i].BuildingID < a[j].BuildingID })
	return a
}
func (f *FSM) Apply(log *raft.Log) interface{} {
	var c Command
	if err := json.Unmarshal(log.Data, &c); err != nil {
		return Result{Reason: "invalid_command"}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if c.Kind == "init_capacity" {
		if f.state.UninitializedHistory {
			return Result{Reason: "legacy_log_requires_reset"}
		}
		if c.Capacity <= 0 || c.Capacity > 1000000 {
			return Result{Reason: "invalid_capacity"}
		}
		if f.state.Initialized {
			if f.state.Capacity != c.Capacity {
				return Result{Reason: "capacity_already_initialized"}
			}
			return Result{Accepted: true, Reason: "capacity_initialized"}
		}
		f.state.Capacity = c.Capacity
		f.state.Initialized = true
		return Result{Accepted: true, Reason: "capacity_initialized"}
	}
	if c.Kind == "set_policy" {
		// The admission policy changes only here, at a committed log index, so every replica and every replay
		// decides each grant under the same policy. It is never derived from node-local configuration.
		if c.Policy != "fair_share" && c.Policy != "first_come" {
			return Result{Reason: "invalid_policy"}
		}
		f.state.FairShare, f.state.PolicyConfigured = c.Policy == "fair_share", true
		return Result{Accepted: true, Reason: "policy_set"}
	}
	if c.Kind == "expire_want" {
		// Fenced exactly like expire: only the version the proposing leader's hold was set for, in its own term.
		// Dropping a want only changes future caps; it never touches a reservation.
		if w, ok := f.state.Wants[c.BuildingID]; ok && w.Version == c.ExpectedVersion && log.Term == c.ExpectedTerm {
			delete(f.state.Wants, c.BuildingID)
		}
		return Result{Accepted: true, Reason: "want_expired"}
	}
	if (c.Kind == "grant" || c.Kind == "expire") && !f.state.Initialized {
		// Old pre-initialization logs cannot be safely reinterpreted. Refuse to
		// allocate after such replay; reset all prototype data while gateways stop.
		f.state.UninitializedHistory = true
		return Result{RequestID: c.Request.RequestID, Reason: "capacity_uninitialized"}
	}
	if c.Kind == "expire" {
		// Expiring a tier also drops every older tier: a newer grant never expires earlier.
		l, ok := f.state.Leases[c.BuildingID]
		if ok && log.Term == c.ExpectedTerm && l.HasTier(c.ExpectedVersion) {
			kept := make([]Tier, 0, len(l.Tiers))
			for _, t := range l.Tiers {
				if t.Version > c.ExpectedVersion {
					kept = append(kept, t)
				}
			}
			if len(kept) == 0 {
				delete(f.state.Leases, c.BuildingID)
				f.event("reclaimed", "", l, c.OccurredAt)
			} else {
				shrunk := l
				shrunk.Tiers, shrunk.Amps = kept, kept[0].Amps
				f.state.Leases[c.BuildingID] = shrunk
				if shrunk.Amps < l.Amps {
					f.event("shrunk", "", shrunk, c.OccurredAt)
				}
			}
		}
		return Result{Accepted: true, Reason: "expiry_applied"}
	}
	if c.Kind != "grant" {
		return Result{Reason: "invalid_command"}
	}
	r := c.Request
	hash := Hash(r)
	if prev, ok := f.state.Results[r.RequestID]; ok {
		if prev.Hash != hash {
			return Result{RequestID: r.RequestID, Reason: "request_id_conflict"}
		}
		return prev.Result
	}
	result := Result{RequestID: r.RequestID}
	current, exists := f.state.Leases[r.BuildingID]
	fair := f.state.FairShare
	switch {
	// Under fair_share a request above the whole capacity is not malformed: it is clamped below.
	case r.RequestID == "" || r.BuildingID == "" || r.SessionID == "" || len(r.RequestID) > 128 || len(r.BuildingID) > 128 || len(r.SessionID) > 128 || r.Amps <= 0 || (!fair && r.Amps > f.state.Capacity):
		result.Reason = "invalid_request"
	case exists && current.SessionID != r.SessionID:
		result.Reason = "building_session_active"
	default:
		// Every processed request, accepted or not, records the building's want under both policies (so that
		// switching the policy on has data). It only caps later grants; it reserves nothing.
		// The number of distinct buildings with a want is bounded: building ids are not authenticated, so an unbounded set
		// would let invented ids grow state and dilute every real building's share. A building already in the set can
		// always refresh its want; a newcomer beyond the bound displaces the oldest want of a building holding no lease
		// (see admitWant); when none can be displaced it has no want, so under fair_share its share is 0 and it is refused.
		if f.admitWant(r.BuildingID) {
			f.state.Wants[r.BuildingID] = Want{BuildingID: r.BuildingID, Amps: min(r.Amps, f.state.Capacity), Version: log.Index}
		}
		// amps is what this grant authorizes: the request itself, or under fair_share at most the building's
		// max-min share, and then only as much growth as the free capacity holds.
		amps := r.Amps
		if fair {
			amps = min(f.state.Wants[r.BuildingID].Amps, FairShares(f.state)[r.BuildingID])
			if amps > current.Amps {
				amps = current.Amps + min(amps-current.Amps, f.state.Capacity-Granted(f.state))
			}
		}
		// The reservation only grows here; it shrinks when an older tier expires. delta is the growth.
		delta := 0
		if amps > current.Amps {
			delta = amps - current.Amps // current.Amps is 0 without a lease
		}
		// Subtraction avoids integer overflow for arbitrary JSON integers.
		if amps <= 0 || delta > f.state.Capacity-Granted(f.state) {
			result.Reason = "capacity_exhausted"
		} else {
			// A newer tier with at least the same amps expires no earlier, so it dominates older ones.
			tiers := make([]Tier, 0, len(current.Tiers)+1)
			for _, t := range current.TierList() {
				if t.Amps > amps {
					tiers = append(tiers, t)
				}
			}
			tiers = append(tiers, Tier{Version: log.Index, Amps: amps})
			f.state.Leases[r.BuildingID] = Lease{BuildingID: r.BuildingID, SessionID: r.SessionID, Amps: tiers[0].Amps, Version: log.Index, Tiers: tiers}
			// The gateway receives only this grant's own authorization, never the reserved maximum.
			own := Lease{BuildingID: r.BuildingID, SessionID: r.SessionID, Amps: amps, Version: log.Index}
			result.Accepted = true
			result.Reason = "granted"
			if amps != r.Amps {
				result.Reason = "granted_partial"
			}
			result.Lease = &own
			f.event("granted", r.RequestID, own, c.OccurredAt)
		}
	}
	f.state.Results[r.RequestID] = RecordedResult{Hash: hash, Result: result}
	return result
}

// TierList returns the lease's tiers; a lease without any (legacy state) is one tier of its own amps and version.
func (l Lease) TierList() []Tier {
	if len(l.Tiers) == 0 {
		return []Tier{{Version: l.Version, Amps: l.Amps}}
	}
	return l.Tiers
}

// HasTier reports whether version is the version of one of the lease's tiers.
func (l Lease) HasTier(version uint64) bool {
	for _, t := range l.TierList() {
		if t.Version == version {
			return true
		}
	}
	return false
}

// admitWant reports whether building b may record a want, making room by eviction when the set is full. A known
// building always refreshes, and a building that holds a lease is admitted up to MaxWantsHard.
// Otherwise the oldest want of a building holding no lease is evicted (lowest log index, then lowest id; the choice
// is deterministic), so a flood of invented ids can only displace other lease-less wants, never a building that is
// being served. When every want belongs to a leaseholder the newcomer is refused.
func (f *FSM) admitWant(b string) bool {
	if _, known := f.state.Wants[b]; known || len(f.state.Wants) < MaxWants {
		return true
	}
	if _, holds := f.state.Leases[b]; holds {
		return len(f.state.Wants) < MaxWantsHard
	}
	victim, version, found := "", uint64(0), false
	for id, w := range f.state.Wants {
		if _, holds := f.state.Leases[id]; holds {
			continue
		}
		if !found || w.Version < version || (w.Version == version && id < victim) {
			victim, version, found = id, w.Version, true
		}
	}
	if !found {
		return false
	}
	delete(f.state.Wants, victim)
	return true
}
func (f *FSM) event(kind, request string, l Lease, at string) {
	f.state.EventCounter++
	f.state.Events = append(f.state.Events, Event{EventID: f.state.EventCounter, Kind: kind, RequestID: request, BuildingID: l.BuildingID, SessionID: l.SessionID, Amps: l.Amps, Version: l.Version, OccurredAt: at})
}

type snapshot struct{ data []byte }

func (f *FSM) Snapshot() (raft.FSMSnapshot, error) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	b, err := json.Marshal(f.state)
	return &snapshot{b}, err
}
func (s *snapshot) Persist(sink raft.SnapshotSink) error {
	if _, err := sink.Write(s.data); err != nil {
		_ = sink.Cancel()
		return err
	}
	return sink.Close()
}
func (s *snapshot) Release() {}
func (f *FSM) Restore(r io.ReadCloser) error {
	defer r.Close()
	var s State
	if err := json.NewDecoder(r).Decode(&s); err != nil {
		return err
	}
	if s.Leases == nil || s.Results == nil || (s.Initialized && (s.Capacity <= 0 || s.Capacity > 1000000)) || (!s.Initialized && (s.Capacity != 0 || len(s.Leases) != 0 || len(s.Results) != 0 || len(s.Events) != 0)) {
		return errors.New("invalid ledger snapshot")
	}
	total := 0
	for key, l := range s.Leases {
		if l.BuildingID != key || l.Amps <= 0 || l.Amps > s.Capacity-total {
			return errors.New("snapshot violates capacity")
		}
		total += l.Amps
		// Snapshots written before tiers existed carry one implicit tier.
		l.Tiers = append([]Tier(nil), l.TierList()...)
		if err := validTiers(l); err != nil {
			return err
		}
		s.Leases[key] = l
	}
	// Snapshots written before fair sharing have no wants and no policy (first_come, unconfigured).
	if s.Wants == nil {
		s.Wants = map[string]Want{}
	}
	for key, w := range s.Wants {
		if w.BuildingID != key || w.Amps <= 0 || w.Amps > s.Capacity {
			return errors.New("snapshot has malformed wants")
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.state = s
	return nil
}

// validTiers checks the stored-lease invariants: ascending versions, strictly decreasing amps, and a lease
// that mirrors its tiers (reserved = largest tier, version = newest tier).
func validTiers(l Lease) error {
	for i, t := range l.Tiers {
		if t.Amps <= 0 || (i > 0 && (t.Version <= l.Tiers[i-1].Version || t.Amps >= l.Tiers[i-1].Amps)) {
			return errors.New("snapshot has malformed lease tiers")
		}
	}
	if l.Amps != l.Tiers[0].Amps || l.Version != l.Tiers[len(l.Tiers)-1].Version {
		return errors.New("snapshot lease does not match its tiers")
	}
	return nil
}

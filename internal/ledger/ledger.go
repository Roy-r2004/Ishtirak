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
type Lease struct {
	BuildingID string `json:"building_id"`
	SessionID  string `json:"session_id"`
	Amps       int    `json:"amps"`
	Version    uint64 `json:"version"`
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
type Command struct {
	Kind            string  `json:"kind"`
	Capacity        int     `json:"capacity_amps,omitempty"`
	Request         Request `json:"request,omitempty"`
	BuildingID      string  `json:"building_id,omitempty"`
	ExpectedVersion uint64  `json:"expected_version,omitempty"`
	ExpectedTerm    uint64  `json:"expected_term,omitempty"`
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
}
type FSM struct {
	mu    sync.RWMutex
	state State
}

// New has no node-local capacity input. The first committed init_capacity
// command establishes the capacity for every replica and all future replays.
func New() *FSM {
	return &FSM{state: State{Leases: map[string]Lease{}, Results: map[string]RecordedResult{}, Events: []Event{}}}
}
func (f *FSM) View() State {
	f.mu.RLock()
	defer f.mu.RUnlock()
	start := len(f.state.Events) - 100
	if start < 0 {
		start = 0
	}
	s := State{Initialized: f.state.Initialized, UninitializedHistory: f.state.UninitializedHistory, Capacity: f.state.Capacity, EventCounter: f.state.EventCounter, Leases: make(map[string]Lease, len(f.state.Leases)), Events: append([]Event{}, f.state.Events[start:]...)}
	for key, l := range f.state.Leases {
		s.Leases[key] = l
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
func SortedLeases(s State) []Lease {
	a := make([]Lease, 0, len(s.Leases))
	for _, l := range s.Leases {
		a = append(a, l)
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
	if (c.Kind == "grant" || c.Kind == "expire") && !f.state.Initialized {
		// Old pre-initialization logs cannot be safely reinterpreted. Refuse to
		// allocate after such replay; reset all prototype data while gateways stop.
		f.state.UninitializedHistory = true
		return Result{RequestID: c.Request.RequestID, Reason: "capacity_uninitialized"}
	}
	if c.Kind == "expire" {
		l, ok := f.state.Leases[c.BuildingID]
		if ok && l.Version == c.ExpectedVersion && log.Term == c.ExpectedTerm {
			delete(f.state.Leases, c.BuildingID)
			f.event("reclaimed", "", l, c.OccurredAt)
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
	switch {
	case r.RequestID == "" || r.BuildingID == "" || r.SessionID == "" || len(r.RequestID) > 128 || len(r.BuildingID) > 128 || len(r.SessionID) > 128 || r.Amps <= 0 || r.Amps > f.state.Capacity:
		result.Reason = "invalid_request"
	case exists && current.SessionID != r.SessionID:
		result.Reason = "building_session_active"
	default:
		amps := r.Amps
		if exists && current.Amps > amps {
			amps = current.Amps
		}
		delta := amps
		if exists {
			delta -= current.Amps
		}
		// Subtraction avoids integer overflow for arbitrary JSON integers.
		if delta > f.state.Capacity-Granted(f.state) {
			result.Reason = "capacity_exhausted"
		} else {
			lease := Lease{BuildingID: r.BuildingID, SessionID: r.SessionID, Amps: amps, Version: log.Index}
			f.state.Leases[r.BuildingID] = lease
			result.Accepted = true
			result.Reason = "granted"
			result.Lease = &lease
			f.event("granted", r.RequestID, lease, c.OccurredAt)
		}
	}
	f.state.Results[r.RequestID] = RecordedResult{Hash: hash, Result: result}
	return result
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
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.state = s
	return nil
}

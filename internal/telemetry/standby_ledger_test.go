package telemetry

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hashicorp/raft"
	"ishtirak/internal/coordinator"
	"ishtirak/internal/ledger"
)

// Active/standby gateway pair against the REAL ledger state machine and the REAL coordinator Deadlines, on a fake
// clock. The coordinator HTTP layer is replaced by a handler that does what Server.grant and Server.expirations do:
// apply a grant command, observe the committed leases (which starts each tier's 12 s hold), and propose the expiry
// of every tier whose hold has passed. Gateways are the real Gateway code (real HTTP to that handler, fake clock).

type simClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *simClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}
func (c *simClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// simGrant is the model of one accepted grant, kept on the coordinator side: the gateway may use it until its own
// deadline, the time the request was sent (the fake clock does not move during a call) plus the lease minus the margin.
type simGrant struct {
	session  string
	amps     int
	sent     time.Time
	deadline time.Time
}

type simCoordinator struct {
	t      *testing.T
	clk    *simClock
	mu     sync.Mutex
	fsm    *ledger.FSM
	dl     *coordinator.Deadlines
	idx    uint64
	term   uint64
	server *httptest.Server

	grants   []simGrant
	requests map[string][]time.Time // session -> time of every grant request that reached the ledger
	refusals map[string]int         // session -> building_session_active refusals
	reasons  map[string]int         // every ledger reason, for the log
	readings map[string]int         // reading id -> times received
}

const simCapacity = 120

func newSimCoordinator(t *testing.T, clk *simClock) *simCoordinator {
	t.Helper()
	c := &simCoordinator{t: t, clk: clk, fsm: ledger.New(), dl: coordinator.NewDeadlines(12 * time.Second), term: 1,
		requests: map[string][]time.Time{}, refusals: map[string]int{}, reasons: map[string]int{}, readings: map[string]int{}}
	c.apply(ledger.Command{Kind: "init_capacity", Capacity: simCapacity})
	c.apply(ledger.Command{Kind: "set_policy", Policy: "fair_share"}) // the compose stack runs fair sharing
	c.observe()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/grants", c.grant)
	mux.HandleFunc("POST /api/readings", c.postReadings)
	c.server = httptest.NewServer(mux)
	t.Cleanup(c.server.Close)
	return c
}

// apply and observe must be called with c.mu held (newSimCoordinator is single-threaded).
func (c *simCoordinator) apply(cmd ledger.Command) ledger.Result {
	cmd.OccurredAt = c.clk.Now().UTC().Format(time.RFC3339Nano)
	b, err := json.Marshal(cmd)
	if err != nil {
		c.t.Fatal(err)
	}
	c.idx++
	return c.fsm.Apply(&raft.Log{Index: c.idx, Term: c.term, Data: b}).(ledger.Result)
}
func (c *simCoordinator) observe() {
	v := c.fsm.View()
	c.dl.Observe(strconv.FormatUint(c.term, 10), true, v.Leases, v.Wants, c.clk.Now())
}

func (c *simCoordinator) grant(w http.ResponseWriter, r *http.Request) {
	var req ledger.Request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Amps <= 0 {
		http.Error(w, "invalid grant request", http.StatusBadRequest) // as Server.grant does
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.clk.Now()
	c.observe()
	res := c.apply(ledger.Command{Kind: "grant", Request: req})
	c.observe()
	c.requests[req.SessionID] = append(c.requests[req.SessionID], now)
	c.reasons[res.Reason]++
	if res.Accepted {
		c.grants = append(c.grants, simGrant{req.SessionID, res.Lease.Amps, now, now.Add(LeaseTTL - 2*time.Second)})
	} else if res.Reason == ReasonSessionActive {
		c.refusals[req.SessionID]++
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		ledger.Result
		LeaseMS int64 `json:"lease_ms"`
	}{res, LeaseTTL.Milliseconds()})
}

func (c *simCoordinator) postReadings(w http.ResponseWriter, r *http.Request) {
	var batch struct {
		Readings []Reading `json:"readings"`
	}
	if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
		http.Error(w, "bad batch", http.StatusBadRequest)
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, rd := range batch.Readings {
		c.readings[rd.ReadingID]++
	}
	w.WriteHeader(http.StatusNoContent)
}

// expireDue is the body of Server.expirations: propose the expiry of every tier (and want) whose hold has passed.
func (c *simCoordinator) expireDue() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.observe()
	now := c.clk.Now()
	due := c.dl.Due(now)
	ids := make([]string, 0, len(due))
	for id := range due {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if l, ok := c.fsm.View().Leases[id]; !ok || !l.HasTier(due[id]) {
			continue
		}
		c.apply(ledger.Command{Kind: "expire", BuildingID: id, ExpectedVersion: due[id], ExpectedTerm: c.term})
		c.observe()
	}
	dueWants := c.dl.DueWants(now)
	ids = ids[:0]
	for id := range dueWants {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if w, ok := c.fsm.View().Wants[id]; !ok || w.Version != dueWants[id] {
			continue
		}
		c.apply(ledger.Command{Kind: "expire_want", BuildingID: id, ExpectedVersion: dueWants[id], ExpectedTerm: c.term})
		c.observe()
	}
}

func (c *simCoordinator) view() ledger.State {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.fsm.View()
}

// usable is what the model says a session's gateway may use at now: the largest accepted grant still before its deadline.
func (c *simCoordinator) usable(session string, now time.Time) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	m := 0
	for _, g := range c.grants {
		if g.session == session && g.deadline.After(now) && g.amps > m {
			m = g.amps
		}
	}
	return m
}

// grantsOf returns the accepted grants of a session in order.
func (c *simCoordinator) grantsOf(session string) []simGrant {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []simGrant
	for _, g := range c.grants {
		if g.session == session {
			out = append(out, g)
		}
	}
	return out
}

func (c *simCoordinator) refusalCount(session string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.refusals[session]
}

// summary is the ledger reasons seen so far, for the log.
func (c *simCoordinator) summary() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return fmt.Sprint(c.reasons)
}

// readingCounts is a copy of how many times each reading id reached the coordinator.
func (c *simCoordinator) readingCounts() map[string]int {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[string]int, len(c.readings))
	for id, n := range c.readings {
		out[id] = n
	}
	return out
}

func (c *simCoordinator) requestCount(session string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.requests[session])
}

type simGW struct {
	name   string
	g      *Gateway
	meters int
	alive  bool
}

type simWorld struct {
	t       *testing.T
	clk     *simClock
	start   time.Time
	co      *simCoordinator
	gws     []*simGW
	second  int
	holders []string // sessions that held the hamra lease, in order
	maxRes  int      // highest total reserved amps seen
}

func newSimWorld(t *testing.T) *simWorld {
	clk := &simClock{t: time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)}
	return &simWorld{t: t, clk: clk, start: clk.Now(), co: newSimCoordinator(t, clk)}
}

func (w *simWorld) add(name, building string, meters int) *simGW {
	g, err := NewGateway(GatewayConfig{BuildingID: building, Name: name, Coordinators: []string{w.co.server.URL}, SafetyMargin: 2 * time.Second})
	if err != nil {
		w.t.Fatal(err)
	}
	g.now = w.clk.Now
	sg := &simGW{name: name, g: g, meters: meters, alive: true}
	w.gws = append(w.gws, sg)
	return sg
}

func (w *simWorld) at() string { return fmt.Sprintf("t=%.1fs", w.clk.Now().Sub(w.start).Seconds()) }

// step advances 200 ms (the coordinator's expiry tick), runs the expiry loop and checks the invariants.
func (w *simWorld) step() {
	w.clk.Advance(200 * time.Millisecond)
	w.co.expireDue()
	w.check()
}

// tick is one second of the system: four idle steps, then a fifth in which every live gateway receives its building's
// readings (every gateway of a building gets the same ones, as with MQTT) and runs one renewal, as Gateway.Run does.
func (w *simWorld) tick() {
	for i := 0; i < 4; i++ {
		w.step()
	}
	w.clk.Advance(200 * time.Millisecond)
	w.co.expireDue()
	w.second++
	for _, sg := range w.gws {
		if !sg.alive {
			continue
		}
		for m := 0; m < sg.meters; m++ {
			id := fmt.Sprintf("%s-m%d-t%d", sg.g.cfg.BuildingID, m, w.second)
			sg.g.Ingest(Reading{id, sg.g.cfg.BuildingID, fmt.Sprint("meter-", m), 10, w.clk.Now()})
		}
		_ = sg.g.Renew(w.t.Context())
	}
	w.check()
}

func (w *simWorld) run(seconds int) {
	for i := 0; i < seconds; i++ {
		w.tick()
	}
}

// runUntil ticks until cond holds, failing after limit seconds.
func (w *simWorld) runUntil(limit int, what string, cond func() bool) {
	w.t.Helper()
	for i := 0; i < limit; i++ {
		if cond() {
			return
		}
		w.tick()
	}
	if !cond() {
		w.t.Fatalf("%s: not reached within %d s (%s)", what, limit, w.at())
	}
}

// check holds after every 200 ms step and every gateway action.
func (w *simWorld) check() {
	w.t.Helper()
	view := w.co.view()
	now := w.clk.Now()
	reserved := ledger.Granted(view)
	w.maxRes = max(w.maxRes, reserved)
	if reserved > simCapacity {
		w.t.Fatalf("%s: reserved %d A exceeds the %d A capacity", w.at(), reserved, simCapacity)
	}
	if h := view.Leases["hamra"].SessionID; h != "" && (len(w.holders) == 0 || w.holders[len(w.holders)-1] != h) {
		w.holders = append(w.holders, h)
	}
	usableSum := 0
	for _, sg := range w.gws {
		s := sg.g.Status()
		b := sg.g.cfg.BuildingID
		usableSum += s.GrantedAmps
		// Nothing is usable beyond the gateway's own grant deadline, and nothing the model does not allow.
		if model := w.co.usable(sg.g.session, now); s.GrantedAmps != model {
			w.t.Fatalf("%s: %s usable %d A but its grants (request time + 10 s) allow %d A", w.at(), sg.name, s.GrantedAmps, model)
		}
		if s.ServedAmps > float64(s.GrantedAmps) {
			w.t.Fatalf("%s: %s serves %.0f A above its %d A grant", w.at(), sg.name, s.ServedAmps, s.GrantedAmps)
		}
		// A gateway uses amps only while the ledger still reserves them for ITS session.
		if s.GrantedAmps > 0 {
			l, ok := view.Leases[b]
			if !ok || l.SessionID != sg.g.session || s.GrantedAmps > l.Amps {
				w.t.Fatalf("%s: %s uses %d A but the ledger holds %+v for %s", w.at(), sg.name, s.GrantedAmps, l, b)
			}
		}
		if (s.Role == RoleServing) != (s.GrantedAmps > 0) {
			w.t.Fatalf("%s: %s role %q with %d A granted (state %s)", w.at(), sg.name, s.Role, s.GrantedAmps, s.State)
		}
	}
	if usableSum > simCapacity {
		w.t.Fatalf("%s: gateways may use %d A together, capacity %d A", w.at(), usableSum, simCapacity)
	}
}

func (w *simWorld) sessionHoldsHamra(sg *simGW) bool {
	return w.co.view().Leases["hamra"].SessionID == sg.g.session
}

// lastGrant is the time of the session's last accepted grant, i.e. its last renewal that reached the ledger.
func (w *simWorld) lastGrant(sg *simGW) simGrant {
	gs := w.co.grantsOf(sg.g.session)
	if len(gs) == 0 {
		w.t.Fatalf("%s never held a grant", sg.name)
	}
	return gs[len(gs)-1]
}

func TestActiveStandbyPairAgainstTheRealLedger(t *testing.T) {
	w := newSimWorld(t)
	// Demand: hamra 60 A (its fair share is 40 A: limited), mar_mikhael and achrafieh 40 A each. Reserved reaches 120 A.
	primary := w.add("hamra-primary", "hamra", 6)
	standby := w.add("hamra-standby", "hamra", 6)
	w.add("mar-mikhael", "mar_mikhael", 4)
	w.add("achrafieh", "achrafieh", 4)

	// 1. While the primary renews, the standby is refused, never serves, and asks no more often than every 2 s.
	w.run(25)
	if s := primary.g.Status(); s.Role != RoleServing || s.GrantedAmps != 40 || s.ServedAmps != 40 || s.State != "limited" {
		t.Fatalf("primary: %+v", s)
	}
	if s := standby.g.Status(); s.Role != RoleStandby || s.GrantedAmps != 0 || s.ServedAmps != 0 || s.State != "waiting" || s.LastError != "grant refused: building_session_active" {
		t.Fatalf("standby: %+v", s)
	}
	if grants := w.co.grantsOf(standby.g.session); len(grants) != 0 {
		t.Fatalf("the standby was granted while the primary held the building: %+v", grants)
	}
	if n := w.co.requestCount(standby.g.session); n < 11 || n > 13 {
		t.Fatalf("standby sent %d requests in 25 s, want one per 2 s (11-13)", n)
	}
	if n := w.co.requestCount(primary.g.session); n < 8 {
		t.Fatalf("primary sent only %d requests in 25 s, it must keep renewing", n)
	}
	if w.co.refusalCount(standby.g.session) != w.co.requestCount(standby.g.session) {
		t.Fatalf("every standby request must be a session_active refusal: %s", w.co.summary())
	}
	// Both gateways have current data and their own copy of the unflushed readings; flushing both writes every reading
	// twice (same ids, so PostgreSQL's ON CONFLICT DO NOTHING keeps one row; that SQL path is not exercised here).
	ps, ss := primary.g.Status(), standby.g.Status()
	if ps.DemandAmps != 60 || ss.DemandAmps != 60 || ps.PendingReadings != 150 || ss.PendingReadings != 150 {
		t.Fatalf("standby lacks the primary's data: primary %+v standby %+v", ps, ss)
	}
	for _, sg := range []*simGW{primary, standby} {
		if err := sg.g.Flush(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	hamraReadings := 0
	for id, n := range w.co.readingCounts() {
		if strings.HasPrefix(id, "hamra-") {
			hamraReadings++
			if n != 2 {
				t.Fatalf("reading %s received %d times, want 2 (primary and standby)", id, n)
			}
		}
	}
	if hamraReadings != 150 {
		t.Fatalf("%d distinct hamra readings reached the coordinator, want 150", hamraReadings)
	}

	// 2. The primary stops renewing (crashed or cut off). The standby is refused until the ledger commits the expiry of
	// the primary's last tier, 12 s after its last renewal; its next request after that is accepted.
	last := w.lastGrant(primary)
	primary.alive = false
	w.runUntil(40, "standby takes the building", func() bool { return standby.g.Status().Role == RoleServing })
	first := w.co.grantsOf(standby.g.session)[0]
	if gap := first.sent.Sub(last.sent); gap < LeaseTTL || gap > LeaseTTL+StandbyRetry {
		t.Fatalf("takeover %s after the primary's last renewal, want between %s (committed expiry) and %s", gap, LeaseTTL, LeaseTTL+StandbyRetry)
	}
	if !last.deadline.Before(first.sent) {
		t.Fatalf("the primary's last grant (until %s) must have lapsed before the standby's request at %s", last.deadline, first.sent)
	}
	if s := standby.g.Status(); s.Role != RoleServing || s.GrantedAmps != 40 || s.ServedAmps != 40 || !w.sessionHoldsHamra(standby) {
		t.Fatalf("standby after takeover: %+v", s)
	}
	if s := primary.g.Status(); s.GrantedAmps != 0 || s.ServedAmps != 0 || s.State != "expired" {
		t.Fatalf("the silent primary still serves: %+v", s)
	}
	t.Logf("takeover %s after the primary's last renewal (its own grant ended %s after that request)", first.sent.Sub(last.sent), last.deadline.Sub(last.sent))

	// 3. The old primary comes back. First as the same process with the same session (its connection to the
	// coordinators heals): its next request is refused and it does not take the building back. Then, after another
	// crash, as a restarted process with a new session: refused as well, while the standby, now serving, keeps renewing.
	w.run(10)
	grantsBefore, requestsBefore := len(w.co.grantsOf(primary.g.session)), w.co.requestCount(primary.g.session)
	primary.alive = true
	w.run(10)
	if s := primary.g.Status(); s.Role != RoleStandby || s.GrantedAmps != 0 || s.ServedAmps != 0 || s.LastError != "grant refused: building_session_active" {
		t.Fatalf("healed primary: %+v", s)
	}
	if n := len(w.co.grantsOf(primary.g.session)); n != grantsBefore {
		t.Fatalf("the healed primary was granted %d new times while the standby held the building", n-grantsBefore)
	}
	if n := w.co.requestCount(primary.g.session) - requestsBefore; n < 4 || n > 6 {
		t.Fatalf("healed primary sent %d requests in 10 s, want one per 2 s (4-6)", n)
	}
	primary.alive = false
	restarted := w.add("hamra-primary-restarted", "hamra", 6)
	w.run(40)
	if s := restarted.g.Status(); s.Role != RoleStandby || s.GrantedAmps != 0 || s.ServedAmps != 0 || s.SessionID == primary.g.session {
		t.Fatalf("restarted primary: %+v", s)
	}
	if s := standby.g.Status(); s.Role != RoleServing || s.GrantedAmps != 40 || !w.sessionHoldsHamra(standby) {
		t.Fatalf("the serving gateway lost the building to the restarted one: %+v", s)
	}
	if grants := w.co.grantsOf(restarted.g.session); len(grants) != 0 {
		t.Fatalf("the restarted primary was granted while the other gateway held the building: %+v", grants)
	}
	if n := w.co.requestCount(restarted.g.session); n < 18 || n > 21 {
		t.Fatalf("restarted primary sent %d requests in 40 s, want one per 2 s (18-21)", n)
	}

	// 4. Roles are symmetric: when the serving gateway stops renewing, the restarted one takes over, again only after
	// the committed expiry.
	last = w.lastGrant(standby)
	standby.alive = false
	w.runUntil(40, "restarted gateway takes the building", func() bool { return restarted.g.Status().Role == RoleServing })
	first = w.co.grantsOf(restarted.g.session)[0]
	if gap := first.sent.Sub(last.sent); gap < LeaseTTL || gap > LeaseTTL+StandbyRetry {
		t.Fatalf("second takeover %s after the last renewal, want between %s and %s", gap, LeaseTTL, LeaseTTL+StandbyRetry)
	}

	// 5. Both gateways down: the lease is reclaimed and nobody in hamra serves (a crash of both is not covered).
	restarted.alive = false
	w.run(30)
	if l, held := w.co.view().Leases["hamra"]; held {
		t.Fatalf("hamra's lease was not reclaimed: %+v", l)
	}
	if s := restarted.g.Status(); s.GrantedAmps != 0 || s.ServedAmps != 0 {
		t.Fatalf("a dead gateway still serves: %+v", s)
	}

	if want := []string{primary.g.session, standby.g.session, restarted.g.session}; fmt.Sprint(w.holders) != fmt.Sprint(want) {
		t.Fatalf("hamra lease holders over the run %v, want %v", w.holders, want)
	}
	if w.maxRes != simCapacity {
		t.Fatalf("the run never filled the capacity (max reserved %d A), so the capacity bound was not exercised", w.maxRes)
	}
	t.Logf("ledger reasons over the run: %s; max reserved %d A of %d", w.co.summary(), w.maxRes, simCapacity)
}

// When the neighbours want more than their fair share, the amps freed by the failed gateway can be taken by them before
// the standby asks. The standby is then admitted like any request under fair sharing; the safety invariants hold
// throughout and the standby is served eventually.
func TestStandbyTakeoverWhenNeighboursWantMoreThanTheirShare(t *testing.T) {
	w := newSimWorld(t)
	primary := w.add("hamra-primary", "hamra", 6) // 60 A
	standby := w.add("hamra-standby", "hamra", 6)
	w.add("mar-mikhael", "mar_mikhael", 7) // 70 A
	w.add("achrafieh", "achrafieh", 7)     // 70 A
	w.run(20)
	if s := primary.g.Status(); s.Role != RoleServing || w.co.grantsOf(standby.g.session) != nil {
		t.Fatalf("primary %+v", s)
	}
	last := w.lastGrant(primary)
	primary.alive = false
	w.runUntil(60, "standby takes the building", func() bool { return standby.g.Status().Role == RoleServing })
	first := w.co.grantsOf(standby.g.session)[0]
	gap := first.sent.Sub(last.sent)
	if gap < LeaseTTL {
		t.Fatalf("standby served %s after the primary's last renewal, before the committed expiry", gap)
	}
	t.Logf("takeover %s after the primary's last renewal; ledger reasons %s", gap, w.co.summary())
}

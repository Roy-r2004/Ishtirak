package telemetry

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func refusal(g *Gateway, reason string) (GrantRequest, GrantResponse) {
	r := GrantRequest{NewID(), "hamra", g.session, 8}
	return r, GrantResponse{Accepted: false, Reason: reason, RequestID: r.RequestID}
}

func TestRoleValues(t *testing.T) {
	g, now := fixture(t)
	if r := g.Status().Role; r != RoleWaiting {
		t.Fatalf("fresh gateway role %q, want waiting", r)
	}

	// A refusal because another session holds the building makes this gateway the standby; the error text is unchanged.
	req, res := refusal(g, ReasonSessionActive)
	if err := g.ApplyGrant(req, *now, res); err == nil || err.Error() != "grant refused: building_session_active" {
		t.Fatalf("refusal error text changed: %v", err)
	}
	if s := g.Status(); s.Role != RoleStandby || s.State != "waiting" || s.GrantedAmps != 0 || s.ServedAmps != 0 {
		t.Fatalf("after session_active refusal: %+v", s)
	}
	// The standby role lasts for the 8 s window after the refusal, then the gateway is merely waiting.
	*now = now.Add(standbyWindow - time.Millisecond)
	if r := g.Status().Role; r != RoleStandby {
		t.Fatalf("role %q just inside the window, want standby", r)
	}
	*now = now.Add(time.Millisecond)
	if r := g.Status().Role; r != RoleWaiting {
		t.Fatalf("role %q at the end of the window, want waiting", r)
	}

	// Any other refusal is not a standby.
	req, res = refusal(g, "capacity_exhausted")
	_ = g.ApplyGrant(req, *now, res)
	if r := g.Status().Role; r != RoleWaiting {
		t.Fatalf("capacity_exhausted refusal gave role %q, want waiting", r)
	}
	// A later outcome replaces an earlier one: a different refusal after session_active ends the standby role.
	req, res = refusal(g, ReasonSessionActive)
	_ = g.ApplyGrant(req, *now, res)
	req, res = refusal(g, "capacity_exhausted")
	_ = g.ApplyGrant(req, *now, res)
	if r := g.Status().Role; r != RoleWaiting {
		t.Fatalf("role %q after a newer capacity_exhausted refusal, want waiting", r)
	}

	// A live grant makes it serving, whether the demand is covered (active) or not (limited).
	demandOf(g, *now, 1) // 8 A
	req, grantRes := grant(g, 10, 1)
	if err := g.ApplyGrant(req, *now, grantRes); err != nil {
		t.Fatal(err)
	}
	if s := g.Status(); s.Role != RoleServing || s.State != "active" {
		t.Fatalf("covered demand: %+v", s)
	}
	demandOf(g, *now, 3) // 24 A against 10 A granted
	if s := g.Status(); s.Role != RoleServing || s.State != "limited" {
		t.Fatalf("limited: %+v", s)
	}
	// A live local lease outranks a refusal that arrives later: the gateway still serves what it was granted.
	req, res = refusal(g, ReasonSessionActive)
	_ = g.ApplyGrant(req, *now, res)
	if s := g.Status(); s.Role != RoleServing {
		t.Fatalf("a refusal must not hide a live lease: %+v", s)
	}
}

// An accepted grant is the latest outcome and clears an earlier session_active refusal: when a short lease lapses
// well inside the 8 s window the gateway is waiting, not standby.
func TestAcceptedGrantClearsStandby(t *testing.T) {
	g, now := fixture(t)
	req, res := refusal(g, ReasonSessionActive)
	_ = g.ApplyGrant(req, *now, res)
	if r := g.Status().Role; r != RoleStandby {
		t.Fatalf("role %q, want standby", r)
	}
	demandOf(g, *now, 1)
	req, accepted := grant(g, 10, 1)
	accepted.LeaseMS = 3000 // usable for 3 s minus the 2 s safety margin, so 1 s
	if err := g.ApplyGrant(req, *now, accepted); err != nil {
		t.Fatal(err)
	}
	if r := g.Status().Role; r != RoleServing {
		t.Fatalf("role %q, want serving", r)
	}
	*now = now.Add(time.Second)
	demandOf(g, *now, 1)
	if s := g.Status(); s.Role != RoleWaiting || s.State != "expired" {
		t.Fatalf("after the lease lapsed inside the standby window: %+v", s)
	}
}

func TestRoleIsReportedInStatusJSON(t *testing.T) {
	g, now := fixture(t)
	req, res := refusal(g, ReasonSessionActive)
	_ = g.ApplyGrant(req, *now, res)
	server := httptest.NewServer(g.Handler())
	defer server.Close()
	r, err := http.Get(server.URL + "/api/status")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["role"] != "standby" {
		t.Fatalf("status JSON role = %v, want standby (%v)", body["role"], body)
	}
}

// refusingCoordinator answers every grant with a refusal for the given reason and counts the requests.
func refusingCoordinator(t *testing.T, reason string, requests *atomic.Int64) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req GrantRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(GrantResponse{Accepted: false, Reason: reason, RequestID: req.RequestID, LeaseMS: 12000})
	}))
	t.Cleanup(server.Close)
	return server
}

// A refused standby asks again only after StandbyRetry, not on every one-second tick (a refused request still costs a
// Raft entry). Demand is present and nothing is granted, so without the back-off it would ask on every tick.
func TestStandbyBacksOffAfterSessionActiveRefusal(t *testing.T) {
	var requests atomic.Int64
	server := refusingCoordinator(t, ReasonSessionActive, &requests)
	g, now := fixture(t)
	g.cfg.Coordinators = []string{server.URL}
	var sentAt []int
	for second := 0; second < 10; second++ {
		demandOf(g, *now, 2)
		before := requests.Load()
		err := g.Renew(t.Context())
		if sent := requests.Load() - before; sent > 0 {
			sentAt = append(sentAt, second)
			if err == nil || err.Error() != "grant refused: building_session_active" {
				t.Fatalf("second %d: want the refusal error, got %v", second, err)
			}
		} else if err != nil {
			t.Fatalf("second %d: a backed-off tick must not fail: %v", second, err)
		}
		if r := g.Status().Role; r != RoleStandby {
			t.Fatalf("second %d: role %q, want standby", second, r)
		}
		*now = now.Add(time.Second)
	}
	want := []int{0, 2, 4, 6, 8}
	if len(sentAt) != len(want) {
		t.Fatalf("requests sent at seconds %v, want %v", sentAt, want)
	}
	for i := range want {
		if sentAt[i] != want[i] {
			t.Fatalf("requests sent at seconds %v, want %v", sentAt, want)
		}
	}
	if gap := StandbyRetry; gap != 2*time.Second || standbyWindow <= gap {
		t.Fatalf("constants: retry %s window %s", gap, standbyWindow)
	}
}

// Only the session-held refusal backs off. Other refusals keep the existing cadence (one request per tick under
// unmet demand), so a capacity refusal is retried as fast as before.
func TestOtherRefusalsDoNotBackOff(t *testing.T) {
	for _, reason := range []string{"capacity_exhausted", "invalid_request", "request_id_conflict"} {
		t.Run(reason, func(t *testing.T) {
			var requests atomic.Int64
			server := refusingCoordinator(t, reason, &requests)
			g, now := fixture(t)
			g.cfg.Coordinators = []string{server.URL}
			for second := 0; second < 6; second++ {
				demandOf(g, *now, 2)
				if err := g.Renew(t.Context()); err == nil {
					t.Fatal("expected the refusal error")
				}
				if r := g.Status().Role; r != RoleWaiting {
					t.Fatalf("role %q, want waiting", r)
				}
				*now = now.Add(time.Second)
			}
			if requests.Load() != 6 {
				t.Fatalf("%d requests in 6 ticks, want one per tick", requests.Load())
			}
		})
	}
}

// When the building frees up the standby's next request is accepted, it serves, and the back-off is gone.
func TestStandbyServesOnceTheBuildingIsFree(t *testing.T) {
	var requests atomic.Int64
	free := atomic.Bool{}
	version := atomic.Uint64{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req GrantRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if !free.Load() {
			_ = json.NewEncoder(w).Encode(GrantResponse{Accepted: false, Reason: ReasonSessionActive, RequestID: req.RequestID, LeaseMS: 12000})
			return
		}
		_ = json.NewEncoder(w).Encode(GrantResponse{true, "granted", req.RequestID, 12000, Lease{req.BuildingID, req.SessionID, req.Amps, version.Add(1)}})
	}))
	defer server.Close()
	g, now := fixture(t)
	g.cfg.Coordinators = []string{server.URL}
	for second := 0; second < 3; second++ { // refused at 0 s, backed off at 1 s, refused again at 2 s
		demandOf(g, *now, 1)
		_ = g.Renew(t.Context())
		*now = now.Add(time.Second)
	}
	if requests.Load() != 2 || g.Status().ServedAmps != 0 {
		t.Fatalf("requests %d, status %+v", requests.Load(), g.Status())
	}
	free.Store(true)
	demandOf(g, *now, 1)
	if err := g.Renew(t.Context()); err != nil { // 1 s after the last refusal: still backed off, nothing sent
		t.Fatal(err)
	}
	if requests.Load() != 2 {
		t.Fatalf("sent a request inside the back-off: %d", requests.Load())
	}
	*now = now.Add(time.Second)
	demandOf(g, *now, 1)
	if err := g.Renew(t.Context()); err != nil {
		t.Fatalf("the building is free, the request must be accepted: %v", err)
	}
	if s := g.Status(); s.Role != RoleServing || s.GrantedAmps != 8 || s.ServedAmps != 8 || s.LastError != "" {
		t.Fatalf("after takeover: %+v", s)
	}
}

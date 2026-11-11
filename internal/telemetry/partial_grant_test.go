package telemetry

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// demandOf ingests n meters of 8 A each (n*8 A of demand), all observed at now.
func demandOf(g *Gateway, now time.Time, meters int) {
	for i := 0; i < meters; i++ {
		g.Ingest(Reading{fmt.Sprint("r-", now.UnixNano(), "-", i), "hamra", fmt.Sprint("meter-", i), 8, now})
	}
}

// partialCoordinator answers every grant with a partial grant of the given amps and counts the requests.
func partialCoordinator(t *testing.T, amps int, requests *atomic.Int64, asked *atomic.Int64) *httptest.Server {
	t.Helper()
	version := atomic.Uint64{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req GrantRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		requests.Add(1)
		asked.Store(int64(req.Amps))
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(GrantResponse{true, "granted_partial", req.RequestID, 12000, Lease{req.BuildingID, req.SessionID, amps, version.Add(1)}})
	}))
	t.Cleanup(server.Close)
	return server
}

func TestPartialGrantIsServedAtTheSmallerOfDemandAndGrant(t *testing.T) {
	g, now := fixture(t)
	demandOf(g, *now, 13) // 104 A
	req := GrantRequest{NewID(), "hamra", g.session, 104}
	res := GrantResponse{true, "granted_partial", req.RequestID, 12000, Lease{"hamra", g.session, 40, 5}}
	if err := g.ApplyGrant(req, *now, res); err != nil {
		t.Fatalf("a granted response below the requested amount must be accepted: %v", err)
	}
	s := g.Status()
	if s.DemandAmps != 104 || s.GrantedAmps != 40 || s.ServedAmps != 40 || s.State != "limited" {
		t.Fatalf("%+v", s)
	}
	// A later, larger grant (growth after the hog's tier expired) raises the usable amount; the smaller stays until its deadline.
	*now = now.Add(time.Second)
	demandOf(g, *now, 13)
	req = GrantRequest{NewID(), "hamra", g.session, 104}
	if err := g.ApplyGrant(req, *now, GrantResponse{true, "granted_partial", req.RequestID, 12000, Lease{"hamra", g.session, 58, 6}}); err != nil {
		t.Fatal(err)
	}
	if s = g.Status(); s.GrantedAmps != 58 || s.ServedAmps != 58 || s.State != "limited" {
		t.Fatalf("%+v", s)
	}
}

// Under sustained overload (demand above the grant) the gateway asks once per Run tick, one second; when the grant
// covers the demand it asks once per three seconds. This pins the cadence the fair-share policy relies on.
func TestRenewalCadenceUnderOverloadAndWhenCovered(t *testing.T) {
	var requests, asked atomic.Int64
	server := partialCoordinator(t, 40, &requests, &asked)
	g, now := fixture(t)
	g.cfg.Coordinators = []string{server.URL}
	for second := 0; second < 6; second++ {
		demandOf(g, *now, 13)
		if err := g.Renew(t.Context()); err != nil {
			t.Fatal(err)
		}
		*now = now.Add(time.Second)
	}
	if requests.Load() != 6 || asked.Load() != 104 {
		t.Fatalf("overloaded gateway sent %d requests in 6 ticks (last asked %d A); want one per tick of the full demand", requests.Load(), asked.Load())
	}
	covered, now2 := fixture(t)
	covered.cfg.Coordinators = []string{server.URL}
	requests.Store(0)
	for second := 0; second < 9; second++ {
		demandOf(covered, *now2, 1) // 8 A, covered by the 40 A grant
		if err := covered.Renew(t.Context()); err != nil {
			t.Fatal(err)
		}
		*now2 = now2.Add(time.Second)
	}
	if requests.Load() != 3 {
		t.Fatalf("covered gateway sent %d requests in 9 ticks, want 3 (one per 3 s)", requests.Load())
	}
}

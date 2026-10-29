package telemetry

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func fixture(t *testing.T) (*Gateway, *time.Time) {
	t.Helper()
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	g, err := NewGateway(GatewayConfig{BuildingID: "hamra", Name: "Hamra", Coordinators: []string{"http://localhost:8080"}, SafetyMargin: 2 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	g.now = func() time.Time { return now }
	return g, &now
}

func reading(now time.Time, id string) Reading { return Reading{id, "hamra", "meter-1", 8, now} }
func grant(g *Gateway, amps int, version uint64) (GrantRequest, GrantResponse) {
	r := GrantRequest{NewID(), "hamra", g.session, amps}
	return r, GrantResponse{true, "", r.RequestID, 12000, Lease{"hamra", g.session, amps, version}}
}

func TestLeaseDeadlineIncludesFirstSendAndDuplicateDoesNotExtend(t *testing.T) {
	g, now := fixture(t)
	started := *now
	req, res := grant(g, 10, 1)
	*now = now.Add(4 * time.Second)
	if err := g.ApplyGrant(req, started, res); err != nil {
		t.Fatal(err)
	}
	if remaining := g.Status().LeaseRemainingMS; remaining != 6000 {
		t.Fatalf("remaining %d, want 6000", remaining)
	}
	*now = now.Add(3 * time.Second)
	if err := g.ApplyGrant(req, started, res); err != nil {
		t.Fatal(err)
	}
	if remaining := g.Status().LeaseRemainingMS; remaining != 3000 {
		t.Fatalf("duplicate extended deadline: %d", remaining)
	}
	*now = started.Add(10 * time.Second)
	if err := g.ApplyGrant(req, started, res); err == nil {
		t.Fatal("accepted response at safe deadline")
	}
	if g.Status().GrantedAmps != 0 {
		t.Fatal("expired budget still usable")
	}
}

func TestExpiredLeaseAlwaysStopsService(t *testing.T) {
	g, now := fixture(t)
	req, res := grant(g, 10, 1)
	if err := g.ApplyGrant(req, *now, res); err != nil {
		t.Fatal(err)
	}
	g.Ingest(reading(*now, "reading-1"))
	if g.Status().ServedAmps != 8 {
		t.Fatal("expected active service")
	}
	*now = now.Add(10 * time.Second)
	g.Ingest(reading(*now, "reading-2"))
	s := g.Status()
	if s.DemandAmps != 8 || s.ServedAmps != 0 || s.GrantedAmps != 0 || s.State != "expired" {
		t.Fatalf("expired service: %+v", s)
	}
}

func TestReplyIdentityAndInvalidTTLRejected(t *testing.T) {
	for _, kind := range []string{"session", "building", "request", "negative", "zero-version", "ttl"} {
		t.Run(kind, func(t *testing.T) {
			g, now := fixture(t)
			req, res := grant(g, 10, 1)
			switch kind {
			case "session":
				res.Lease.SessionID = "previous-boot"
			case "building":
				res.Lease.BuildingID = "other"
			case "request":
				res.RequestID = "other"
			case "negative":
				res.Lease.Amps = -1
			case "zero-version":
				res.Lease.Version = 0
			case "ttl":
				res.LeaseMS = 12001
			}
			if err := g.ApplyGrant(req, *now, res); err == nil {
				t.Fatalf("accepted invalid %s", kind)
			}
			if g.Status().ServedAmps != 0 {
				t.Fatal("invalid lease enabled service")
			}
		})
	}
}

func TestRenewalNeverExtendsPreviousLargerBudget(t *testing.T) {
	g, now := fixture(t)
	req, res := grant(g, 10, 1)
	if err := g.ApplyGrant(req, *now, res); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(3 * time.Second)
	req, res = grant(g, 4, 2)
	if err := g.ApplyGrant(req, *now, res); err != nil {
		t.Fatal(err)
	}
	if g.Status().GrantedAmps != 10 {
		t.Fatal("old budget shrank before its deadline")
	}
	*now = now.Add(7 * time.Second)
	g.Ingest(reading(*now, "new-demand"))
	s := g.Status()
	if s.GrantedAmps != 4 || s.ServedAmps != 4 || s.LeaseRemainingMS != 3000 {
		t.Fatalf("extended old budget: %+v", s)
	}
}

func TestReadingsDeduplicateExpireAndBoundQueue(t *testing.T) {
	g, now := fixture(t)
	r := reading(*now, "one")
	if !g.Ingest(r) || g.Ingest(r) {
		t.Fatal("dedup failure")
	}
	for i := 0; i < MaxPending; i++ {
		r.ReadingID = fmt.Sprintf("id-%d", i)
		if !g.Ingest(r) {
			t.Fatalf("rejected sample %d", i)
		}
	}
	s := g.Status()
	if s.PendingReadings != MaxPending || s.DroppedReadings != 1 || s.ReadingsTotal != MaxPending+1 {
		t.Fatalf("unbounded queue or incorrect counters: %+v", s)
	}
	*now = now.Add(5 * time.Second)
	s = g.Status()
	if s.MeterCount != 0 || s.DemandAmps != 0 {
		t.Fatal("stale demand retained")
	}
	if g.Ingest(r) {
		t.Fatal("old sample accepted")
	}
}

func TestRetriesReuseRequestIdentityAndFlushRetainsFailedBatch(t *testing.T) {
	var ids []string
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path == "/api/grants" {
			var req GrantRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			ids = append(ids, req.RequestID)
		}
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	g, now := fixture(t)
	g.cfg.Coordinators = []string{server.URL}
	g.Ingest(reading(*now, "one"))
	if err := g.Renew(context.Background()); err == nil {
		t.Fatal("expected renewal failure")
	}
	if len(ids) != 3 || ids[0] != ids[1] || ids[1] != ids[2] {
		t.Fatalf("retry IDs differ: %v", ids)
	}
	if err := g.Flush(context.Background()); err == nil {
		t.Fatal("expected SQL failure")
	}
	if g.Status().PendingReadings != 1 || requests != 6 {
		t.Fatalf("lost pending sample, requests=%d", requests)
	}
}

func TestRedirectAllowlistAndSuccessfulFlush(t *testing.T) {
	var received int
	leader := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var batch struct {
			Readings []Reading `json:"readings"`
		}
		_ = json.NewDecoder(r.Body).Decode(&batch)
		received += len(batch.Readings)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer leader.Close()
	follower := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", leader.URL+r.URL.Path)
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer follower.Close()
	g, now := fixture(t)
	g.cfg.Coordinators = []string{follower.URL, leader.URL}
	g.Ingest(reading(*now, "one"))
	if err := g.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if received != 1 || g.Status().PendingReadings != 0 {
		t.Fatal("batch not acknowledged")
	}
	for _, location := range []string{"http://evil.test/api/readings", leader.URL + "/api/grants?secret=x", leader.URL + "/api/readings#x", strings.Replace(leader.URL, "http://", "http://user:pass@", 1) + "/api/readings"} {
		if _, ok := g.allowedRedirect(location, "/api/readings"); ok {
			t.Fatalf("allowed %s", location)
		}
	}
}

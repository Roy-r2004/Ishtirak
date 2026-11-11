package coordinator

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// statusServer answers GET /api/status with the given JSON body and status code.
func statusServer(t *testing.T, code int, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/status" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestPeerMissingFairShare(t *testing.T) {
	upgraded := statusServer(t, 200, `{"node_id":"a","fair_share":false,"wants":[]}`) // the key exists even when the policy is first_come
	old := statusServer(t, 200, `{"node_id":"b","state":"Leader"}`)
	broken := statusServer(t, 500, `{"fair_share":true}`)
	garbage := statusServer(t, 200, `not json`)
	redirect := httptest.NewServer(http.RedirectHandler(upgraded.URL+"/api/status", http.StatusTemporaryRedirect))
	t.Cleanup(redirect.Close)
	closed := httptest.NewServer(http.NotFoundHandler())
	closedURL := closed.URL
	closed.Close()

	cases := []struct {
		name  string
		peers map[string]string
		want  string
	}{
		{"all upgraded", map[string]string{"n1": "http://unused", "a": upgraded.URL, "a2": upgraded.URL}, ""},
		{"only self", map[string]string{"n1": "http://unused"}, ""},
		{"an old replica", map[string]string{"n1": "http://unused", "a": upgraded.URL, "b": old.URL}, "b"},
		{"a replica answering 500", map[string]string{"n1": "http://unused", "e": broken.URL}, "e"},
		{"a replica answering garbage", map[string]string{"n1": "http://unused", "g": garbage.URL}, "g"},
		{"a redirect is not followed", map[string]string{"n1": "http://unused", "r": redirect.URL}, "r"},
		{"an unreachable replica", map[string]string{"n1": "http://unused", "a": upgraded.URL, "z": closedURL}, "z"},
	}
	for _, tc := range cases {
		s := &Server{cfg: Config{NodeID: "n1", HTTPPeers: tc.peers}}
		if got := s.peerMissingFairShare(context.Background()); got != tc.want {
			t.Errorf("%s: peerMissingFairShare = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestEnsurePolicyWaitsForUpgradedPeers(t *testing.T) {
	s := newTestServer(t, true)
	s.peersBlocked.Store(true)
	if err := s.ensurePolicy(); err != nil {
		t.Fatalf("a blocked ensurePolicy must not fail (grants and expiries keep running): %v", err)
	}
	if v := s.fsm.View(); v.PolicyConfigured || v.FairShare {
		t.Fatalf("fair_share must not be proposed while a peer may be old: %+v", v)
	}
	s.peersBlocked.Store(false)
	if err := s.ensurePolicy(); err != nil {
		t.Fatal(err)
	}
	if v := s.fsm.View(); !v.PolicyConfigured || !v.FairShare {
		t.Fatalf("fair_share must be proposed once every peer supports it: %+v", v)
	}
}

func TestEnsurePolicyFirstComeConfigIgnoresPeers(t *testing.T) {
	s := newTestServer(t, false)
	s.peersBlocked.Store(true)
	if err := s.ensurePolicy(); err != nil {
		t.Fatal(err)
	}
	if v := s.fsm.View(); !v.PolicyConfigured || v.FairShare {
		t.Fatalf("first_come is always safe to commit: %+v", v)
	}
}

func TestPolicyEndpointRefusesFairShareWhileAPeerMayBeOld(t *testing.T) {
	s := newTestServer(t, true)
	s.peersBlocked.Store(true)
	if rec := post(s.policy, "/api/policy", `{"policy":"fair_share"}`); rec.Code != 409 {
		t.Fatalf("enabling fair_share while a peer may be old must be refused with 409, got %d %s", rec.Code, rec.Body)
	}
	if v := s.fsm.View(); v.FairShare {
		t.Fatal("the refused request changed the policy")
	}
	if rec := post(s.policy, "/api/policy", `{"policy":"first_come"}`); rec.Code != 200 {
		t.Fatalf("switching to first_come is always allowed, got %d %s", rec.Code, rec.Body)
	}
	s.peersBlocked.Store(false)
	if rec := post(s.policy, "/api/policy", `{"policy":"fair_share"}`); rec.Code != 200 {
		t.Fatalf("fair_share must be accepted once every peer supports it, got %d %s", rec.Code, rec.Body)
	}
}

func TestPolicyEndpointRequiresTheAdminTokenWhenConfigured(t *testing.T) {
	s := newTestServer(t, true)
	s.cfg.AdminToken = "s3cret"
	do := func(token string) int {
		req := httptest.NewRequest(http.MethodPost, "/api/policy", strings.NewReader(`{"policy":"first_come"}`))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("X-Ishtirak-Admin", token)
		}
		rec := httptest.NewRecorder()
		s.policy(rec, req)
		return rec.Code
	}
	if code := do(""); code != 403 {
		t.Fatalf("a missing token must be refused, got %d", code)
	}
	if code := do("wrong"); code != 403 {
		t.Fatalf("a wrong token must be refused, got %d", code)
	}
	if v := s.fsm.View(); v.PolicyConfigured {
		t.Fatal("a refused request changed the policy")
	}
	if code := do("s3cret"); code != 200 {
		t.Fatalf("the right token must be accepted, got %d", code)
	}
}

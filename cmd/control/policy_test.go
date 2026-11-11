package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// fakeCluster is three fake coordinators: GET /api/status reports the given raft state, POST /api/policy is
// recorded and answered by reply.
type fakeCluster struct {
	mu    sync.Mutex
	posts map[string][]string // coordinator id -> bodies received on /api/policy
	types map[string][]string // coordinator id -> Content-Type of those requests
}

func newFakeCluster(t *testing.T, states map[string]string, reply func(id string, w http.ResponseWriter)) *fakeCluster {
	t.Helper()
	fc := &fakeCluster{posts: map[string][]string{}, types: map[string][]string{}}
	urls := map[string]string{}
	for _, id := range []string{"coordinator1", "coordinator2", "coordinator3"} {
		id := id
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.Method == "GET" && r.URL.Path == "/api/status":
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"node_id":"` + id + `","state":"` + states[id] + `"}`))
			case r.Method == "POST" && r.URL.Path == "/api/policy":
				b, _ := io.ReadAll(r.Body)
				fc.mu.Lock()
				fc.posts[id] = append(fc.posts[id], string(b))
				fc.types[id] = append(fc.types[id], r.Header.Get("Content-Type"))
				fc.mu.Unlock()
				reply(id, w)
			default:
				http.NotFound(w, r)
			}
		}))
		t.Cleanup(srv.Close)
		urls[id] = srv.URL
	}
	old := coordinatorURL
	coordinatorURL = func(id string) string { return urls[id] }
	t.Cleanup(func() { coordinatorURL = old })
	return fc
}
func (fc *fakeCluster) total() int {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	n := 0
	for _, p := range fc.posts {
		n += len(p)
	}
	return n
}
func ok(value string) func(string, http.ResponseWriter) {
	return func(_ string, w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"policy":"` + value + `"}` + "\n"))
	}
}
func policyRequest(method, origin, contentType, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://localhost:8088/api/policy", strings.NewReader(body))
	if contentType != "" {
		r.Header.Set("Content-Type", contentType)
	}
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	w := httptest.NewRecorder()
	policy(w, r)
	return w
}

var oneLeader = map[string]string{"coordinator1": "Follower", "coordinator2": "Leader", "coordinator3": "Follower"}

func TestPolicyForwardsToTheLeaderOnly(t *testing.T) {
	t.Setenv("ENABLE_DEMO", "true")
	fc := newFakeCluster(t, oneLeader, ok("fair_share"))
	w := policyRequest("POST", "http://localhost:8088", "application/json; charset=utf-8", `{"policy":"fair_share"}`)
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"policy":"fair_share"}` {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if got := fc.posts["coordinator2"]; len(got) != 1 || got[0] != `{"policy":"fair_share"}` || fc.total() != 1 {
		t.Fatalf("exactly the leader must receive the whitelisted body: %v", fc.posts)
	}
	if got := fc.types["coordinator2"][0]; got != "application/json" {
		t.Fatalf("forwarded content type %q", got)
	}
	// first_come goes through the same path.
	fc = newFakeCluster(t, map[string]string{"coordinator1": "Leader", "coordinator2": "Follower", "coordinator3": "Candidate"}, ok("first_come"))
	if w = policyRequest("POST", "", "application/json", `{"policy":"first_come"}`); w.Code != 200 || len(fc.posts["coordinator1"]) != 1 || fc.total() != 1 {
		t.Fatalf("%d %s %v", w.Code, w.Body, fc.posts)
	}
}
func TestPolicyRejectsUnsafeRequestsBeforeAnyCoordinatorIsContacted(t *testing.T) {
	t.Setenv("ENABLE_DEMO", "true")
	fc := newFakeCluster(t, oneLeader, ok("fair_share"))
	for _, tc := range []struct {
		name, method, origin, contentType, body string
		want                                    int
	}{
		{"GET", "GET", "", "application/json", `{"policy":"fair_share"}`, 405},
		{"cross origin", "POST", "http://attacker.example", "application/json", `{"policy":"fair_share"}`, 403},
		{"cross origin with the same host name but another port", "POST", "http://localhost:9999", "application/json", `{"policy":"fair_share"}`, 403},
		{"form content type", "POST", "", "application/x-www-form-urlencoded", `{"policy":"fair_share"}`, 415},
		{"no content type", "POST", "", "", `{"policy":"fair_share"}`, 415},
		{"text content type", "POST", "", "text/plain", `{"policy":"fair_share"}`, 415},
		{"unknown policy", "POST", "", "application/json", `{"policy":"round_robin"}`, 400},
		{"empty policy", "POST", "", "application/json", `{"policy":""}`, 400},
		{"missing policy", "POST", "", "application/json", `{}`, 400},
		{"wrong case", "POST", "", "application/json", `{"policy":"FAIR_SHARE"}`, 400},
		{"padded", "POST", "", "application/json", `{"policy":" fair_share"}`, 400},
		{"unknown field", "POST", "", "application/json", `{"policy":"fair_share","capacity":1}`, 400},
		{"not json", "POST", "", "application/json", `fair_share`, 400},
		{"two objects", "POST", "", "application/json", `{"policy":"fair_share"}{"policy":"first_come"}`, 400},
		{"not a string", "POST", "", "application/json", `{"policy":1}`, 400},
		{"oversized", "POST", "", "application/json", `{"policy":"fair_share","pad":"` + strings.Repeat("x", 5000) + `"}`, 400},
		{"empty body", "POST", "", "application/json", ``, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if w := policyRequest(tc.method, tc.origin, tc.contentType, tc.body); w.Code != tc.want {
				t.Fatalf("got %d %s want %d", w.Code, w.Body, tc.want)
			}
		})
	}
	if fc.total() != 0 {
		t.Fatalf("a rejected request reached a coordinator: %v", fc.posts)
	}
}
func TestPolicyRequiresDemoControls(t *testing.T) {
	t.Setenv("ENABLE_DEMO", "")
	fc := newFakeCluster(t, oneLeader, ok("fair_share"))
	if w := policyRequest("POST", "", "application/json", `{"policy":"fair_share"}`); w.Code != 403 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	t.Setenv("ENABLE_DEMO", "false")
	if w := policyRequest("POST", "", "application/json", `{"policy":"fair_share"}`); w.Code != 403 || fc.total() != 0 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
}
func TestPolicyWithoutALeaderIsUnavailable(t *testing.T) {
	t.Setenv("ENABLE_DEMO", "true")
	for name, states := range map[string]map[string]string{
		"election":   {"coordinator1": "Candidate", "coordinator2": "Follower", "coordinator3": "Follower"},
		"all down":   {},
		"lookalikes": {"coordinator1": "leader", "coordinator2": "Leader ", "coordinator3": "Shutdown"},
	} {
		fc := newFakeCluster(t, states, ok("fair_share"))
		if w := policyRequest("POST", "", "application/json", `{"policy":"fair_share"}`); w.Code != 503 || fc.total() != 0 {
			t.Fatalf("%s: %d %s %v", name, w.Code, w.Body, fc.posts)
		}
	}
}
func TestPolicyRelaysTheLeadersAnswerAndNeverFollowsRedirects(t *testing.T) {
	t.Setenv("ENABLE_DEMO", "true")
	for _, tc := range []struct {
		name  string
		reply func(string, http.ResponseWriter)
		want  int
	}{
		{"leader refuses the value", func(_ string, w http.ResponseWriter) { http.Error(w, `{"error":"bad"}`, 400) }, 400},
		{"commit outcome unknown", func(_ string, w http.ResponseWriter) { http.Error(w, `{"error":"commit outcome unknown"}`, 503) }, 503},
		{"deposed leader redirects", func(_ string, w http.ResponseWriter) {
			w.Header().Set("Location", "http://coordinator3:8080/api/policy")
			w.WriteHeader(307)
		}, 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fc := newFakeCluster(t, oneLeader, tc.reply)
			w := policyRequest("POST", "", "application/json", `{"policy":"fair_share"}`)
			if w.Code != tc.want || fc.total() != 1 {
				t.Fatalf("%d %s %v", w.Code, w.Body, fc.posts)
			}
		})
	}
}

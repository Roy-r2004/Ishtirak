package coordinator

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/hashicorp/raft"
	"ishtirak/internal/ledger"
	"ishtirak/internal/storage"
)

// newTestServer is a Server around a real single-node Raft (in-memory transport and stores) and a real FSM,
// so handlers, ensureCapacity/ensurePolicy and Status run against committed state. There is no PostgreSQL.
func newTestServer(t *testing.T, fairShare bool) *Server {
	t.Helper()
	conf := raft.DefaultConfig()
	conf.LocalID = "n1"
	conf.HeartbeatTimeout, conf.ElectionTimeout, conf.LeaderLeaseTimeout, conf.CommitTimeout = 50*time.Millisecond, 50*time.Millisecond, 50*time.Millisecond, 5*time.Millisecond
	conf.LogOutput = io.Discard
	store := raft.NewInmemStore()
	addr, transport := raft.NewInmemTransport("")
	fsm := ledger.New()
	r, err := raft.NewRaft(conf, fsm, store, store, raft.NewInmemSnapshotStore(), transport)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.Shutdown().Error() })
	if err = r.BootstrapCluster(raft.Configuration{Servers: []raft.Server{{Suffrage: raft.Voter, ID: "n1", Address: addr}}}).Error(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for r.State() != raft.Leader {
		if time.Now().After(deadline) {
			t.Fatal("single-node raft never elected itself")
		}
		time.Sleep(10 * time.Millisecond)
	}
	st, err := storage.Open(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{cfg: Config{NodeID: "n1", Capacity: 120, Lease: LeaseDuration, FairShare: fairShare, HTTPPeers: map[string]string{}}, raft: r, fsm: fsm, store: st, deadlines: NewDeadlines(LeaseDuration)}
	s.verified.Store(proof{})
	return s
}
func post(h http.HandlerFunc, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h(w, req)
	return w
}

func TestEnsurePolicyProposesConfigOnlyWhileUnconfigured(t *testing.T) {
	for _, tc := range []struct{ configured, committed bool }{{true, true}, {false, false}} {
		s := newTestServer(t, tc.configured)
		if err := s.ensureCapacity(); err != nil {
			t.Fatal(err)
		}
		if v := s.fsm.View(); v.PolicyConfigured || v.FairShare {
			t.Fatalf("policy must stay unconfigured until proposed: %+v", v)
		}
		if err := s.ensurePolicy(); err != nil {
			t.Fatal(err)
		}
		if v := s.fsm.View(); !v.PolicyConfigured || v.FairShare != tc.committed {
			t.Fatalf("FAIR_SHARE=%v committed %+v", tc.configured, v)
		}
	}
	// A committed policy is never overridden by this node's configuration.
	s := newTestServer(t, true)
	if err := s.ensureCapacity(); err != nil {
		t.Fatal(err)
	}
	if w := post(s.policy, "/api/policy", `{"policy":"first_come"}`); w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if err := s.ensurePolicy(); err != nil {
		t.Fatal(err)
	}
	if v := s.fsm.View(); v.FairShare || !v.PolicyConfigured {
		t.Fatalf("config overrode the committed policy: %+v", v)
	}
	index := s.raft.AppliedIndex()
	if err := s.ensurePolicy(); err != nil || s.raft.AppliedIndex() != index {
		t.Fatal("ensurePolicy proposed an entry although the policy is committed")
	}
}
func TestPolicyEndpoint(t *testing.T) {
	s := newTestServer(t, true)
	for name, body := range map[string]string{
		"not json":        `policy=fair_share`,
		"unknown field":   `{"policy":"fair_share","force":true}`,
		"unknown policy":  `{"policy":"round_robin"}`,
		"empty policy":    `{"policy":""}`,
		"missing policy":  `{}`,
		"wrong case":      `{"policy":"Fair_Share"}`,
		"two objects":     `{"policy":"fair_share"}{"policy":"first_come"}`,
		"non-string":      `{"policy":true}`,
		"trailing spaces": `{"policy":"fair_share "}`,
	} {
		if w := post(s.policy, "/api/policy", body); w.Code != 400 {
			t.Errorf("%s: status %d body %s", name, w.Code, w.Body)
		}
	}
	if v := s.fsm.View(); v.PolicyConfigured {
		t.Fatalf("a rejected request changed the policy: %+v", v)
	}
	for _, p := range []string{"first_come", "fair_share", "first_come"} {
		w := post(s.policy, "/api/policy", `{"policy":"`+p+`"}`)
		var got map[string]string
		if err := json.Unmarshal(w.Body.Bytes(), &got); w.Code != 200 || err != nil || got["policy"] != p {
			t.Fatalf("%s: %d %s", p, w.Code, w.Body)
		}
		if v := s.fsm.View(); v.FairShare != (p == "fair_share") || !v.PolicyConfigured {
			t.Fatalf("%s not committed: %+v", p, v)
		}
	}
	if !s.fsm.View().Initialized {
		t.Fatal("the policy endpoint must initialize capacity first, like grant")
	}
	// Once Raft has stopped there is no leader to redirect to.
	if err := s.raft.Shutdown().Error(); err != nil {
		t.Fatal(err)
	}
	if w := post(s.policy, "/api/policy", `{"policy":"fair_share"}`); w.Code != 503 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
}
func TestGrantHandlerHonoursTheCommittedPolicy(t *testing.T) {
	for _, fair := range []bool{true, false} {
		s := newTestServer(t, fair)
		w := post(s.grant, "/api/grants", `{"request_id":"r1","building_id":"hamra","session_id":"s","amps":500}`)
		var got struct {
			Accepted bool         `json:"accepted"`
			Reason   string       `json:"reason"`
			Lease    ledger.Lease `json:"lease"`
			LeaseMS  int64        `json:"lease_ms"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != 200 {
			t.Fatalf("%d %s", w.Code, w.Body)
		}
		if v := s.fsm.View(); !v.PolicyConfigured || v.FairShare != fair {
			t.Fatalf("the grant handler must commit the policy before the first grant: %+v", v)
		}
		if fair && (!got.Accepted || got.Reason != "granted_partial" || got.Lease.Amps != 120 || got.LeaseMS != 12000) {
			t.Fatalf("fair share: %s", w.Body)
		}
		if !fair && (got.Accepted || got.Reason != "invalid_request") {
			t.Fatalf("first come: %s", w.Body)
		}
	}
}
func TestStatusReportsPolicyWantsAndFairShares(t *testing.T) {
	s := newTestServer(t, true)
	for _, body := range []string{
		`{"request_id":"r1","building_id":"zeta","session_id":"s","amps":100}`,
		`{"request_id":"r2","building_id":"alpha","session_id":"s","amps":100}`,
		`{"request_id":"r3","building_id":"mid","session_id":"s","amps":10}`,
	} {
		if w := post(s.grant, "/api/grants", body); w.Code != 200 {
			t.Fatalf("%d %s", w.Code, w.Body)
		}
	}
	b, err := json.Marshal(s.Status())
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		FairShare  bool            `json:"fair_share"`
		Wants      []ledger.Want   `json:"wants"`
		FairShares []fairShareView `json:"fair_shares"`
		Granted    int             `json:"granted_amps"`
		Capacity   int             `json:"capacity_amps"`
	}
	if err = json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if !got.FairShare || got.Granted > got.Capacity {
		t.Fatalf("%s", b)
	}
	if len(got.Wants) != 3 || got.Wants[0].BuildingID != "alpha" || got.Wants[1].BuildingID != "mid" || got.Wants[2].BuildingID != "zeta" || got.Wants[0].Amps != 100 || got.Wants[1].Amps != 10 {
		t.Fatalf("wants must be sorted by building id: %+v", got.Wants)
	}
	want := []fairShareView{{"alpha", 55}, {"mid", 10}, {"zeta", 55}}
	if len(got.FairShares) != 3 || got.FairShares[0] != want[0] || got.FairShares[1] != want[1] || got.FairShares[2] != want[2] {
		t.Fatalf("fair shares must be sorted by building id: %+v", got.FairShares)
	}
	for _, key := range []string{"node_id", "state", "granted_amps", "available_amps", "leases", "audit", "lease_ms", "capacity_amps", "quorum"} {
		var all map[string]json.RawMessage
		_ = json.Unmarshal(b, &all)
		if _, ok := all[key]; !ok {
			t.Fatalf("existing status key %q disappeared", key)
		}
	}
	// An empty ledger still reports arrays, never null.
	empty := newTestServer(t, true)
	eb, _ := json.Marshal(empty.Status())
	if !strings.Contains(string(eb), `"wants":[]`) || !strings.Contains(string(eb), `"fair_shares":[]`) {
		t.Fatalf("empty wants/fair_shares must be [] in %s", eb)
	}
}

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// fakeServices serves GET /api/status for every compose host the overview asks for (coordinators, gateways,
// standbys, meters). Hosts in down answer 503. hits records the hosts that were asked.
func fakeServices(t *testing.T, down map[string]bool) (hits func() []string) {
	t.Helper()
	var mu sync.Mutex
	var asked []string
	urls := map[string]string{}
	var serveFor = func(host string) string {
		if u, ok := urls[host]; ok {
			return u
		}
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/status" {
				http.NotFound(w, r)
				return
			}
			mu.Lock()
			asked = append(asked, host)
			mu.Unlock()
			if down[host] {
				http.Error(w, "down", http.StatusServiceUnavailable)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"host":"` + host + `"}`))
		}))
		t.Cleanup(srv.Close)
		urls[host] = srv.URL
		return srv.URL
	}
	oldService, oldCoordinator := serviceURL, coordinatorURL
	t.Cleanup(func() { serviceURL, coordinatorURL = oldService, oldCoordinator })
	// Every host a test can ask for gets its own server up front, so the URL functions only read the map.
	for _, h := range []string{"coordinator1", "coordinator2", "coordinator3", "meters"} {
		serveFor(h)
	}
	for _, id := range buildingIDs {
		host := "gateway-" + strings.ReplaceAll(id, "_", "-")
		serveFor(host)
		serveFor(host + "-standby")
	}
	serviceURL = func(host string) string { return urls[host] }
	coordinatorURL = func(id string) string { return urls[id] }
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), asked...)
	}
}

type overviewBody struct {
	Nodes     []source        `json:"nodes"`
	Buildings []source        `json:"buildings"`
	Standbys  []source        `json:"standbys"`
	Meters    source          `json:"meters"`
	Observed  json.RawMessage `json:"observed_at"`
	Demo      *bool           `json:"demo_enabled"`
}

func getOverview(t *testing.T) (overviewBody, map[string]json.RawMessage) {
	t.Helper()
	w := httptest.NewRecorder()
	overview(w, httptest.NewRequest("GET", "/api/overview", nil))
	if w.Code != 200 {
		t.Fatalf("overview status %d: %s", w.Code, w.Body.String())
	}
	var body overviewBody
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || json.Unmarshal(w.Body.Bytes(), &raw) != nil {
		t.Fatalf("invalid overview JSON: %v", err)
	}
	return body, raw
}

func TestOverviewReportsEachBuildingsStandbyAndKeepsExistingKeys(t *testing.T) {
	hits := fakeServices(t, nil)
	body, raw := getOverview(t)
	for _, key := range []string{"nodes", "buildings", "standbys", "meters", "observed_at", "demo_enabled"} {
		if _, ok := raw[key]; !ok {
			t.Fatalf("overview lacks key %q: %v", key, raw)
		}
	}
	if len(raw) != 6 {
		t.Fatalf("overview has unexpected keys: %v", raw)
	}
	wantIDs := []string{"hamra", "mar_mikhael", "achrafieh"}
	wantHosts := []string{"gateway-hamra", "gateway-mar-mikhael", "gateway-achrafieh"}
	if len(body.Buildings) != 3 || len(body.Standbys) != 3 || len(body.Nodes) != 3 {
		t.Fatalf("counts: nodes %d buildings %d standbys %d", len(body.Nodes), len(body.Buildings), len(body.Standbys))
	}
	for i := range wantIDs {
		b, s := body.Buildings[i], body.Standbys[i]
		if b.ID != wantIDs[i] || !b.Online || string(b.Data) != `{"host":"`+wantHosts[i]+`"}` {
			t.Fatalf("building %d: %+v", i, b)
		}
		if s.ID != wantIDs[i] || !s.Online || string(s.Data) != `{"host":"`+wantHosts[i]+`-standby"}` || s.Error != "" {
			t.Fatalf("standby %d: %+v", i, s)
		}
	}
	if !body.Meters.Online || body.Meters.ID != "meters" {
		t.Fatalf("meters: %+v", body.Meters)
	}
	asked := map[string]int{}
	for _, h := range hits() {
		asked[h]++
	}
	for _, h := range append(wantHosts, "gateway-hamra-standby", "gateway-mar-mikhael-standby", "gateway-achrafieh-standby", "meters", "coordinator1", "coordinator2", "coordinator3") {
		if asked[h] != 1 {
			t.Fatalf("host %s was asked %d times, want 1 (%v)", h, asked[h], asked)
		}
	}
}

// A standby that is down is reported as such and changes nothing else: the primaries and the other keys are intact.
func TestOverviewStandbyDownDoesNotAffectOtherSources(t *testing.T) {
	fakeServices(t, map[string]bool{"gateway-mar-mikhael-standby": true})
	body, _ := getOverview(t)
	if s := body.Standbys[1]; s.ID != "mar_mikhael" || s.Online || s.Error != "HTTP 503" || len(s.Data) != 0 {
		t.Fatalf("down standby: %+v", s)
	}
	for i, s := range body.Standbys {
		if i != 1 && !s.Online {
			t.Fatalf("standby %d should be online: %+v", i, s)
		}
	}
	for i, b := range body.Buildings {
		if !b.Online {
			t.Fatalf("building %d should be online: %+v", i, b)
		}
	}
	if !body.Meters.Online || len(body.Nodes) != 3 || !body.Nodes[0].Online {
		t.Fatalf("other sources: meters %+v nodes %+v", body.Meters, body.Nodes)
	}
}

func TestOverviewRequiresGET(t *testing.T) {
	w := httptest.NewRecorder()
	overview(w, httptest.NewRequest("POST", "/api/overview", nil))
	if w.Code != 405 {
		t.Fatalf("POST overview got %d", w.Code)
	}
}

// The standby containers can be stopped, started and restarted from the console like any other allowlisted service,
// and only under their exact compose service name (the container is ishtirak-<service>).
func TestStandbyServicesAreAllowlistedByExactName(t *testing.T) {
	t.Setenv("ENABLE_DEMO", "true")
	old := docker
	defer func() { docker = old }()
	var mu sync.Mutex
	var posts []string
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.Split(strings.TrimPrefix(r.URL.Path, "/containers/"), "/")[0]
		if strings.HasSuffix(r.URL.Path, "/json") {
			_, _ = w.Write([]byte(`{"Config":{"Labels":{"com.docker.compose.project":"ishtirak","com.docker.compose.service":"` + strings.TrimPrefix(name, "ishtirak-") + `"}}}`))
			return
		}
		mu.Lock()
		posts = append(posts, r.URL.Path)
		mu.Unlock()
		w.WriteHeader(204)
	}))
	defer mock.Close()
	docker = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		r.URL.Scheme = "http"
		r.URL.Host = strings.TrimPrefix(mock.URL, "http://")
		return http.DefaultTransport.RoundTrip(r)
	})}
	do := func(service, act string) int {
		r := httptest.NewRequest("POST", "/api/actions", strings.NewReader(`{"service":"`+service+`","action":"`+act+`"}`))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		action(w, r)
		return w.Code
	}
	for _, s := range []string{"gateway-hamra-standby", "gateway-mar-mikhael-standby", "gateway-achrafieh-standby"} {
		for _, act := range []string{"stop", "start", "restart"} {
			if code := do(s, act); code != 200 {
				t.Fatalf("%s %s: got %d, want 200", act, s, code)
			}
		}
	}
	if len(posts) != 9 || posts[0] != "/containers/ishtirak-gateway-hamra-standby/stop" {
		t.Fatalf("docker posts: %v", posts)
	}
	for _, s := range []string{"gateway-hamra-standby2", "gateway-mar_mikhael-standby", "gateway-standby", "standby", "gateway-hamra-standby "} {
		if code := do(s, "stop"); code != 400 {
			t.Fatalf("unlisted service %q: got %d, want 400", s, code)
		}
	}
	if len(posts) != 9 {
		t.Fatalf("an unlisted service reached docker: %v", posts)
	}
}

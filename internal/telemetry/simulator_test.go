package telemetry

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSimulatorDeterministicDemandAndUniqueRestartIDs(t *testing.T) {
	a, _ := NewSimulator([]string{"hamra", "mar_mikhael", "achrafieh"}, 50)
	b, _ := NewSimulator([]string{"hamra", "mar_mikhael", "achrafieh"}, 50)
	ra, rb := a.Readings(time.Now()), b.Readings(time.Now())
	sum := 0.0
	for i, r := range ra {
		if r.Amps != rb[i].Amps || r.ReadingID == rb[i].ReadingID {
			t.Fatal("profile not deterministic or session IDs reused")
		}
		sum += r.Amps
	}
	if sum < 50 || sum > 100 {
		t.Fatalf("unexpected aggregate demand %.3f", sum)
	}
	if ra[0].ReadingID == a.Readings(time.Now())[0].ReadingID {
		t.Fatal("sequence IDs repeated")
	}
}

func TestSimulatorRuntimeConfigValidation(t *testing.T) {
	s, _ := NewSimulator([]string{"hamra"}, 50)
	for _, tc := range []struct {
		body string
		code int
	}{{`{"meter_count":200,"demand_factor":1.5}`, 200}, {`{"meter_count":0}`, 400}, {`{"meter_count":1001}`, 400}, {`{"meter_count":2.5}`, 400}, {`{"demand_factor":3.1}`, 400}, {`{"demand_factor":-1}`, 400}, {`{"unknown":1}`, 400}, {`{} {}`, 400}, {`{}`, 400}} {
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/config", strings.NewReader(tc.body)))
		if w.Code != tc.code {
			t.Fatalf("%s: status=%d body=%s", tc.body, w.Code, w.Body.String())
		}
	}
	if n := len(s.Readings(time.Now())); n != 200 {
		t.Fatalf("runtime meter count=%d", n)
	}
}

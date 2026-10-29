package telemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const MaxPending = 5000
const sampleTTL = 5 * time.Second

type GatewayConfig struct {
	BuildingID   string
	Name         string
	Coordinators []string
	SafetyMargin time.Duration
}

type localGrant struct {
	amps    int
	version uint64
	expires time.Time
}

type Gateway struct {
	mu             sync.Mutex
	flushMu        sync.Mutex
	renewMu        sync.Mutex
	cfg            GatewayConfig
	session        string
	now            func() time.Time
	client         *http.Client
	latest         map[string]Reading
	seen           map[string]time.Time
	pending        []Reading
	grants         []localGrant
	mqttConnected  bool
	dropped, total uint64
	lastError      string
	lastAttempt    time.Time
	hadGrant       bool
}

type GatewayStatus struct {
	BuildingID       string  `json:"building_id"`
	Name             string  `json:"name"`
	SessionID        string  `json:"session_id"`
	MeterCount       int     `json:"meter_count"`
	DemandAmps       float64 `json:"demand_amps"`
	ServedAmps       float64 `json:"served_amps"`
	GrantedAmps      int     `json:"granted_amps"`
	LeaseRemainingMS int64   `json:"lease_remaining_ms"`
	LeaseVersion     uint64  `json:"lease_version"`
	State            string  `json:"state"`
	MQTTConnected    bool    `json:"mqtt_connected"`
	PendingReadings  int     `json:"pending_readings"`
	DroppedReadings  uint64  `json:"dropped_readings"`
	LastError        string  `json:"last_error"`
	ReadingsTotal    uint64  `json:"readings_total"`
}

func NewGateway(cfg GatewayConfig) (*Gateway, error) {
	if cfg.BuildingID == "" || len(cfg.Coordinators) == 0 {
		return nil, errors.New("building and coordinators required")
	}
	if cfg.SafetyMargin <= 0 || cfg.SafetyMargin >= LeaseTTL {
		return nil, errors.New("safety margin must be between zero and lease TTL")
	}
	for i, raw := range cfg.Coordinators {
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
			return nil, fmt.Errorf("invalid coordinator URL %q", raw)
		}
		cfg.Coordinators[i] = strings.TrimRight(raw, "/")
	}
	return &Gateway{cfg: cfg, session: NewID(), now: time.Now, client: &http.Client{Timeout: 1500 * time.Millisecond, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, latest: make(map[string]Reading), seen: make(map[string]time.Time)}, nil
}

func (g *Gateway) SetMQTTConnected(connected bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.mqttConnected = connected
}
func (g *Gateway) SetError(err error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if err != nil {
		g.lastError = err.Error()
	}
}

// Ingest rejects malformed, old and duplicate samples; memory is bounded even on bad traffic.
func (g *Gateway) Ingest(r Reading) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	if r.BuildingID != g.cfg.BuildingID || len(r.ReadingID) == 0 || len(r.ReadingID) > 200 || len(r.MeterID) == 0 || len(r.MeterID) > 100 || math.IsNaN(r.Amps) || math.IsInf(r.Amps, 0) || r.Amps < 0 || r.Amps > 10000 || r.ObservedAt.Before(now.Add(-sampleTTL)) || r.ObservedAt.After(now.Add(2*time.Second)) {
		return false
	}
	g.expireSamples(now)
	if _, ok := g.seen[r.ReadingID]; ok {
		return false
	}
	if len(g.seen) >= 20000 {
		return false
	}
	if _, exists := g.latest[r.MeterID]; !exists && len(g.latest) >= 5000 {
		return false
	}
	g.seen[r.ReadingID] = now
	if prev, exists := g.latest[r.MeterID]; !exists || !r.ObservedAt.Before(prev.ObservedAt) {
		g.latest[r.MeterID] = r
	}
	g.total++
	if len(g.pending) < MaxPending {
		g.pending = append(g.pending, r)
	} else {
		g.dropped++
	}
	return true
}

func (g *Gateway) expireSamples(now time.Time) {
	for meter, r := range g.latest {
		if !r.ObservedAt.Add(sampleTTL).After(now) {
			delete(g.latest, meter)
		}
	}
	for id, at := range g.seen {
		// A reading can be at most two seconds ahead and remains useful for five.
		// Ten seconds covers that window without filling dedup storage at 1000 Hz.
		if !at.Add(10 * time.Second).After(now) {
			delete(g.seen, id)
		}
	}
}

func (g *Gateway) statusLocked(now time.Time) GatewayStatus {
	g.expireSamples(now)
	s := GatewayStatus{BuildingID: g.cfg.BuildingID, Name: g.cfg.Name, SessionID: g.session, MeterCount: len(g.latest), MQTTConnected: g.mqttConnected, PendingReadings: len(g.pending), DroppedReadings: g.dropped, LastError: g.lastError, ReadingsTotal: g.total, State: "waiting"}
	for _, r := range g.latest {
		s.DemandAmps += r.Amps
	}
	live := g.grants[:0]
	for _, grant := range g.grants {
		if !grant.expires.After(now) {
			continue
		}
		live = append(live, grant)
		if grant.amps > s.GrantedAmps || (grant.amps == s.GrantedAmps && grant.expires.Sub(now).Milliseconds() > s.LeaseRemainingMS) {
			s.GrantedAmps = grant.amps
			s.LeaseRemainingMS = grant.expires.Sub(now).Milliseconds()
			s.LeaseVersion = grant.version
		}
	}
	g.grants = live
	s.ServedAmps = math.Min(s.DemandAmps, float64(s.GrantedAmps))
	if s.LeaseRemainingMS > 0 {
		s.State = "active"
		if s.DemandAmps > float64(s.GrantedAmps) {
			s.State = "limited"
		}
	} else if g.hadGrant {
		s.State = "expired"
	}
	return s
}

func (g *Gateway) Status() GatewayStatus {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.statusLocked(g.now())
}

// ApplyGrant always uses the original request start, including retry replies. A reply can
// never move a previous request's deadline forward. Separate grants retain separate deadlines.
func (g *Gateway) ApplyGrant(req GrantRequest, started time.Time, response GrantResponse) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !response.Accepted {
		return fmt.Errorf("grant refused: %s", response.Reason)
	}
	if req.BuildingID != g.cfg.BuildingID || req.SessionID != g.session || response.RequestID != req.RequestID || response.Lease.BuildingID != req.BuildingID || response.Lease.SessionID != req.SessionID || response.Lease.Amps < 0 || response.Lease.Amps > 1000000 || response.Lease.Version == 0 || response.LeaseMS <= 0 || response.LeaseMS > LeaseTTL.Milliseconds() {
		return errors.New("invalid or mismatched grant response")
	}
	expires := started.Add(time.Duration(response.LeaseMS)*time.Millisecond - g.cfg.SafetyMargin)
	if !expires.After(g.now()) {
		return errors.New("grant response arrived after safe deadline")
	}
	// A repeated reply may add an identical entry but never extend its lifetime.
	for _, grant := range g.grants {
		if grant.version == response.Lease.Version && grant.expires.Equal(expires) && grant.amps == response.Lease.Amps {
			return nil
		}
	}
	g.grants = append(g.grants, localGrant{response.Lease.Amps, response.Lease.Version, expires})
	g.hadGrant = true
	g.lastError = ""
	return nil
}

func (g *Gateway) allowedRedirect(location, endpoint string) (string, bool) {
	u, err := url.Parse(location)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != endpoint {
		return "", false
	}
	for _, base := range g.cfg.Coordinators {
		if u.Scheme+"://"+u.Host == base {
			return u.String(), true
		}
	}
	return "", false
}

func (g *Gateway) post(ctx context.Context, endpoint string, payload any) ([]byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	next := ""
	var last error
	for attempt := 0; attempt < 3; attempt++ {
		target := next
		if target == "" {
			target = g.cfg.Coordinators[attempt%len(g.cfg.Coordinators)] + endpoint
		}
		next = ""
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		res, err := g.client.Do(req)
		if err != nil {
			last = err
			continue
		}
		data, readErr := io.ReadAll(io.LimitReader(res.Body, 65537))
		res.Body.Close()
		if readErr != nil || len(data) > 65536 {
			last = errors.New("invalid coordinator body")
			continue
		}
		if res.StatusCode == http.StatusTemporaryRedirect {
			var ok bool
			next, ok = g.allowedRedirect(res.Header.Get("Location"), endpoint)
			if !ok {
				last = errors.New("coordinator redirected outside configured allowlist")
				continue
			}
			last = errors.New("coordinator redirect")
			continue
		}
		if res.StatusCode >= 200 && res.StatusCode < 300 {
			return data, nil
		}
		last = fmt.Errorf("coordinator HTTP %d: %.200s", res.StatusCode, string(data))
	}
	return nil, last
}

func (g *Gateway) Renew(ctx context.Context) error {
	g.renewMu.Lock()
	defer g.renewMu.Unlock()
	g.mu.Lock()
	now := g.now()
	s := g.statusLocked(now)
	if !g.lastAttempt.IsZero() && now.Sub(g.lastAttempt) < 3*time.Second && int(math.Ceil(s.DemandAmps)) <= s.GrantedAmps {
		g.mu.Unlock()
		return nil
	}
	g.lastAttempt = now
	req := GrantRequest{NewID(), g.cfg.BuildingID, g.session, int(math.Ceil(s.DemandAmps))}
	g.mu.Unlock()
	data, err := g.post(ctx, "/api/grants", req)
	if err == nil {
		var response GrantResponse
		err = json.Unmarshal(data, &response)
		if err == nil {
			err = g.ApplyGrant(req, now, response)
		}
	}
	if err != nil {
		g.SetError(err)
	}
	return err
}

// Flush keeps the original head until a successful SQL batch acknowledgement. The
// queue drops new arrivals when full, so an in-flight batch cannot shift underneath it.
func (g *Gateway) Flush(ctx context.Context) error {
	g.flushMu.Lock()
	defer g.flushMu.Unlock()
	g.mu.Lock()
	n := len(g.pending)
	if n > 500 {
		n = 500
	}
	batch := append([]Reading(nil), g.pending[:n]...)
	g.mu.Unlock()
	if n == 0 {
		return nil
	}
	_, err := g.post(ctx, "/api/readings", struct {
		Readings []Reading `json:"readings"`
	}{batch})
	if err != nil {
		g.SetError(err)
		return err
	}
	g.mu.Lock()
	g.pending = append([]Reading(nil), g.pending[n:]...)
	g.mu.Unlock()
	return nil
}

func (g *Gateway) Run(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = g.Flush(ctx)
			}
		}
	}()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = g.Renew(ctx)
		}
	}
}

func (g *Gateway) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(g.Status())
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	return mux
}

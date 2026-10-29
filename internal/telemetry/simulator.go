package telemetry

import (
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"math"
	"net/http"
	"sync"
	"time"
)

type SimulatorConfig struct {
	MeterCount   int     `json:"meter_count"`
	DemandFactor float64 `json:"demand_factor"`
}

type Simulator struct {
	mu        sync.Mutex
	buildings []string
	config    SimulatorConfig
	session   string
	sequence  uint64
	connected bool
	published uint64
	demand    float64
}

func NewSimulator(buildings []string, meterCount int) (*Simulator, error) {
	if len(buildings) == 0 || meterCount < 1 || meterCount > 1000 {
		return nil, errors.New("buildings required; meter count must be 1..1000")
	}
	seen := make(map[string]bool)
	for _, b := range buildings {
		if b == "" || seen[b] {
			return nil, errors.New("building IDs must be nonempty and unique")
		}
		seen[b] = true
	}
	return &Simulator{buildings: append([]string(nil), buildings...), config: SimulatorConfig{meterCount, 1}, session: NewID()}, nil
}

func (s *Simulator) SetConnected(v bool) { s.mu.Lock(); defer s.mu.Unlock(); s.connected = v }
func (s *Simulator) Published()          { s.mu.Lock(); defer s.mu.Unlock(); s.published++ }

// Demand is reproducible for a meter and sample sequence. Only the session ID varies
// across restarts, keeping reading IDs unique without introducing random load noise.
func SyntheticDemand(meter string, sequence uint64, factor float64) float64 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(meter))
	phase := float64(h.Sum32()%6283) / 1000
	demand := (1.5 + 0.65*math.Sin(float64(sequence)/12+phase) + 0.15*math.Cos(float64(sequence)/5+phase)) * factor
	return math.Round(demand*1000) / 1000
}

func (s *Simulator) Readings(now time.Time) []Reading {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sequence++
	s.demand = 0
	readings := make([]Reading, s.config.MeterCount)
	for i := range readings {
		building := s.buildings[i%len(s.buildings)]
		meter := fmt.Sprintf("%s-meter-%04d", building, i+1)
		amps := SyntheticDemand(meter, s.sequence, s.config.DemandFactor)
		s.demand += amps
		readings[i] = Reading{fmt.Sprintf("%s/%s/%d", s.session, meter, s.sequence), building, meter, amps, now.UTC()}
	}
	return readings
}

func (s *Simulator) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(struct {
			SimulatorConfig
			Buildings         []string `json:"buildings"`
			MQTTConnected     bool     `json:"mqtt_connected"`
			PublishedReadings uint64   `json:"published_readings"`
			DemandAmps        float64  `json:"demand_amps"`
		}{s.config, s.buildings, s.connected, s.published, s.demand})
	})
	mux.HandleFunc("POST /api/config", func(w http.ResponseWriter, r *http.Request) {
		var update struct {
			MeterCount   *int     `json:"meter_count"`
			DemandFactor *float64 `json:"demand_factor"`
		}
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&update); err != nil {
			http.Error(w, "invalid configuration JSON", http.StatusBadRequest)
			return
		}
		if err := dec.Decode(&struct{}{}); err != io.EOF {
			http.Error(w, "exactly one configuration required", http.StatusBadRequest)
			return
		}
		if update.MeterCount == nil && update.DemandFactor == nil || update.MeterCount != nil && (*update.MeterCount < 1 || *update.MeterCount > 1000) || update.DemandFactor != nil && (math.IsNaN(*update.DemandFactor) || math.IsInf(*update.DemandFactor, 0) || *update.DemandFactor < 0 || *update.DemandFactor > 3) {
			http.Error(w, "meter_count must be 1..1000 and demand_factor 0..3", http.StatusBadRequest)
			return
		}
		s.mu.Lock()
		if update.MeterCount != nil {
			s.config.MeterCount = *update.MeterCount
		}
		if update.DemandFactor != nil {
			s.config.DemandFactor = *update.DemandFactor
		}
		config := s.config
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(config)
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	return mux
}

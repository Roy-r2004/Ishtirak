package telemetry

import (
	"crypto/rand"
	"encoding/hex"
	"time"
)

const LeaseTTL = 12 * time.Second

type Reading struct {
	ReadingID  string    `json:"reading_id"`
	BuildingID string    `json:"building_id"`
	MeterID    string    `json:"meter_id"`
	Amps       float64   `json:"amps"`
	ObservedAt time.Time `json:"observed_at"`
}

type GrantRequest struct {
	RequestID  string `json:"request_id"`
	BuildingID string `json:"building_id"`
	SessionID  string `json:"session_id"`
	Amps       int    `json:"amps"`
}

type Lease struct {
	BuildingID string `json:"building_id"`
	SessionID  string `json:"session_id"`
	Amps       int    `json:"amps"`
	Version    uint64 `json:"version"`
}

type GrantResponse struct {
	Accepted  bool   `json:"accepted"`
	Reason    string `json:"reason"`
	RequestID string `json:"request_id"`
	LeaseMS   int64  `json:"lease_ms"`
	Lease     Lease  `json:"lease"`
}

func NewID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return hex.EncodeToString(b[:4]) + "-" + hex.EncodeToString(b[4:6]) + "-" + hex.EncodeToString(b[6:8]) + "-" + hex.EncodeToString(b[8:10]) + "-" + hex.EncodeToString(b[10:])
}

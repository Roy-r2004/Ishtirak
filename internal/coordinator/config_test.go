package coordinator

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestLeaseProtocolConfig(t *testing.T) {
	// Reset the environment inputs that could affect otherwise valid defaults.
	for _, key := range []string{"NODE_ID", "PEERS", "HTTP_PEERS", "CAPACITY_AMPS"} {
		t.Setenv(key, "")
	}
	for _, tc := range []struct {
		name, input string
		valid       bool
	}{
		{"default", "", true},
		{"explicit protocol duration", "12000", true},
		{"shorter successor would reclaim early", "5000", false},
		{"longer duration also differs across nodes", "24000", false},
		{"malformed", "twelve", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("LEASE_MS", tc.input)
			cfg, err := EnvConfig()
			if tc.valid {
				if err != nil || cfg.Lease != 12*time.Second {
					t.Fatalf("lease=%s err=%v", cfg.Lease, err)
				}
			} else if err == nil || !strings.Contains(err.Error(), "fixed cross-node protocol constant") {
				t.Fatalf("expected clear configuration rejection, got %v", err)
			}
		})
	}
}

func TestNewRejectsNonProtocolLeaseBeforeStartup(t *testing.T) {
	for _, duration := range []time.Duration{0, 5 * time.Second, 24 * time.Second} {
		_, err := New(context.Background(), Config{Lease: duration})
		if err == nil || !strings.Contains(err.Error(), "LEASE_MS must equal 12000") {
			t.Fatalf("duration=%s expected lease rejection before opening disk/network, got %v", duration, err)
		}
	}
}

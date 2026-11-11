package coordinator

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ishtirak/internal/ledger"
)

// The author's tests never run Server.expirations (it needs a 12 s hold). These run the REAL loop against a
// single-node in-memory Raft with a short hold.
func startLoop(t *testing.T, s *Server, ttl time.Duration) context.CancelFunc {
	t.Helper()
	s.deadlines = NewDeadlines(ttl)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.expirations(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return cancel
}

func TestAdversarialExpirationsLoopReallyExpiresWantsAndTiers(t *testing.T) {
	s := newTestServer(t, true)
	startLoop(t, s, 300*time.Millisecond)
	if w := post(s.grant, "/api/grants", `{"request_id":"r1","building_id":"x","session_id":"s","amps":100}`); w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if v := s.fsm.View(); len(v.Wants) != 1 || len(v.Leases) != 1 {
		t.Fatalf("setup: %+v", v)
	}
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if v := s.fsm.View(); len(v.Wants) == 0 && len(v.Leases) == 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	v := s.fsm.View()
	t.Fatalf("silent building's want/lease never expired by the real loop: wants=%v leases=%v", v.Wants, v.Leases)
}

// Concurrent handlers, policy flips, status and the real loop under the race detector.
func TestAdversarialConcurrentHandlersPolicyFlipsAndLoop(t *testing.T) {
	s := newTestServer(t, true)
	startLoop(t, s, 200*time.Millisecond)
	stop := make(chan struct{})
	var wg sync.WaitGroup
	var bad atomic.Int64
	for g := 0; g < 4; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; ; i++ {
				select {
				case <-stop:
					return
				default:
				}
				post(s.grant, "/api/grants", fmt.Sprintf(`{"request_id":"g%d-%d","building_id":"b%d","session_id":"s","amps":%d}`, g, i, g%3, 10+(i*7)%200))
				if v := s.fsm.View(); ledger.Granted(v) > v.Capacity {
					bad.Add(1)
				}
			}
		}(g)
	}
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			post(s.policy, "/api/policy", []string{`{"policy":"first_come"}`, `{"policy":"fair_share"}`}[i%2])
			time.Sleep(15 * time.Millisecond)
		}
	}()
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			_ = s.Status()
		}
	}()
	time.Sleep(4 * time.Second)
	close(stop)
	wg.Wait()
	if bad.Load() != 0 {
		t.Fatalf("capacity exceeded %d times", bad.Load())
	}
}

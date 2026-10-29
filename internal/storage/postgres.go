// Package storage projects committed events into SQL. SQL is never consulted
// when granting or reclaiming capacity; the durable Raft outbox is replayable.
package storage

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"ishtirak/internal/ledger"
)

type Reading struct {
	ReadingID  string    `json:"reading_id"`
	BuildingID string    `json:"building_id"`
	MeterID    string    `json:"meter_id"`
	Amps       float64   `json:"amps"`
	ObservedAt time.Time `json:"observed_at"`
}
type Store struct {
	pool      *pgxpool.Pool
	connected atomic.Bool
	mu        sync.RWMutex
	latest    []Reading
}

func Open(ctx context.Context, url string) (*Store, error) {
	if url == "" {
		return &Store{}, nil
	}
	p, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, err
	}
	return &Store{pool: p, latest: []Reading{}}, nil
}
func (s *Store) Close() {
	if s.pool != nil {
		s.pool.Close()
	}
}
func (s *Store) Connected() bool { return s.connected.Load() }
func (s *Store) Latest() []Reading {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]Reading{}, s.latest...)
}
func (s *Store) ensure(ctx context.Context) error {
	if s.pool == nil {
		return errors.New("postgres unavailable")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(8446621)`)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS audit_events(event_id bigint PRIMARY KEY, payload jsonb NOT NULL);
 CREATE TABLE IF NOT EXISTS readings(reading_id text PRIMARY KEY,building_id text NOT NULL,meter_id text NOT NULL,amps double precision NOT NULL,observed_at timestamptz NOT NULL);
 CREATE INDEX IF NOT EXISTS readings_latest_idx ON readings(building_id,meter_id,observed_at DESC)`)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Run keeps a process-local cursor only. Restart replays the complete retained
// outbox; ON CONFLICT makes that safe even after snapshots or concurrent writers.
func (s *Store) Run(ctx context.Context, fsm *ledger.FSM, canExport func() bool) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	cursor := uint64(0)
	initialized := false
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			op, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
			err := error(nil)
			if !initialized {
				err = s.ensure(op)
				initialized = err == nil
			}
			if err == nil && s.pool != nil {
				err = s.pool.Ping(op)
			}
			if err == nil && s.pool != nil && canExport != nil && canExport() {
				// Only the observed leader projects committed events. A leadership
				// change during a transaction remains harmless through idempotency.
				events := fsm.EventsAfter(cursor, 1000)
				if len(events) > 0 {
					tx, e := s.pool.Begin(op)
					err = e
					if e == nil {
						for _, event := range events {
							b, _ := json.Marshal(event)
							_, err = tx.Exec(op, `INSERT INTO audit_events(event_id,payload) VALUES($1,$2) ON CONFLICT(event_id) DO NOTHING`, event.EventID, b)
							if err != nil {
								break
							}
						}
						if err == nil {
							err = tx.Commit(op)
						} else {
							_ = tx.Rollback(op)
						}
						if err == nil {
							cursor = events[len(events)-1].EventID
						}
					}
				}
			}
			if err == nil && s.pool != nil {
				err = s.refresh(op)
			}
			s.connected.Store(err == nil && s.pool != nil)
			cancel()
		}
	}
}
func ValidateReadings(a []Reading) error {
	if len(a) == 0 || len(a) > 500 {
		return errors.New("readings batch must contain 1..500 entries")
	}
	for _, r := range a {
		if r.ReadingID == "" || r.BuildingID == "" || r.MeterID == "" || len(r.ReadingID) > 128 || len(r.BuildingID) > 128 || len(r.MeterID) > 128 || r.ObservedAt.IsZero() || math.IsNaN(r.Amps) || math.IsInf(r.Amps, 0) || r.Amps < 0 || r.Amps > 100000 {
			return errors.New("invalid reading")
		}
	}
	return nil
}
func (s *Store) InsertReadings(ctx context.Context, a []Reading) error {
	if err := ValidateReadings(a); err != nil {
		return err
	}
	if s.pool == nil {
		return errors.New("postgres unavailable")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		s.connected.Store(false)
		return err
	}
	defer tx.Rollback(ctx)
	for _, r := range a {
		_, err = tx.Exec(ctx, `INSERT INTO readings(reading_id,building_id,meter_id,amps,observed_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(reading_id) DO NOTHING`, r.ReadingID, r.BuildingID, r.MeterID, r.Amps, r.ObservedAt)
		if err != nil {
			s.connected.Store(false)
			return err
		}
	}
	err = tx.Commit(ctx)
	s.connected.Store(err == nil)
	return err
}
func (s *Store) refresh(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `SELECT reading_id,building_id,meter_id,amps,observed_at FROM (SELECT DISTINCT ON(building_id,meter_id) reading_id,building_id,meter_id,amps,observed_at FROM readings ORDER BY building_id,meter_id,observed_at DESC,reading_id DESC) latest LIMIT 1000`)
	if err != nil {
		return err
	}
	defer rows.Close()
	a := []Reading{}
	for rows.Next() {
		var r Reading
		if err = rows.Scan(&r.ReadingID, &r.BuildingID, &r.MeterID, &r.Amps, &r.ObservedAt); err != nil {
			return err
		}
		a = append(a, r)
	}
	if err = rows.Err(); err != nil {
		return err
	}
	sort.Slice(a, func(i, j int) bool {
		if a[i].BuildingID == a[j].BuildingID {
			return a[i].MeterID < a[j].MeterID
		}
		return a[i].BuildingID < a[j].BuildingID
	})
	s.mu.Lock()
	s.latest = a
	s.mu.Unlock()
	return nil
}

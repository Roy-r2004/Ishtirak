package storage

import (
	"context"
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Run against a disposable PostgreSQL instance with POSTGRES_TEST_URL set.
// All fixtures live in a unique schema, independent of any existing data.
func TestPostgresLatestIntegration(t *testing.T) {
	url := os.Getenv("POSTGRES_TEST_URL")
	if url == "" {
		t.Skip("POSTGRES_TEST_URL is not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("storage_test_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := admin.Exec(ctx, "DROP SCHEMA "+quoted+" CASCADE"); err != nil {
			t.Error(err)
		}
	}()
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	s := &Store{pool: pool}
	if err := s.ensure(ctx); err != nil {
		t.Fatal(err)
	}
	exec := func(t *testing.T, sql string) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	refresh := func(t *testing.T) {
		t.Helper()
		if err := s.refresh(ctx); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("empty", func(t *testing.T) {
		refresh(t)
		if len(s.Latest()) != 0 {
			t.Fatal("expected empty latest readings")
		}
	})
	t.Run("history ties buildings duplicates", func(t *testing.T) {
		at := time.Now().UTC().Truncate(time.Microsecond)
		rows := []Reading{
			{"new-a", "a", "m", 2, at}, {"new-z", "a", "m", 3, at},
			{"old", "a", "m", 1, at.Add(-time.Hour)},
			{"building-b", "b", "m", 4, at}, {"meter-n", "a", "n", 5, at},
		}
		if err := s.InsertReadings(ctx, rows); err != nil {
			t.Fatal(err)
		}
		if err := s.InsertReadings(ctx, rows); err != nil {
			t.Fatal(err)
		}
		refresh(t)
		got := s.Latest()
		if len(got) != 3 || got[0].ReadingID != "new-z" || got[1].ReadingID != "meter-n" || got[2].ReadingID != "building-b" {
			t.Fatalf("unexpected latest: %+v", got)
		}
		var count int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM readings").Scan(&count); err != nil || count != 5 {
			t.Fatalf("history/duplicate count=%d err=%v", count, err)
		}
	})
	t.Run("query failure retains cache and connectivity", func(t *testing.T) {
		if err := s.probe(ctx); err != nil {
			t.Fatal(err)
		}
		before := s.Latest()
		canceled, cancel := context.WithCancel(ctx)
		cancel()
		if err := s.refresh(canceled); err == nil {
			t.Fatal("expected canceled refresh")
		}
		if err := s.InsertReadings(canceled, []Reading{{"canceled", "a", "m", 1, time.Now()}}); err == nil {
			t.Fatal("expected canceled insert")
		}
		if !s.Connected() || !reflect.DeepEqual(before, s.Latest()) {
			t.Fatal("query failure changed connectivity or cache")
		}
		if err := s.probe(canceled); err == nil || s.Connected() {
			t.Fatal("failed probe did not update connectivity")
		}
		if err := s.probe(ctx); err != nil || !s.Connected() {
			t.Fatal("probe did not recover")
		}
	})
	t.Run("bounded deterministic keys", func(t *testing.T) {
		exec(t, "TRUNCATE readings")
		exec(t, `INSERT INTO readings SELECT 'r'||n,'building',lpad(n::text,4,'0'),1,now() FROM generate_series(1,1005) n`)
		refresh(t)
		got := s.Latest()
		if len(got) != 1000 || got[0].MeterID != "0001" || got[999].MeterID != "1000" {
			t.Fatalf("wrong first1000 keys: count %d", len(got))
		}
	})
	t.Run("million reading history", func(t *testing.T) {
		exec(t, "TRUNCATE readings")
		exec(t, `INSERT INTO readings SELECT 'history-'||n,'building',(n%50)::text,1,'2026-01-01'::timestamptz+n*interval '1 second' FROM generate_series(1,1300000) n`)
		exec(t, "ANALYZE readings")
		budget, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
		defer cancel()
		start := time.Now()
		if err := s.refresh(budget); err != nil {
			t.Fatal(err)
		}
		t.Logf("1,300,000 historical readings, 50 meters: refresh %s", time.Since(start))
		got := s.Latest()
		if len(got) != 50 {
			t.Fatalf("got %d latest readings", len(got))
		}
		for _, r := range got {
			if r.ObservedAt.Before(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).Add(1299951 * time.Second)) {
				t.Fatalf("not newest: %+v", r)
			}
		}
	})
}

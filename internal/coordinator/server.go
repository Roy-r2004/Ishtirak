package coordinator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hashicorp/raft"
	raftboltdb "github.com/hashicorp/raft-boltdb/v2"
	"ishtirak/internal/ledger"
	"ishtirak/internal/storage"
)

type Config struct {
	NodeID, HTTPAddr, RaftAddr, RaftBind, DataDir, DatabaseURL string
	Peers, HTTPPeers                                           map[string]string
	Bootstrap                                                  bool
	Capacity                                                   int
	Lease                                                      time.Duration
}

// LeaseDuration is a protocol constant shared by every coordinator. Allowing a
// shorter duration on a successor leader could reclaim an inherited lease while
// the original gateway still considers its grant usable.
const LeaseDuration = 12 * time.Second

const leaseConfigError = "LEASE_MS must equal 12000; the lease duration is a fixed cross-node protocol constant"

func EnvConfig() (Config, error) {
	env := func(k, d string) string {
		if v := os.Getenv(k); v != "" {
			return v
		}
		return d
	}
	c := Config{NodeID: env("NODE_ID", "coordinator1"), HTTPAddr: env("HTTP_ADDR", ":8080"), RaftAddr: env("RAFT_ADDR", "coordinator1:9000"), RaftBind: env("RAFT_BIND", ":9000"), DataDir: env("DATA_DIR", "/data"), DatabaseURL: os.Getenv("DATABASE_URL"), Peers: map[string]string{}, HTTPPeers: map[string]string{}, Bootstrap: os.Getenv("BOOTSTRAP") == "true"}
	var err error
	c.Capacity, err = strconv.Atoi(env("CAPACITY_AMPS", "120"))
	if err != nil || c.Capacity <= 0 || c.Capacity > 1000000 {
		return c, errors.New("invalid CAPACITY_AMPS")
	}
	ms, err := strconv.Atoi(env("LEASE_MS", "12000"))
	if err != nil || ms != int(LeaseDuration/time.Millisecond) {
		return c, errors.New(leaseConfigError)
	}
	c.Lease = LeaseDuration
	for _, p := range strings.Split(env("PEERS", "coordinator1=coordinator1:9000,coordinator2=coordinator2:9000,coordinator3=coordinator3:9000"), ",") {
		a, b, ok := strings.Cut(p, "=")
		if !ok || a == "" || b == "" {
			return c, errors.New("invalid PEERS")
		}
		c.Peers[a] = b
	}
	for _, p := range strings.Split(env("HTTP_PEERS", "coordinator1=http://coordinator1:8080,coordinator2=http://coordinator2:8080,coordinator3=http://coordinator3:8080"), ",") {
		a, b, ok := strings.Cut(p, "=")
		if !ok {
			return c, errors.New("invalid HTTP_PEERS")
		}
		c.HTTPPeers[a] = b
	}
	if len(c.Peers) != 3 || c.Peers[c.NodeID] == "" {
		return c, errors.New("exactly three configured voting coordinators required")
	}
	return c, nil
}

type proof struct {
	term string
	at   time.Time
	ok   bool
}
type Server struct {
	cfg       Config
	raft      *raft.Raft
	fsm       *ledger.FSM
	store     *storage.Store
	transport *raft.NetworkTransport
	bolt      *raftboltdb.BoltStore
	http      *http.Server
	op        sync.Mutex
	deadlines *Deadlines
	verified  atomic.Value
}

func New(ctx context.Context, c Config) (*Server, error) {
	if c.Lease != LeaseDuration {
		return nil, errors.New(leaseConfigError)
	}
	if c.Capacity <= 0 || c.Capacity > 1000000 {
		return nil, errors.New("invalid CAPACITY_AMPS")
	}
	if err := os.MkdirAll(c.DataDir, 0700); err != nil {
		return nil, err
	}
	fsm := ledger.New()
	bolt, err := raftboltdb.NewBoltStore(filepath.Join(c.DataDir, "raft.db"))
	if err != nil {
		return nil, err
	}
	snapshots, err := raft.NewFileSnapshotStore(c.DataDir, 2, os.Stderr)
	if err != nil {
		bolt.Close()
		return nil, err
	}
	addr, err := net.ResolveTCPAddr("tcp", c.RaftAddr)
	if err != nil {
		bolt.Close()
		return nil, err
	}
	transport, err := raft.NewTCPTransport(c.RaftBind, addr, 5, 2*time.Second, os.Stderr)
	if err != nil {
		bolt.Close()
		return nil, err
	}
	conf := raft.DefaultConfig()
	conf.LocalID = raft.ServerID(c.NodeID)
	conf.HeartbeatTimeout = time.Second
	conf.ElectionTimeout = time.Second
	conf.LeaderLeaseTimeout = 500 * time.Millisecond
	conf.CommitTimeout = 50 * time.Millisecond
	conf.SnapshotThreshold = 1024
	conf.SnapshotInterval = 20 * time.Second
	existing, err := raft.HasExistingState(bolt, bolt, snapshots)
	if err != nil {
		transport.Close()
		bolt.Close()
		return nil, err
	}
	r, err := raft.NewRaft(conf, fsm, bolt, bolt, snapshots, transport)
	if err != nil {
		transport.Close()
		bolt.Close()
		return nil, err
	}
	if c.Bootstrap && !existing {
		configuration := raft.Configuration{}
		ids := []string{}
		for id := range c.Peers {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			configuration.Servers = append(configuration.Servers, raft.Server{Suffrage: raft.Voter, ID: raft.ServerID(id), Address: raft.ServerAddress(c.Peers[id])})
		}
		if err = r.BootstrapCluster(configuration).Error(); err != nil {
			r.Shutdown()
			transport.Close()
			bolt.Close()
			return nil, err
		}
	}
	store, err := storage.Open(ctx, c.DatabaseURL)
	if err != nil {
		r.Shutdown()
		transport.Close()
		bolt.Close()
		return nil, err
	}
	s := &Server{cfg: c, raft: r, fsm: fsm, store: store, transport: transport, bolt: bolt, deadlines: NewDeadlines(c.Lease)}
	s.verified.Store(proof{})
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/grants", s.grant)
	mux.HandleFunc("POST /api/readings", s.readings)
	mux.HandleFunc("GET /api/status", s.status)
	mux.HandleFunc("GET /api/ws", s.websocket)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "node_id": c.NodeID})
	})
	s.http = &http.Server{Addr: c.HTTPAddr, Handler: mux, ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 8 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	return s, nil
}
func (s *Server) Run(ctx context.Context) error {
	go s.store.Run(ctx, s.fsm, func() bool { return s.raft.State() == raft.Leader })
	go s.expirations(ctx)
	go s.quorum(ctx)
	return s.http.ListenAndServe()
}
func (s *Server) Close(ctx context.Context) error {
	_ = s.http.Shutdown(ctx)
	err := s.raft.Shutdown().Error()
	_ = s.transport.Close()
	_ = s.bolt.Close()
	s.store.Close()
	return err
}
func (s *Server) syncDeadlines(now time.Time) (string, bool) {
	term := s.raft.Stats()["term"]
	active := s.raft.State() == raft.Leader
	s.deadlines.Observe(term, active, s.fsm.View().Leases, now)
	return term, active
}

// The initial leader proposes configuration through consensus. Subsequent
// leaders use the committed value even when their environment differs.
func (s *Server) ensureCapacity() error {
	if s.fsm.View().Initialized {
		return nil
	}
	result, err := s.apply(ledger.Command{Kind: "init_capacity", Capacity: s.cfg.Capacity})
	if err != nil {
		return err
	}
	if !s.fsm.View().Initialized {
		return fmt.Errorf("capacity initialization refused: %s", result.Reason)
	}
	return nil
}
func (s *Server) expirations(ctx context.Context) {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.raft.LeaderCh():
			s.op.Lock()
			s.deadlines.Reset()
			s.op.Unlock()
		case <-ticker.C:
			s.op.Lock()
			term, active := s.syncDeadlines(time.Now())
			if active {
				if err := s.ensureCapacity(); err != nil {
					s.op.Unlock()
					continue
				}
				due := s.deadlines.Due(time.Now())
				for id, version := range due {
					freshTerm, leader := s.syncDeadlines(time.Now())
					if !leader || freshTerm != term {
						break
					}
					state := s.fsm.View()
					l, ok := state.Leases[id]
					if !ok || l.Version != version {
						continue
					}
					n, _ := strconv.ParseUint(term, 10, 64)
					_, err := s.apply(ledger.Command{Kind: "expire", BuildingID: id, ExpectedVersion: version, ExpectedTerm: n, OccurredAt: time.Now().UTC().Format(time.RFC3339Nano)})
					if err != nil {
						break
					}
					s.syncDeadlines(time.Now())
				}
			}
			s.op.Unlock()
		}
	}
}
func (s *Server) quorum(ctx context.Context) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			term := s.raft.Stats()["term"]
			ok := s.raft.State() == raft.Leader
			if ok {
				ok = s.raft.VerifyLeader().Error() == nil
			}
			s.verified.Store(proof{term: term, at: time.Now(), ok: ok})
		}
	}
}
func (s *Server) apply(c ledger.Command) (ledger.Result, error) {
	b, err := json.Marshal(c)
	if err != nil {
		return ledger.Result{}, err
	}
	f := s.raft.Apply(b, 2*time.Second)
	if err = f.Error(); err != nil {
		return ledger.Result{}, err
	}
	result, ok := f.Response().(ledger.Result)
	if !ok {
		return ledger.Result{}, errors.New("unexpected FSM response")
	}
	return result, nil
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func decode(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 256*1024)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(v); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("exactly one JSON object required")
	}
	return nil
}
func (s *Server) redirect(w http.ResponseWriter, r *http.Request) bool {
	if s.raft.State() == raft.Leader {
		return false
	}
	_, id := s.raft.LeaderWithID()
	url := s.cfg.HTTPPeers[string(id)]
	if url != "" {
		http.Redirect(w, r, url+r.URL.RequestURI(), http.StatusTemporaryRedirect)
	} else {
		writeJSON(w, 503, map[string]string{"error": "no elected leader"})
	}
	return true
}
func (s *Server) grant(w http.ResponseWriter, r *http.Request) {
	var request ledger.Request
	if err := decode(w, r, &request); err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	if request.RequestID == "" || request.BuildingID == "" || request.SessionID == "" || len(request.RequestID) > 128 || len(request.BuildingID) > 128 || len(request.SessionID) > 128 || request.Amps <= 0 || request.Amps > 1000000 {
		writeJSON(w, 400, map[string]string{"error": "invalid grant request"})
		return
	}
	s.op.Lock()
	defer s.op.Unlock()
	if s.redirect(w, r) {
		return
	}
	_, active := s.syncDeadlines(time.Now())
	if !active {
		writeJSON(w, 503, map[string]string{"error": "leadership changed"})
		return
	}
	if err := s.ensureCapacity(); err != nil {
		writeJSON(w, 503, map[string]string{"error": "capacity initialization unavailable; retry the same request_id"})
		return
	}
	result, err := s.apply(ledger.Command{Kind: "grant", Request: request, OccurredAt: time.Now().UTC().Format(time.RFC3339Nano)})
	if err != nil {
		writeJSON(w, 503, map[string]string{"error": "commit outcome unknown; retry the same request_id"})
		return
	}
	s.syncDeadlines(time.Now())
	writeJSON(w, 200, struct {
		ledger.Result
		LeaseMS int64 `json:"lease_ms"`
	}{result, s.cfg.Lease.Milliseconds()})
}
func (s *Server) readings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Readings []storage.Reading `json:"readings"`
	}
	if err := decode(w, r, &body); err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	if err := storage.ValidateReadings(body.Readings); err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := s.store.InsertReadings(ctx, body.Readings); err != nil {
		writeJSON(w, 503, map[string]string{"error": "readings not acknowledged; retry same reading IDs"})
		return
	}
	writeJSON(w, 200, map[string]any{"accepted": true, "count": len(body.Readings)})
}
func (s *Server) Status() map[string]any {
	state := s.fsm.View()
	stats := s.raft.Stats()
	_, id := s.raft.LeaderWithID()
	p := s.verified.Load().(proof)
	isLeader := s.raft.State() == raft.Leader
	verified := p.ok && isLeader && p.term == stats["term"] && time.Since(p.at) < 1500*time.Millisecond
	audit := state.Events
	if len(audit) > 100 {
		audit = audit[len(audit)-100:]
	}
	granted := ledger.Granted(state)
	return map[string]any{"node_id": s.cfg.NodeID, "state": s.raft.State().String(), "leader_id": string(id), "leader_url": s.cfg.HTTPPeers[string(id)], "quorum": verified, "quorum_verified_at": p.at.UTC().Format(time.RFC3339Nano), "capacity_amps": state.Capacity, "initialized": state.Initialized, "granted_amps": granted, "available_amps": state.Capacity - granted, "leases": ledger.SortedLeases(state), "audit": audit, "postgres_connected": s.store.Connected(), "latest_readings": s.store.Latest(), "raft": stats, "lease_ms": s.cfg.Lease.Milliseconds()}
}
func (s *Server) status(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, s.Status()) }

var upgrader = websocket.Upgrader{ReadBufferSize: 1024, WriteBufferSize: 4096}

func (s *Server) websocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		_ = conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
		if err = conn.WriteJSON(s.Status()); err != nil {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}
	}
}
func (s *Server) String() string {
	return fmt.Sprintf("%s HTTP %s Raft %s", s.cfg.NodeID, s.cfg.HTTPAddr, s.cfg.RaftAddr)
}

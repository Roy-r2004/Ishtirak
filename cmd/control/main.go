// The local demo controller can only start/stop this project's allowlisted services.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

var services = map[string]string{
	"coordinator1": "coordinator1", "coordinator2": "coordinator2", "coordinator3": "coordinator3",
	"gateway-hamra": "gateway-hamra", "gateway-mar-mikhael": "gateway-mar-mikhael", "gateway-achrafieh": "gateway-achrafieh",
	"meters": "meters", "postgres": "postgres", "mosquitto": "mosquitto",
}
var client = &http.Client{Timeout: 1800 * time.Millisecond}
var docker = &http.Client{Timeout: 12 * time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "unix", "/var/run/docker.sock")
}}}

type source struct {
	ID     string          `json:"id"`
	Online bool            `json:"online"`
	Data   json.RawMessage `json:"data,omitempty"`
	Error  string          `json:"error,omitempty"`
}

func fetch(id, address string) source {
	r, err := client.Get(address)
	if err != nil {
		return source{ID: id, Error: "Service unavailable"}
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return source{ID: id, Error: fmt.Sprintf("HTTP %d", r.StatusCode)}
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	if err != nil || !json.Valid(data) {
		return source{ID: id, Error: "Invalid service response"}
	}
	return source{ID: id, Online: true, Data: data}
}
func respond(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func overview(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		respond(w, 405, map[string]string{"error": "GET required"})
		return
	}
	nodes := make([]source, 3)
	buildings := make([]source, 3)
	var meters source
	var wg sync.WaitGroup
	for i, id := range []string{"coordinator1", "coordinator2", "coordinator3"} {
		wg.Add(1)
		go func(i int, id string) { defer wg.Done(); nodes[i] = fetch(id, "http://"+id+":8080/api/status") }(i, id)
	}
	for i, id := range []string{"hamra", "mar_mikhael", "achrafieh"} {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			host := "gateway-" + strings.ReplaceAll(id, "_", "-")
			buildings[i] = fetch(id, "http://"+host+":8080/api/status")
		}(i, id)
	}
	wg.Add(1)
	go func() { defer wg.Done(); meters = fetch("meters", "http://meters:8080/api/status") }()
	wg.Wait()
	respond(w, 200, map[string]any{"nodes": nodes, "buildings": buildings, "meters": meters, "observed_at": time.Now().UTC(), "demo_enabled": os.Getenv("ENABLE_DEMO") == "true"})
}
func validMutation(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != "POST" {
		respond(w, 405, map[string]string{"error": "POST required"})
		return false
	}
	if os.Getenv("ENABLE_DEMO") != "true" {
		respond(w, 403, map[string]string{"error": "Demo controls disabled"})
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Host != r.Host {
			respond(w, 403, map[string]string{"error": "Cross-origin control is not allowed"})
			return false
		}
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		respond(w, 415, map[string]string{"error": "JSON required"})
		return false
	}
	return true
}
func action(w http.ResponseWriter, r *http.Request) {
	if !validMutation(w, r) {
		return
	}
	var req struct {
		Service string `json:"service"`
		Action  string `json:"action"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&req) != nil {
		respond(w, 400, map[string]string{"error": "Invalid action"})
		return
	}
	service, ok := services[req.Service]
	if !ok || (req.Action != "stop" && req.Action != "start" && req.Action != "restart") {
		respond(w, 400, map[string]string{"error": "Service or action is not allowed"})
		return
	}
	name := "ishtirak-" + service
	inspect, err := docker.Get("http://docker/containers/" + name + "/json")
	if err != nil {
		respond(w, 503, map[string]string{"error": "Docker control unavailable"})
		return
	}
	defer inspect.Body.Close()
	var metadata struct {
		Config struct {
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
	}
	if inspect.StatusCode != 200 || json.NewDecoder(inspect.Body).Decode(&metadata) != nil || metadata.Config.Labels["com.docker.compose.project"] != "ishtirak" || metadata.Config.Labels["com.docker.compose.service"] != service {
		respond(w, 403, map[string]string{"error": "Container ownership check failed"})
		return
	}
	response, err := docker.Post("http://docker/containers/"+name+"/"+req.Action+"?t=1", "application/json", nil)
	if err != nil {
		respond(w, 503, map[string]string{"error": "Docker action failed"})
		return
	}
	defer response.Body.Close()
	if response.StatusCode != 204 && response.StatusCode != 304 {
		respond(w, 502, map[string]string{"error": fmt.Sprintf("Docker returned %d", response.StatusCode)})
		return
	}
	log.Printf("demo action=%s service=%s", req.Action, service)
	respond(w, 200, map[string]string{"service": service, "action": req.Action, "status": "complete"})
}
func meterConfig(w http.ResponseWriter, r *http.Request) {
	if !validMutation(w, r) {
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
	if err != nil || !json.Valid(body) {
		respond(w, 400, map[string]string{"error": "Invalid JSON"})
		return
	}
	req, _ := http.NewRequestWithContext(r.Context(), "POST", "http://meters:8080/api/config", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		respond(w, 503, map[string]string{"error": "Meter simulator unavailable"})
		return
	}
	defer res.Body.Close()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(res.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(res.Body, 8192))
}
func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/overview", overview)
	mux.HandleFunc("/api/actions", action)
	mux.HandleFunc("/api/meters/config", meterConfig)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, map[string]string{"status": "ok"}) })
	s := &http.Server{Addr: ":8080", Handler: mux, ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 15 * time.Second}
	log.Fatal(s.ListenAndServe())
}

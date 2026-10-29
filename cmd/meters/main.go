package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"ishtirak/internal/telemetry"
)

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func main() {
	count, err := strconv.Atoi(env("METER_COUNT", "50"))
	if err != nil {
		log.Fatal(err)
	}
	sim, err := telemetry.NewSimulator(strings.Split(env("BUILDINGS", "hamra,mar_mikhael,achrafieh"), ","), count)
	if err != nil {
		log.Fatal(err)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	opts := mqtt.NewClientOptions().AddBroker(env("MQTT_URL", "tcp://mosquitto:1883")).SetClientID("meters-" + telemetry.NewID()).SetCleanSession(true).SetAutoReconnect(true).SetConnectRetry(true).SetConnectRetryInterval(time.Second).SetKeepAlive(10 * time.Second).SetPingTimeout(2 * time.Second)
	opts.OnConnect = func(c mqtt.Client) { sim.SetConnected(true) }
	opts.OnConnectionLost = func(c mqtt.Client, err error) { sim.SetConnected(false); log.Printf("MQTT: %v", err) }
	client := mqtt.NewClient(opts)
	go func() {
		token := client.Connect()
		token.Wait()
		if token.Error() != nil {
			log.Printf("MQTT: %v", token.Error())
		}
	}()
	inflight := make(chan struct{}, 1024)
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				if !client.IsConnectionOpen() {
					continue
				}
				for _, r := range sim.Readings(now) {
					select {
					case inflight <- struct{}{}:
					default:
						continue
					}
					body, _ := json.Marshal(r)
					token := client.Publish("ishtirak/"+r.BuildingID+"/readings", 1, false, body)
					go func(token mqtt.Token) {
						defer func() { <-inflight }()
						select {
						case <-ctx.Done():
							return
						case <-token.Done():
							if token.Error() == nil {
								sim.Published()
							}
						}
					}(token)
				}
			}
		}
	}()
	server := &http.Server{Addr: env("HTTP_ADDR", ":8080"), Handler: sim.Handler(), ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	go func() {
		log.Printf("meters listening on %s", server.Addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("HTTP: %v", err)
			cancel()
		}
	}()
	<-ctx.Done()
	client.Disconnect(250)
	shutdown, done := context.WithTimeout(context.Background(), 3*time.Second)
	defer done()
	_ = server.Shutdown(shutdown)
}

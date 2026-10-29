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
	margin, err := strconv.Atoi(env("SAFETY_MARGIN_MS", "2000"))
	if err != nil {
		log.Fatal(err)
	}
	building := env("BUILDING_ID", "hamra")
	gw, err := telemetry.NewGateway(telemetry.GatewayConfig{BuildingID: building, Name: env("BUILDING_NAME", "Hamra Residence"), Coordinators: strings.Split(env("COORDINATORS", "http://coordinator1:8080,http://coordinator2:8080,http://coordinator3:8080"), ","), SafetyMargin: time.Duration(margin) * time.Millisecond})
	if err != nil {
		log.Fatal(err)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	opts := mqtt.NewClientOptions().AddBroker(env("MQTT_URL", "tcp://mosquitto:1883")).SetClientID("gateway-" + building + "-" + telemetry.NewID()).SetCleanSession(true).SetAutoReconnect(true).SetConnectRetry(true).SetConnectRetryInterval(time.Second).SetKeepAlive(10 * time.Second).SetPingTimeout(2 * time.Second)
	opts.OnConnect = func(c mqtt.Client) {
		token := c.Subscribe("ishtirak/"+building+"/readings", 1, func(c mqtt.Client, m mqtt.Message) {
			if len(m.Payload()) > 4096 {
				return
			}
			var reading telemetry.Reading
			if err := json.Unmarshal(m.Payload(), &reading); err == nil {
				gw.Ingest(reading)
			}
		})
		if !token.WaitTimeout(3 * time.Second) {
			gw.SetError(context.DeadlineExceeded)
			return
		}
		if token.Error() != nil {
			gw.SetError(token.Error())
			return
		}
		gw.SetMQTTConnected(true)
	}
	opts.OnConnectionLost = func(c mqtt.Client, err error) { gw.SetMQTTConnected(false); gw.SetError(err) }
	client := mqtt.NewClient(opts)
	go func() {
		token := client.Connect()
		token.Wait()
		if token.Error() != nil {
			gw.SetError(token.Error())
		}
	}()
	go gw.Run(ctx)
	server := &http.Server{Addr: env("HTTP_ADDR", ":8080"), Handler: gw.Handler(), ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	go func() {
		log.Printf("gateway %s listening on %s", building, server.Addr)
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

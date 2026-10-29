package main

import (
	"context"
	"errors"
	"ishtirak/internal/coordinator"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	cfg, err := coordinator.EnvConfig()
	if err != nil {
		log.Fatal(err)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	server, err := coordinator.New(ctx, cfg)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("starting %s", server)
	done := make(chan error, 1)
	go func() { done <- server.Run(ctx) }()
	select {
	case <-ctx.Done():
	case err = <-done:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Printf("HTTP server: %v", err)
		}
		cancel()
	}
	shutdown, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if err = server.Close(shutdown); err != nil {
		log.Print(err)
	}
}

// Command relay runs the Koyeb egress relay for the AI gateway.
//
// The relay is not the gateway: it authenticates one Worker request per
// WebSocket, resolves a hard-coded provider allowlist, forwards the upstream
// provider request, and streams response bytes back unchanged.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"gateway-relay/internal/relay"
)

func main() {
	cfg, err := relay.ConfigFromEnv()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	srv := relay.NewServer(cfg)
	httpSrv := &http.Server{
		Addr:              "0.0.0.0:" + cfg.Port,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Printf("relay listening port=%s providers=%d", cfg.Port, len(cfg.Providers))
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
}

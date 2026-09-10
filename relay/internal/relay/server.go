package relay

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

// Config is the complete relay configuration. Secrets come only from the
// environment; provider routing comes from the compiled allowlist plus an
// optional JSON override.
type Config struct {
	Port         string
	Secret       string
	LogLevel     string
	Providers    map[string]Provider
	MaxBodyBytes int64
	PingInterval time.Duration
}

// ConfigFromEnv reads PORT, KOYEB_RELAY_SECRET, LOG_LEVEL, and
// RELAY_PROVIDERS_JSON. It fails closed when the secret is missing.
func ConfigFromEnv() (*Config, error) {
	secret := os.Getenv("KOYEB_RELAY_SECRET")
	if secret == "" {
		return nil, fmt.Errorf("KOYEB_RELAY_SECRET is not set")
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8000"
	}
	providers := map[string]Provider{}
	for _, p := range DefaultProviders() {
		providers[strings.ToLower(p.ID)] = p
	}
	extra, err := ProvidersFromEnv()
	if err != nil {
		return nil, err
	}
	for _, p := range extra {
		providers[strings.ToLower(p.ID)] = p
	}
	return &Config{
		Port:         port,
		Secret:       secret,
		LogLevel:     strings.ToLower(os.Getenv("LOG_LEVEL")),
		Providers:    providers,
		MaxBodyBytes: 4 << 20,
		PingInterval: 15 * time.Second,
	}, nil
}

// Server serves /healthz and the /tunnel WebSocket endpoint.
type Server struct {
	cfg    *Config
	auth   *Auth
	client *http.Client
}

// NewServer builds the HTTP handler set and the upstream client. Compression
// is disabled so upstream bytes are preserved exactly; redirects are confined
// to the allowlisted origin.
func NewServer(cfg *Config) *Server {
	baseDialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		DialContext:           PublicIPOnlyDialer(baseDialer),
		TLSHandshakeTimeout:   15 * time.Second,
		DisableCompression:    true,
		MaxIdleConnsPerHost:   32,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: 0, // first token may take minutes; pings keep the tunnel alive
	}
	client := &http.Client{
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return fmt.Errorf("too many redirects")
			}
			prev := via[len(via)-1].URL
			if req.URL.Scheme != prev.Scheme || req.URL.Host != prev.Host {
				return fmt.Errorf("redirect to non-allowlisted origin blocked")
			}
			return nil
		},
	}
	auth, err := NewAuth(cfg.Secret)
	if err != nil {
		panic(err)
	}
	return &Server{cfg: cfg, auth: auth, client: client}
}

// Handler returns the relay mux.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/tunnel", s.handleTunnel)
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func (s *Server) handleTunnel(w http.ResponseWriter, r *http.Request) {
	ws, err := serveWS(w, r)
	if err != nil {
		http.Error(w, "websocket upgrade required", http.StatusBadRequest)
		return
	}
	// Pongs refresh this deadline per frame, so streams can outlive it.
	ws.readTimeout = 90 * time.Second
	s.serveSession(ws)
}

// serveSession runs one proxied provider request on one WebSocket.
func (s *Server) serveSession(ws *wsConn) {
	started := time.Now()
	fields := Fields{Transport: "koyeb-relay"}
	defer ws.close()

	// The open message must arrive promptly; afterwards pings keep the
	// connection alive through long provider silences.
	_ = ws.conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	op, raw, err := ws.readMessage()
	if err != nil || op != opText {
		s.sendError(ws, "", "bad_request", "open message required", false)
		fields.Disconnect, fields.ErrorClass = "no_open", "bad_request"
		Log(fields)
		return
	}
	var open OpenMessage
	if err := json.Unmarshal(raw, &open); err != nil || open.Type != "open" {
		s.sendError(ws, "", "bad_request", "malformed open message", false)
		fields.Disconnect, fields.ErrorClass = "bad_open", "bad_request"
		Log(fields)
		return
	}
	fields.RequestID, fields.Provider = open.RequestID, strings.ToLower(open.Provider)
	if err := s.auth.VerifyOpen(&open); err != nil {
		s.sendError(ws, open.RequestID, "auth_failed", "authentication failed", false)
		fields.Disconnect, fields.ErrorClass = "auth_failed", "auth_failed"
		Log(fields)
		return
	}
	if open.BodyLen < 0 || int64(open.BodyLen) > s.cfg.MaxBodyBytes {
		s.sendError(ws, open.RequestID, "body_too_large", "request body too large", false)
		fields.Disconnect, fields.ErrorClass = "body_too_large", "body_too_large"
		Log(fields)
		return
	}
	target, err := ResolveURL(s.cfg.Providers, open.Provider, open.Method, open.Path, open.Query)
	if err != nil {
		s.sendError(ws, open.RequestID, "forbidden_target", "target not allowed", false)
		fields.Disconnect, fields.ErrorClass = "forbidden_target", "forbidden_target"
		Log(fields)
		return
	}
	// Read the request body as bounded binary chunks until request_end.
	body := make([]byte, 0, min(open.BodyLen, 1<<20))
	bodyComplete := false
	for !bodyComplete {
		_ = ws.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		op, raw, err := ws.readMessage()
		if err != nil {
			fields.Disconnect, fields.ErrorClass = "client_left_before_upstream", "client_cancelled"
			Log(fields)
			return
		}
		switch op {
		case opBinary:
			if len(body)+len(raw) > int(s.cfg.MaxBodyBytes) {
				s.sendError(ws, open.RequestID, "body_too_large", "request body too large", false)
				fields.Disconnect, fields.ErrorClass = "body_too_large", "body_too_large"
				Log(fields)
				return
			}
			body = append(body, raw...)
			fields.BytesIn += int64(len(raw))
		case opText:
			var end RequestEndMessage
			if err := json.Unmarshal(raw, &end); err != nil || end.Type != "request_end" {
				s.sendError(ws, open.RequestID, "bad_request", "expected request_end", false)
				fields.Disconnect, fields.ErrorClass = "bad_request", "bad_request"
				Log(fields)
				return
			}
			bodyComplete = true
		default:
			s.sendError(ws, open.RequestID, "bad_request", "unexpected frame", false)
			fields.Disconnect, fields.ErrorClass = "bad_request", "bad_request"
			Log(fields)
			return
		}
	}
	sum := sha256.Sum256(body)
	if hex.EncodeToString(sum[:]) != strings.ToLower(open.BodySHA256) {
		s.sendError(ws, open.RequestID, "bad_request", "body hash mismatch", false)
		fields.Disconnect, fields.ErrorClass = "body_hash_mismatch", "bad_request"
		Log(fields)
		return
	}

	// From here the upstream request is live. Worker retries must stop at
	// this point; cancellation propagates through ctx instead.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		// Watch for client close; any read error means the client is gone.
		for {
			_ = ws.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
			_, _, err := ws.readMessage()
			if err != nil {
				cancel()
				return
			}
		}
	}()

	upReq, err := http.NewRequestWithContext(ctx, open.Method, target.String(), bytes.NewReader(body))
	if err != nil {
		s.sendError(ws, open.RequestID, "internal", "cannot build upstream request", false)
		fields.Disconnect, fields.ErrorClass = "internal", "internal"
		Log(fields)
		return
	}
	for name, value := range open.Headers {
		lower := strings.ToLower(name)
		if !forwardRequestHeaders[lower] || len(value) > 8192 {
			continue
		}
		upReq.Header.Set(lower, value)
	}
	if upReq.Header.Get("content-type") == "" && len(body) > 0 {
		upReq.Header.Set("Content-Type", "application/json")
	}
	upReq.Header.Set("Accept-Encoding", "identity")
	upReq.URL.User = nil

	connectStart := time.Now()
	s.sendAccepted(ws, open.RequestID)
	upResp, err := s.client.Do(upReq)
	fields.ConnectMs = millis(time.Since(connectStart))
	if err != nil {
		class := "upstream_error"
		msg := "upstream request failed"
		if ctx.Err() != nil {
			class, msg = "client_cancelled", "client disconnected"
			fields.Disconnect = "client_cancelled"
		}
		s.sendError(ws, open.RequestID, class, msg, false)
		fields.ErrorClass = class
		fields.DurationMs = millis(time.Since(started))
		Log(fields)
		return
	}
	defer upResp.Body.Close()
	fields.TTFBms = millis(time.Since(connectStart))
	fields.Status = upResp.StatusCode

	respHeaders := map[string]string{}
	for name := range forwardResponseHeaders {
		if value := upResp.Header.Get(name); value != "" {
			respHeaders[name] = value
		}
	}
	s.sendResponse(ws, open.RequestID, upResp.StatusCode, respHeaders)

	// Stream upstream bytes immediately with one bounded buffer. Slow
	// downstream applies backpressure through write deadlines instead of
	// unbounded memory growth.
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(s.cfg.PingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				_ = ws.writePing()
			case <-ctx.Done():
				return
			}
		}
	}()
	buf := make([]byte, 32*1024)
	var total int64
	for {
		n, readErr := upResp.Body.Read(buf)
		if n > 0 {
			if err := ws.writeBinary(buf[:n]); err != nil {
				cancel()
				fields.Disconnect, fields.ErrorClass = "client_write_failed", "client_cancelled"
				fields.BytesOut = total
				fields.DurationMs = millis(time.Since(started))
				Log(fields)
				return
			}
			total += int64(n)
		}
		if readErr != nil {
			break
		}
	}
	close(done)
	fields.BytesOut = total
	fields.DurationMs = millis(time.Since(started))
	if ctx.Err() != nil && total == 0 {
		fields.Disconnect, fields.ErrorClass = "client_cancelled", "client_cancelled"
		Log(fields)
		return
	}
	if total > 0 || upResp.StatusCode < 400 {
		s.sendResponseEnd(ws, open.RequestID, total)
	}
	if fields.Disconnect == "" {
		fields.Disconnect = "complete"
	}
	Log(fields)
}

func (s *Server) sendAccepted(ws *wsConn, requestID string) {
	raw, _ := json.Marshal(AcceptedMessage{Type: "accepted", RequestID: requestID})
	_ = ws.writeText(raw)
}

func (s *Server) sendResponse(ws *wsConn, requestID string, status int, headers map[string]string) {
	raw, _ := json.Marshal(ResponseMessage{Type: "response", RequestID: requestID, Status: status, Headers: headers})
	_ = ws.writeText(raw)
}

func (s *Server) sendResponseEnd(ws *wsConn, requestID string, total int64) {
	raw, _ := json.Marshal(ResponseEndMessage{Type: "response_end", RequestID: requestID, Bytes: total})
	_ = ws.writeText(raw)
}

func (s *Server) sendError(ws *wsConn, requestID, code, message string, retryable bool) {
	raw, _ := json.Marshal(ErrorMessage{Type: "error", RequestID: requestID, Code: code, Message: message, Retryable: retryable})
	_ = ws.writeText(raw)
	_ = ws.writeClose(1008)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

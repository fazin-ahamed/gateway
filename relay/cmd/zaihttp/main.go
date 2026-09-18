// Command zaihttp is a tiny localhost proxy that gives the gateway a Chrome
// TLS fingerprint for chat.z.ai.
//
// Why: the Z.AI/Aliyun edge inspects the TLS ClientHello. Go's and Node's
// default stacks present a non-browser handshake and get challenged, so the
// signed transport cannot survive on `fetch` alone. This helper dials
// chat.z.ai with uTLS (Chrome hello, HTTP/1.1) and streams the response back,
// letting the gateway keep its normal HTTP shape.
//
// It is intentionally narrow: only https://chat.z.ai is dialable, only POST
// /proxy is served, and it listens on loopback unless told otherwise.
//
//	go run ./cmd/zaihttp                    # 127.0.0.1:8477
//	ZAI_UTLS_PROXY=http://127.0.0.1:8477    # gateway side
package main

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	utls "github.com/refraction-networking/utls"
)

const targetHost = "chat.z.ai"
func chromeTLSConfig() *utls.Config {
	return &utls.Config{
		ServerName: targetHost,
		NextProtos: []string{"http/1.1"},
	}
}

// headers that describe the hop itself and must not be forwarded upstream.
var hopHeaders = map[string]bool{
	"host":                true,
	"connection":          true,
	"keep-alive":          true,
	"proxy-connection":    true,
	"transfer-encoding":   true,
	"upgrade":             true,
	"x-target-url":        true,
	"x-target-method":     true,
	"content-length":      true,
	"proxy-authenticate":  true,
	"proxy-authorization": true,
	"te":                  true,
	"trailer":             true,
}

func main() {
	addr := os.Getenv("ZAI_HTTP_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8477"
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true}`)
	})
	mux.HandleFunc("/proxy", handleProxy)
	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("zaihttp listening addr=%s target=%s", addr, targetHost)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("listen: %v", err)
	}
}

func handleProxy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	target, err := url.Parse(r.Header.Get("X-Target-Url"))
	if err != nil || target.Scheme != "https" || target.Hostname() != targetHost {
		http.Error(w, "target must be https://"+targetHost, http.StatusBadRequest)
		return
	}
	method := strings.ToUpper(r.Header.Get("X-Target-Method"))
	if method == "" {
		method = http.MethodGet
	}
	// Only the two Z.AI call shapes the gateway actually makes.
	if method != http.MethodGet && method != http.MethodPost && method != http.MethodDelete {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()

	conn, err := (&net.Dialer{Timeout: 15 * time.Second}).DialContext(ctx, "tcp", targetHost+":443")
	if err != nil {
		http.Error(w, "dial: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer conn.Close()

	tlsConn := utls.UClient(conn, chromeTLSConfig(), utls.HelloChrome_Auto)
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		http.Error(w, "tls: "+err.Error(), http.StatusBadGateway)
		return
	}

	body := io.Reader(r.Body)
	contentLength := r.ContentLength
	if contentLength < 0 {
		buf, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "read body: "+err.Error(), http.StatusBadRequest)
			return
		}
		body = bytes.NewReader(buf)
		contentLength = int64(len(buf))
	}
	upReq, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		http.Error(w, "request: "+err.Error(), http.StatusBadRequest)
		return
	}
	for name, values := range r.Header {
		if hopHeaders[strings.ToLower(name)] {
			continue
		}
		for _, v := range values {
			upReq.Header.Add(name, v)
		}
	}
	upReq.Host = targetHost
	upReq.ContentLength = contentLength
	upReq.TransferEncoding = nil
	if err := upReq.Write(tlsConn); err != nil {
		http.Error(w, "write: "+err.Error(), http.StatusBadGateway)
		return
	}

	resp, err := http.ReadResponse(bufio.NewReader(tlsConn), upReq)
	if err != nil {
		http.Error(w, "read: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	for name, values := range resp.Header {
		if hopHeaders[strings.ToLower(name)] {
			continue
		}
		for _, v := range values {
			w.Header().Add(name, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	if _, err := io.Copy(w, resp.Body); err != nil {
		log.Printf("copy: %v", err)
	}
}

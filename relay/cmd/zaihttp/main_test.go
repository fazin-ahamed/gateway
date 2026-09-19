package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTemplatesUseHTTP11(t *testing.T) {
	cfg := chromeTLSConfig()
	if len(cfg.NextProtos) != 1 || cfg.NextProtos[0] != "http/1.1" {
		t.Fatalf("ALPN %v; must force http/1.1 — Chrome's hello would otherwise negotiate h2 and break the manual request writer", cfg.NextProtos)
	}
}

func TestRejectsNonZaiHost(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/proxy", strings.NewReader("{}"))
	req.Header.Set("X-Target-Url", "https://evil.example/api")
	rec := httptest.NewRecorder()
	handleProxy(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestRejectsNonPost(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/proxy", nil)
	req.Header.Set("X-Target-Url", "https://chat.z.ai/api/models")
	rec := httptest.NewRecorder()
	handleProxy(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status=%d", rec.Code)
	}
}

func TestHealthz(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != 200 || rec.Body.String() != `{"ok":true}` {
		t.Fatalf("healthz %d %s", rec.Code, rec.Body.String())
	}
}

func TestHopHeadersAreStrippedFromResponse(t *testing.T) {
	if !hopHeaders["transfer-encoding"] {
		t.Fatal("transfer-encoding must be a hop header")
	}
	if !hopHeaders["content-length"] {
		t.Fatal("content-length must be a hop header so net/http can set it")
	}
}

func TestUnknownLengthBodyIsBuffered(t *testing.T) {
	body := strings.NewReader(`{"ok":true}`)
	req := httptest.NewRequest(http.MethodPost, "/proxy", body)
	req.ContentLength = -1
	req.Header.Set("X-Target-Url", "https://chat.z.ai/api/v2/chat/completions")
	req.Header.Set("X-Target-Method", "POST")
	if req.ContentLength >= 0 {
		t.Fatalf("expected unknown length, got %d", req.ContentLength)
	}
	buf, err := io.ReadAll(req.Body)
	if err != nil {
		t.Fatal(err)
	}
	if len(buf) == 0 {
		t.Fatal("body vanished")
	}
}

func TestCheckEgressRejectsNonLoopback(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/check-egress", strings.NewReader(`{"proxy":""}`))
	req.RemoteAddr = "203.0.113.7:5555"
	rec := httptest.NewRecorder()
	handleCheckEgress(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-loopback must be rejected, got %d", rec.Code)
	}
}


func TestEgressProxyHeaderIsHopStripped(t *testing.T) {
	if !hopHeaders["x-egress-proxy"] {
		t.Fatal("x-egress-proxy must be a hop header so it never leaks upstream to chat.z.ai")
	}
}
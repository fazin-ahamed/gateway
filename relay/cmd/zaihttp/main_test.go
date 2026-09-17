package main

import (
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

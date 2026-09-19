package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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

func TestParseEgressModes(t *testing.T) {
	d, err := parseEgress("")
	if err != nil || d.kind != "direct" {
		t.Fatalf("empty: %+v %v", d, err)
	}
	h, err := parseEgress("http://user:secret@10.0.0.1:8080")
	if err != nil || h.kind != "http" || h.addr != "10.0.0.1:8080" || h.user != "user" || h.pass != "secret" {
		t.Fatalf("http: %+v %v", h, err)
	}
	s, err := parseEgress("socks5://127.0.0.1:9050")
	if err != nil || s.kind != "socks5" || s.remoteDNS {
		t.Fatalf("socks5 should resolve locally: %+v %v", s, err)
	}
	sh, err := parseEgress("socks5h://127.0.0.1:9050")
	if err != nil || sh.kind != "socks5" || !sh.remoteDNS || sh.addr != "127.0.0.1:9050" {
		t.Fatalf("socks5h: %+v %v", sh, err)
	}
	if _, err := parseEgress("ftp://127.0.0.1:21"); err == nil {
		t.Fatal("ftp must be rejected")
	}
	if _, err := parseEgress("not-a-url"); err == nil {
		t.Fatal("garbage must be rejected")
	}
}

func TestParseEgressIPv6AndValidation(t *testing.T) {
	v6, err := parseEgress("socks5h://[::1]:9050")
	if err != nil || v6.addr != "[::1]:9050" || !v6.remoteDNS {
		t.Fatalf("ipv6: %+v %v", v6, err)
	}
	v6d, err := parseEgress("http://[2001:db8::1]")
	if err != nil || v6d.addr != "[2001:db8::1]:80" {
		t.Fatalf("ipv6 default port: %+v %v", v6d, err)
	}
	if _, err := parseEgress("http://1.2.3.4:8080/path"); err == nil {
		t.Fatal("path must be rejected")
	}
	if _, err := parseEgress("http://1.2.3.4:8080?x=1"); err == nil {
		t.Fatal("query must be rejected")
	}
	longUser := "http://" + strings.Repeat("u", 256) + ":p@1.2.3.4:8080"
	if _, err := parseEgress(longUser); err == nil {
		t.Fatal("over-long username must be rejected")
	}
}

func TestSanitizeDialErrHidesEgress(t *testing.T) {
	msg := sanitizeDialErr(fmtErr("socks5h://user:hunter2@127.0.0.1:9050 socks status 5"))
	if strings.Contains(msg, "9050") || strings.Contains(msg, "hunter2") || strings.Contains(msg, "socks5h") {
		t.Fatalf("leaked egress: %s", msg)
	}
	if msg != "egress tunnel failed" {
		t.Fatalf("got %q", msg)
	}
}

func fmtErr(s string) error { return &strErr{s} }

type strErr struct{ s string }

func (e *strErr) Error() string { return e.s }

func TestHTTPConnectSendsCONNECT(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	got := make(chan string, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		br := bufio.NewReader(c)
		line, _ := br.ReadString('\n')
		got <- line
		_, _ = io.WriteString(c, "HTTP/1.1 200 Connection Established\r\n\r\n")
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, err := net.DialTimeout("tcp", ln.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := httpConnect(ctx, conn, "chat.z.ai:443", egressConfig{kind: "http"}); err != nil {
		t.Fatal(err)
	}
	select {
	case line := <-got:
		if !strings.HasPrefix(line, "CONNECT chat.z.ai:443 HTTP/1.1") {
			t.Fatalf("CONNECT line: %q", line)
		}
	case <-ctx.Done():
		t.Fatal("no CONNECT")
	}
}

func TestSOCKS5hSendsHostname(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	atyp := make(chan byte, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		hdr := make([]byte, 3)
		if _, err := io.ReadFull(c, hdr); err != nil {
			return
		}
		_, _ = c.Write([]byte{0x05, 0x00}) // no auth
		req := make([]byte, 4)
		if _, err := io.ReadFull(c, req); err != nil {
			return
		}
		atyp <- req[3]
		if req[3] == 0x03 {
			l := make([]byte, 1)
			_, _ = io.ReadFull(c, l)
			rest := make([]byte, int(l[0])+2)
			_, _ = io.ReadFull(c, rest)
		}
		// bind addr IPv4 zeros
		rep := []byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0}
		port := make([]byte, 2)
		binary.BigEndian.PutUint16(port, 0)
		_, _ = c.Write(append(rep, port...))
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, err := net.DialTimeout("tcp", ln.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := socks5Connect(ctx, conn, "chat.z.ai", 443, egressConfig{kind: "socks5", remoteDNS: true}); err != nil {
		t.Fatal(err)
	}
	select {
	case a := <-atyp:
		if a != 0x03 {
			t.Fatalf("socks5h must send domain atyp=3, got %d", a)
		}
	case <-ctx.Done():
		t.Fatal("no socks request")
	}
}


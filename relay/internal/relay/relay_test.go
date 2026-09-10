package relay

import (
	"bufio"
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testSecret = "test-relay-secret-1234567890"

// testEnv spins up a synthetic upstream provider and a relay fronting it.
// The synthetic provider listens on loopback, so RELAY_ALLOW_PRIVATE is set.
func testEnv(t testing.TB, upstream http.Handler) (relayBase string, upstreamHits *atomic.Int64) {
	t.Helper()
	t.Setenv("RELAY_ALLOW_PRIVATE", "1")
	hits := &atomic.Int64{}
	wrapped := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		upstream.ServeHTTP(w, r)
	})
	upSrv := httptest.NewServer(wrapped)
	t.Cleanup(upSrv.Close)
	host := strings.TrimPrefix(upSrv.URL, "http://")
	providers := map[string]Provider{}
	for _, p := range DefaultProviders() {
		providers[strings.ToLower(p.ID)] = p
	}
	providers["test"] = Provider{ID: "test", Scheme: "http", Host: host, PathPrefixes: []string{"/v1/"}}
	cfg := &Config{
		Port:         "0",
		Secret:       testSecret,
		Providers:    providers,
		MaxBodyBytes: 4 << 20,
		PingInterval: 50 * time.Millisecond,
	}
	srv := NewServer(cfg)
	relaySrv := httptest.NewServer(srv.Handler())
	t.Cleanup(relaySrv.Close)
	return relaySrv.URL, hits
}

// wsTestClient is a minimal masking WebSocket client for tests.
type wsTestClient struct {
	t    testing.TB
	conn net.Conn
	r    *bufio.Reader
}

func dialTunnel(t testing.TB, relayBase string) *wsTestClient {
	t.Helper()
	addr := strings.TrimPrefix(relayBase, "http://")
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	keyBytes := make([]byte, 16)
	_, _ = rand.Read(keyBytes)
	key := base64.StdEncoding.EncodeToString(keyBytes)
	req := "GET /tunnel HTTP/1.1\r\nHost: " + addr + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n"
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatalf("upgrade write: %v", err)
	}
	r := bufio.NewReader(conn)
	status, err := r.ReadString('\n')
	if err != nil || !strings.Contains(status, "101") {
		t.Fatalf("upgrade status: %q err=%v", status, err)
	}
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatalf("upgrade headers: %v", err)
		}
		if line == "\r\n" {
			break
		}
	}
	return &wsTestClient{t: t, conn: conn, r: r}
}

func (c *wsTestClient) sendFrame(opcode int, payload []byte) {
	c.t.Helper()
	header := []byte{0x80 | byte(opcode)}
	n := len(payload)
	switch {
	case n <= 125:
		header = append(header, 0x80|byte(n))
	case n <= 65535:
		header = append(header, 0x80|126, byte(n>>8), byte(n))
	default:
		header = append(header, 0x80|127, 0, 0, 0, 0, byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
	}
	var mask [4]byte
	_, _ = rand.Read(mask[:])
	header = append(header, mask[:]...)
	masked := make([]byte, n)
	for i := range payload {
		masked[i] = payload[i] ^ mask[i%4]
	}
	if _, err := c.conn.Write(append(header, masked...)); err != nil {
		c.t.Fatalf("write frame: %v", err)
	}
}

func (c *wsTestClient) sendText(payload []byte)   { c.sendFrame(opText, payload) }
func (c *wsTestClient) sendBinary(payload []byte) { c.sendFrame(opBinary, payload) }

// readMessage returns the next data message, answering pings internally.
func (c *wsTestClient) readMessage() (int, []byte) {
	c.t.Helper()
	for {
		_ = c.conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		hdr := make([]byte, 2)
		if _, err := io.ReadFull(c.r, hdr); err != nil {
			c.t.Fatalf("read header: %v", err)
		}
		opcode := int(hdr[0] & 0x0f)
		length := int64(hdr[1] & 0x7f)
		switch length {
		case 126:
			ext := make([]byte, 2)
			_, _ = io.ReadFull(c.r, ext)
			length = int64(ext[0])<<8 | int64(ext[1])
		case 127:
			ext := make([]byte, 8)
			_, _ = io.ReadFull(c.r, ext)
			for i := range ext {
				length = length<<8 | int64(ext[i])
			}
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(c.r, payload); err != nil {
			c.t.Fatalf("read payload: %v", err)
		}
		switch opcode {
		case opPing:
			c.sendFrame(opPong, payload)
			continue
		case opPong, opContinuation:
			continue
		case opClose:
			c.t.Fatalf("server closed tunnel")
		}
		return opcode, payload
	}
}

func (c *wsTestClient) close() { _ = c.conn.Close() }

func signOpen(secret string, o *OpenMessage) {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(CanonicalString(o.Timestamp, o.Nonce, o.RequestID, o.Provider, o.Method, o.Path, o.Query, o.BodySHA256)))
	o.Signature = hex.EncodeToString(mac.Sum(nil))
}

func newOpen(provider, method, path string, headers map[string]string, body []byte) *OpenMessage {
	sum := sha256.Sum256(body)
	nonce := make([]byte, 16)
	_, _ = rand.Read(nonce)
	return &OpenMessage{
		Type: "open", Version: 1, RequestID: fmt.Sprintf("req-%d", time.Now().UnixNano()),
		Provider: provider, Method: method, Path: path,
		Headers: headers, BodySHA256: hex.EncodeToString(sum[:]), BodyLen: len(body),
		Timestamp: fmt.Sprintf("%d", time.Now().UnixMilli()), Nonce: hex.EncodeToString(nonce),
	}
}

// fullExchange sends open + body + request_end, then collects response.
func fullExchange(t testing.TB, c *wsTestClient, open *OpenMessage, body []byte) (int, map[string]string, []byte) {
	t.Helper()
	raw, _ := json.Marshal(open)
	c.sendText(raw)
	for offset := 0; offset < len(body); {
		end := offset + 65536
		if end > len(body) {
			end = len(body)
		}
		c.sendBinary(body[offset:end])
		offset = end
	}
	endRaw, _ := json.Marshal(RequestEndMessage{Type: "request_end", RequestID: open.RequestID})
	c.sendText(endRaw)
	var status int
	var headers map[string]string
	var out []byte
	var total int64 = -1
	for {
		op, payload := c.readMessage()
		if op == opBinary {
			out = append(out, payload...)
			continue
		}
		var envelope struct {
			Type      string            `json:"type"`
			Status    int               `json:"status"`
			Headers   map[string]string `json:"headers"`
			Bytes     int64             `json:"bytes"`
			Code      string            `json:"code"`
			Message   string            `json:"message"`
			Retryable bool              `json:"retryable"`
		}
		if err := json.Unmarshal(payload, &envelope); err != nil {
			t.Fatalf("bad control frame: %v", err)
		}
		switch envelope.Type {
		case "accepted":
			continue
		case "response":
			status, headers = envelope.Status, envelope.Headers
		case "response_end":
			total = envelope.Bytes
			if int64(len(out)) != total {
				t.Fatalf("byte count mismatch: got %d want %d", len(out), total)
			}
			return status, headers, out
		case "error":
			t.Fatalf("tunnel error code=%s message=%s", envelope.Code, envelope.Message)
		default:
			t.Fatalf("unknown frame type %q", envelope.Type)
		}
	}
}

func echoUpstream(body []byte) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(got)
		_ = body
	})
}

func TestHealthz(t *testing.T) {
	relayBase, _ := testEnv(t, echoUpstream(nil))
	resp, err := http.Get(relayBase + "/healthz")
	if err != nil {
		t.Fatalf("healthz: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(body) != `{"ok":true}` {
		t.Fatalf("healthz = %d %q", resp.StatusCode, body)
	}
}

func TestRoundTripJSON(t *testing.T) {
	relayBase, hits := testEnv(t, echoUpstream(nil))
	c := dialTunnel(t, relayBase)
	defer c.close()
	body := []byte(`{"model":"test-model","messages":[{"role":"user","content":"hi"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}`)
	open := newOpen("test", "POST", "/v1/chat/completions", map[string]string{"Content-Type": "application/json", "Authorization": "Bearer upstream-key"}, body)
	signOpen(testSecret, open)
	status, headers, out := fullExchange(t, c, open, body)
	if status != 200 {
		t.Fatalf("status = %d", status)
	}
	if headers["content-type"] != "application/json" {
		t.Fatalf("content-type = %q", headers)
	}
	if !bytes.Equal(out, body) {
		t.Fatalf("body mismatch: %q", out)
	}
	if hits.Load() != 1 {
		t.Fatalf("upstream hits = %d, want 1", hits.Load())
	}
}

func TestBadSignature(t *testing.T) {
	relayBase, hits := testEnv(t, echoUpstream(nil))
	c := dialTunnel(t, relayBase)
	defer c.close()
	body := []byte(`{}`)
	open := newOpen("test", "POST", "/v1/chat/completions", nil, body)
	signOpen("wrong-secret-0000000000000000", open)
	raw, _ := json.Marshal(open)
	c.sendText(raw)
	op, payload := c.readMessage()
	if op != opText {
		t.Fatalf("expected text error, got opcode %d", op)
	}
	var envelope struct {
		Type string `json:"type"`
		Code string `json:"code"`
	}
	_ = json.Unmarshal(payload, &envelope)
	if envelope.Type != "error" || envelope.Code != "auth_failed" {
		t.Fatalf("envelope = %+v", envelope)
	}
	if hits.Load() != 0 {
		t.Fatalf("upstream must not be hit on auth failure")
	}
}

func TestExpiredTimestamp(t *testing.T) {
	relayBase, _ := testEnv(t, echoUpstream(nil))
	c := dialTunnel(t, relayBase)
	defer c.close()
	body := []byte(`{}`)
	open := newOpen("test", "POST", "/v1/chat/completions", nil, body)
	open.Timestamp = fmt.Sprintf("%d", time.Now().Add(-10*time.Minute).UnixMilli())
	signOpen(testSecret, open)
	raw, _ := json.Marshal(open)
	c.sendText(raw)
	op, payload := c.readMessage()
	if op != opText {
		t.Fatalf("expected text error")
	}
	var envelope struct {
		Type string `json:"type"`
		Code string `json:"code"`
	}
	_ = json.Unmarshal(payload, &envelope)
	if envelope.Type != "error" {
		t.Fatalf("envelope = %+v", envelope)
	}
}

func TestReplayedNonce(t *testing.T) {
	relayBase, _ := testEnv(t, echoUpstream(nil))
	c1 := dialTunnel(t, relayBase)
	body := []byte(`{}`)
	open := newOpen("test", "POST", "/v1/chat/completions", nil, body)
	signOpen(testSecret, open)
	status, _, _ := fullExchange(t, c1, open, body)
	if status != 200 {
		t.Fatalf("first use status = %d", status)
	}
	c1.close()
	c2 := dialTunnel(t, relayBase)
	defer c2.close()
	open.RequestID = "req-replay"
	signOpen(testSecret, open) // same nonce, fresh signature input is identical -> replay
	raw, _ := json.Marshal(open)
	c2.sendText(raw)
	op, payload := c2.readMessage()
	if op != opText {
		t.Fatalf("expected text error")
	}
	var envelope struct {
		Type string `json:"type"`
		Code string `json:"code"`
	}
	_ = json.Unmarshal(payload, &envelope)
	if envelope.Type != "error" {
		t.Fatalf("replay must be rejected, got %+v", envelope)
	}
}

func TestMalformedOpen(t *testing.T) {
	relayBase, _ := testEnv(t, echoUpstream(nil))
	c := dialTunnel(t, relayBase)
	defer c.close()
	c.sendText([]byte(`{not json`))
	op, payload := c.readMessage()
	if op != opText {
		t.Fatalf("expected text error")
	}
	var envelope struct {
		Type string `json:"type"`
		Code string `json:"code"`
	}
	_ = json.Unmarshal(payload, &envelope)
	if envelope.Type != "error" || envelope.Code != "bad_request" {
		t.Fatalf("envelope = %+v", envelope)
	}
}

func TestUnknownProvider(t *testing.T) {
	relayBase, hits := testEnv(t, echoUpstream(nil))
	c := dialTunnel(t, relayBase)
	defer c.close()
	body := []byte(`{}`)
	open := newOpen("evil-corp", "POST", "/v1/chat/completions", nil, body)
	signOpen(testSecret, open)
	raw, _ := json.Marshal(open)
	c.sendText(raw)
	op, payload := c.readMessage()
	if op != opText {
		t.Fatalf("expected text error")
	}
	var envelope struct {
		Type string `json:"type"`
		Code string `json:"code"`
	}
	_ = json.Unmarshal(payload, &envelope)
	if envelope.Type != "error" || envelope.Code != "forbidden_target" {
		t.Fatalf("envelope = %+v", envelope)
	}
	if hits.Load() != 0 {
		t.Fatalf("upstream must not be hit")
	}
}

func TestOpenProxyAttempts(t *testing.T) {
	relayBase, hits := testEnv(t, echoUpstream(nil))
	attempts := []struct {
		name     string
		provider string
		method   string
		path     string
		query    string
	}{
		{"bad-method", "test", "DELETE", "/v1/chat/completions", ""},
		{"query-key", "test", "POST", "/v1/chat/completions", "api_key=secret"},
		{"no-leading-slash", "test", "POST", "v1/chat/completions", ""},
	}
	for _, a := range attempts {
		t.Run(a.name, func(t *testing.T) {
			c := dialTunnel(t, relayBase)
			defer c.close()
			body := []byte(`{}`)
			open := newOpen(a.provider, a.method, a.path, nil, body)
			open.Query = a.query
			signOpen(testSecret, open)
			raw, _ := json.Marshal(open)
			c.sendText(raw)
			op, payload := c.readMessage()
			if op != opText {
				t.Fatalf("expected text error")
			}
			var envelope struct {
				Type string `json:"type"`
			}
			_ = json.Unmarshal(payload, &envelope)
			if envelope.Type != "error" {
				t.Fatalf("open proxy attempt must be rejected")
			}
		})
	}
	if hits.Load() != 0 {
		t.Fatalf("upstream hits = %d, want 0", hits.Load())
	}
}

func TestPrivateTargetBlocked(t *testing.T) {
	relayBase, hits := testEnv(t, echoUpstream(nil))
	// testEnv enables the loopback bypass; disable it here so the SSRF
	// dial guard is active for this connection.
	t.Setenv("RELAY_ALLOW_PRIVATE", "")
	c := dialTunnel(t, relayBase)
	defer c.close()
	body := []byte(`{}`)
	open := newOpen("test", "POST", "/v1/chat/completions", nil, body)
	signOpen(testSecret, open)
	raw, _ := json.Marshal(open)
	c.sendText(raw)
	endRaw, _ := json.Marshal(RequestEndMessage{Type: "request_end", RequestID: open.RequestID})
	c.sendText(endRaw)
	for {
		op, payload := c.readMessage()
		if op == opBinary {
			t.Fatalf("no upstream bytes expected")
		}
		var envelope struct {
			Type string `json:"type"`
			Code string `json:"code"`
		}
		_ = json.Unmarshal(payload, &envelope)
		if envelope.Type == "accepted" {
			continue
		}
		if envelope.Type != "error" {
			t.Fatalf("expected error, got %+v", envelope)
		}
		break
	}
	if hits.Load() != 0 {
		t.Fatalf("upstream must not be reached for loopback target")
	}
}

func TestBodyTooLarge(t *testing.T) {
	relayBase, _ := testEnv(t, echoUpstream(nil))
	c := dialTunnel(t, relayBase)
	defer c.close()
	open := newOpen("test", "POST", "/v1/chat/completions", nil, []byte(`{}`))
	open.BodyLen = int(4<<20) + 1
	signOpen(testSecret, open)
	raw, _ := json.Marshal(open)
	c.sendText(raw)
	op, payload := c.readMessage()
	if op != opText {
		t.Fatalf("expected text error")
	}
	var envelope struct {
		Type string `json:"type"`
		Code string `json:"code"`
	}
	_ = json.Unmarshal(payload, &envelope)
	if envelope.Type != "error" || envelope.Code != "body_too_large" {
		t.Fatalf("envelope = %+v", envelope)
	}
}

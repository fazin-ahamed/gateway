package relay

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func hmacSHA256(secret, message string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(message))
	return hex.EncodeToString(mac.Sum(nil))
}

func parseIP(s string) net.IP { return net.ParseIP(s) }

// sseUpstream streams n SSE data frames with gap between them, then [DONE].
func sseUpstream(n int, gap time.Duration, chunks *atomic.Int64) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		for i := range n {
			fmt.Fprintf(w, "data: {\"i\":%d}\n\n", i)
			flusher.Flush()
			if chunks != nil {
				chunks.Add(1)
			}
			time.Sleep(gap)
		}
		fmt.Fprintf(w, "data: {\"usage\":{\"total_tokens\":%d}}\n\ndata: [DONE]\n\n", n)
		flusher.Flush()
	})
}

func TestSSEStreamingExact(t *testing.T) {
	relayBase, hits := testEnv(t, sseUpstream(10, 20*time.Millisecond, nil))
	c := dialTunnel(t, relayBase)
	defer c.close()
	body := []byte(`{"model":"m","stream":true}`)
	open := newOpen("test", "POST", "/v1/chat/completions", map[string]string{"Content-Type": "application/json"}, body)
	signOpen(testSecret, open)
	status, headers, out := fullExchange(t, c, open, body)
	if status != 200 {
		t.Fatalf("status = %d", status)
	}
	if headers["content-type"] != "text/event-stream" {
		t.Fatalf("content-type = %q", headers)
	}
	var want bytes.Buffer
	for i := range 10 {
		fmt.Fprintf(&want, "data: {\"i\":%d}\n\n", i)
	}
	fmt.Fprintf(&want, "data: {\"usage\":{\"total_tokens\":10}}\n\ndata: [DONE]\n\n")
	if !bytes.Equal(out, want.Bytes()) {
		t.Fatalf("stream bytes differ:\n got %q\nwant %q", out, want.Bytes())
	}
	if hits.Load() != 1 {
		t.Fatalf("hits = %d", hits.Load())
	}
}

func TestSlowFirstToken(t *testing.T) {
	// Headers arrive 3s after the request; tunnel pings must keep it alive.
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(3 * time.Second)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	relayBase, _ := testEnv(t, upstream)
	c := dialTunnel(t, relayBase)
	defer c.close()
	body := []byte(`{}`)
	open := newOpen("test", "POST", "/v1/chat/completions", nil, body)
	signOpen(testSecret, open)
	start := time.Now()
	status, _, out := fullExchange(t, c, open, body)
	if status != 200 || string(out) != `{"ok":true}` {
		t.Fatalf("status=%d body=%q", status, out)
	}
	if time.Since(start) < 3*time.Second {
		t.Fatalf("response arrived too early to prove slow-TTFB tolerance")
	}
}

func TestLongStreamOver100Seconds(t *testing.T) {
	if testing.Short() {
		t.Skip("long-stream test needs the full run")
	}
	// 105 one-second chunks: ordinary HTTP through Koyeb's edge would be
	// cut around 100s; the WebSocket tunnel must survive past it.
	relayBase, _ := testEnv(t, sseUpstream(105, time.Second, nil))
	c := dialTunnel(t, relayBase)
	defer c.close()
	body := []byte(`{"model":"m","stream":true}`)
	open := newOpen("test", "POST", "/v1/chat/completions", nil, body)
	signOpen(testSecret, open)
	start := time.Now()
	status, _, out := fullExchange(t, c, open, body)
	elapsed := time.Since(start)
	if status != 200 {
		t.Fatalf("status = %d", status)
	}
	if elapsed < 100*time.Second {
		t.Fatalf("stream lasted %v, must exceed 100s", elapsed)
	}
	if !bytes.Contains(out, []byte(`"total_tokens":105`)) {
		t.Fatalf("missing final usage chunk")
	}
	if count := bytes.Count(out, []byte("data: {\"i\":")); count != 105 {
		t.Fatalf("chunks = %d, want 105", count)
	}
}

func TestStatusPassthrough(t *testing.T) {
	for _, code := range []int{400, 401, 429, 500, 503} {
		t.Run(fmt.Sprintf("%d", code), func(t *testing.T) {
			upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Retry-After", "7")
				w.WriteHeader(code)
				_, _ = w.Write([]byte(fmt.Sprintf(`{"error":{"message":"upstream says %d"}}`, code)))
			})
			relayBase, hits := testEnv(t, upstream)
			c := dialTunnel(t, relayBase)
			defer c.close()
			body := []byte(`{}`)
			open := newOpen("test", "POST", "/v1/chat/completions", nil, body)
			signOpen(testSecret, open)
			status, headers, out := fullExchange(t, c, open, body)
			if status != code {
				t.Fatalf("status = %d, want %d", status, code)
			}
			if code == 429 && headers["retry-after"] != "7" {
				t.Fatalf("retry-after not propagated: %v", headers)
			}
			want := fmt.Sprintf(`{"error":{"message":"upstream says %d"}}`, code)
			if string(out) != want {
				t.Fatalf("body = %q", out)
			}
			if hits.Load() != 1 {
				t.Fatalf("hits = %d", hits.Load())
			}
		})
	}
}

func TestClientCancellation(t *testing.T) {
	cancelled := make(chan struct{})
	var once sync.Once
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		for i := range 10000 {
			select {
			case <-r.Context().Done():
				once.Do(func() { close(cancelled) })
				return
			default:
			}
			fmt.Fprintf(w, "data: {\"i\":%d}\n\n", i)
			flusher.Flush()
			time.Sleep(50 * time.Millisecond)
		}
	})
	relayBase, _ := testEnv(t, upstream)
	c := dialTunnel(t, relayBase)
	body := []byte(`{"stream":true}`)
	open := newOpen("test", "POST", "/v1/chat/completions", nil, body)
	signOpen(testSecret, open)
	raw, _ := json.Marshal(open)
	c.sendText(raw)
	c.sendBinary(body)
	endRaw, _ := json.Marshal(RequestEndMessage{Type: "request_end", RequestID: open.RequestID})
	c.sendText(endRaw)
	// Consume a few chunks, then disconnect abruptly.
	for range 5 {
		op, _ := c.readMessage()
		if op != opBinary {
			continue
		}
	}
	c.close()
	select {
	case <-cancelled:
	case <-time.After(10 * time.Second):
		t.Fatalf("upstream request was not cancelled after client left")
	}
}

func TestProviderAbruptClose(t *testing.T) {
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			t.Fatalf("hijack unsupported")
		}
		conn, rw, err := hijacker.Hijack()
		if err != nil {
			t.Fatalf("hijack: %v", err)
		}
		partial := "data: {\"i\":0}\n\ndata: {\"i\":1}\n\n"
		_, _ = rw.WriteString("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 1000\r\n\r\n" + partial)
		_ = rw.Flush()
		_ = conn.Close() // abrupt mid-body disconnect
	})
	relayBase, _ := testEnv(t, upstream)
	c := dialTunnel(t, relayBase)
	defer c.close()
	body := []byte(`{}`)
	open := newOpen("test", "POST", "/v1/chat/completions", nil, body)
	signOpen(testSecret, open)
	raw, _ := json.Marshal(open)
	c.sendText(raw)
	c.sendBinary(body)
	endRaw, _ := json.Marshal(RequestEndMessage{Type: "request_end", RequestID: open.RequestID})
	c.sendText(endRaw)
	var out []byte
	sawResponse := false
	for {
		_ = c.conn.SetReadDeadline(time.Now().Add(10 * time.Second))
		hdr := make([]byte, 2)
		if _, err := io.ReadFull(c.r, hdr); err != nil {
			break
		}
		opcode := int(hdr[0] & 0x0f)
		length := int64(hdr[1] & 0x7f)
		if length == 126 {
			ext := make([]byte, 2)
			_, _ = io.ReadFull(c.r, ext)
			length = int64(ext[0])<<8 | int64(ext[1])
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(c.r, payload); err != nil {
			break
		}
		if opcode == opPing {
			c.sendFrame(opPong, payload)
			continue
		}
		if opcode == opClose {
			break
		}
		if opcode == opBinary {
			out = append(out, payload...)
			continue
		}
		var envelope struct {
			Type   string `json:"type"`
			Status int    `json:"status"`
		}
		_ = json.Unmarshal(payload, &envelope)
		if envelope.Type == "response" {
			sawResponse = true
			if envelope.Status != 200 {
				t.Fatalf("status = %d", envelope.Status)
			}
		}
	}
	if !sawResponse {
		t.Fatalf("never received upstream headers")
	}
	want := "data: {\"i\":0}\n\ndata: {\"i\":1}\n\n"
	if string(out) != want {
		t.Fatalf("partial bytes = %q", out)
	}
}

func TestChunkedManySmallWrites(t *testing.T) {
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		flusher, _ := w.(http.Flusher)
		for i := range 500 {
			_, _ = w.Write(bytes.Repeat([]byte{byte(i)}, 100))
			flusher.Flush()
		}
	})
	relayBase, _ := testEnv(t, upstream)
	c := dialTunnel(t, relayBase)
	defer c.close()
	body := []byte(`{}`)
	open := newOpen("test", "POST", "/v1/models", nil, body)
	open.Method = "POST"
	signOpen(testSecret, open)
	_, _, out := fullExchange(t, c, open, body)
	var want bytes.Buffer
	for i := range 500 {
		want.Write(bytes.Repeat([]byte{byte(i)}, 100))
	}
	if !bytes.Equal(out, want.Bytes()) {
		t.Fatalf("chunked bytes differ: got %d want %d", len(out), want.Len())
	}
}

func TestLargeRequestBody(t *testing.T) {
	relayBase, _ := testEnv(t, echoUpstream(nil))
	c := dialTunnel(t, relayBase)
	defer c.close()
	big := bytes.Repeat([]byte("a"), 1<<20)
	body, _ := json.Marshal(map[string]string{"prompt": string(big)})
	open := newOpen("test", "POST", "/v1/chat/completions", map[string]string{"Content-Type": "application/json"}, body)
	signOpen(testSecret, open)
	status, _, out := fullExchange(t, c, open, body)
	if status != 200 || !bytes.Equal(out, body) {
		t.Fatalf("status=%d len=%d want %d", status, len(out), len(body))
	}
}

func TestBinaryExactness(t *testing.T) {
	prng := rand.NewPCG(42, 0)
	want := make([]byte, 1<<20)
	for i := 0; i < len(want); i += 8 {
		binary.LittleEndian.PutUint64(want[i:], prng.Uint64())
	}
	sum := sha256.Sum256(want)
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(want)
	})
	relayBase, _ := testEnv(t, upstream)
	c := dialTunnel(t, relayBase)
	defer c.close()
	body := []byte(`{}`)
	open := newOpen("test", "POST", "/v1/chat/completions", nil, body)
	signOpen(testSecret, open)
	status, headers, out := fullExchange(t, c, open, body)
	if status != 200 {
		t.Fatalf("status = %d", status)
	}
	if headers["content-type"] != "application/octet-stream" {
		t.Fatalf("content-type = %q", headers)
	}
	got := sha256.Sum256(out)
	if hex.EncodeToString(got[:]) != hex.EncodeToString(sum[:]) {
		t.Fatalf("binary payload corrupted")
	}
}

func TestConcurrentStreams(t *testing.T) {
	relayBase, hits := testEnv(t, sseUpstream(20, 5*time.Millisecond, nil))
	var wg sync.WaitGroup
	errs := make(chan string, 20)
	for i := range 20 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c := dialTunnel(t, relayBase)
			defer c.close()
			body := []byte(fmt.Sprintf(`{"n":%d}`, i))
			open := newOpen("test", "POST", "/v1/chat/completions", nil, body)
			signOpen(testSecret, open)
			status, _, out := fullExchange(t, c, open, body)
			if status != 200 {
				errs <- fmt.Sprintf("stream %d status %d", i, status)
				return
			}
			if count := bytes.Count(out, []byte("data: {\"i\":")); count != 20 {
				errs <- fmt.Sprintf("stream %d chunks %d", i, count)
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Error(e)
	}
	if hits.Load() != 20 {
		t.Fatalf("hits = %d, want exactly 20 (no duplication, no loss)", hits.Load())
	}
}

func TestNoUpstreamBeforeRequestEnd(t *testing.T) {
	// Client vanishes after open but before request_end: upstream must never
	// be contacted, so no billable generation can start.
	relayBase, hits := testEnv(t, echoUpstream(nil))
	c := dialTunnel(t, relayBase)
	body := []byte(`{"expensive":true}`)
	open := newOpen("test", "POST", "/v1/chat/completions", nil, body)
	signOpen(testSecret, open)
	raw, _ := json.Marshal(open)
	c.sendText(raw)
	c.close()
	time.Sleep(500 * time.Millisecond)
	if hits.Load() != 0 {
		t.Fatalf("upstream hit without completed request")
	}
}

func TestAuthUnit(t *testing.T) {
	a, err := NewAuth("unit-secret-1234567890")
	if err != nil {
		t.Fatalf("NewAuth: %v", err)
	}
	if _, err := NewAuth("short"); err == nil {
		t.Fatalf("short secret must be rejected")
	}
	mk := func() *OpenMessage {
		o := newOpen("test", "POST", "/v1/x", nil, []byte(`{}`))
		signOpen("unit-secret-1234567890", o)
		return o
	}
	if err := a.VerifyOpen(mk()); err != nil {
		t.Fatalf("valid open rejected: %v", err)
	}
	bad := mk()
	bad.Signature = "00" + bad.Signature[2:]
	if err := a.VerifyOpen(bad); err == nil {
		t.Fatalf("tampered signature accepted")
	}
	old := mk()
	old.Timestamp = fmt.Sprintf("%d", time.Now().Add(-10*time.Minute).UnixMilli())
	// Re-sign with the old timestamp so only freshness fails.
	mac := signWith("unit-secret-1234567890", old)
	old.Signature = mac
	if err := a.VerifyOpen(old); err == nil {
		t.Fatalf("stale timestamp accepted")
	}
}

func signWith(secret string, o *OpenMessage) string {
	mac := hmacSHA256(secret, CanonicalString(o.Timestamp, o.Nonce, o.RequestID, o.Provider, o.Method, o.Path, o.Query, o.BodySHA256))
	return mac
}

func TestResolveURLUnit(t *testing.T) {
	providers := map[string]Provider{}
	for _, p := range DefaultProviders() {
		providers[p.ID] = p
	}
	ok := []struct{ provider, path string }{
		{"openai", "/v1/chat/completions"},
		{"openrouter", "/api/v1/chat/completions"},
		{"anthropic", "/v1/messages"},
		{"gentrouter", "/messages"},
		{"opencode", "/zen/v1/chat/completions"},
	}
	for _, c := range ok {
		if _, err := ResolveURL(providers, c.provider, "POST", c.path, ""); err != nil {
			t.Errorf("%s %s: %v", c.provider, c.path, err)
		}
	}
	bad := []struct{ provider, method, path, query string }{
		{"openai", "PUT", "/v1/chat/completions", ""},
		{"nosuch", "POST", "/v1/chat/completions", ""},
		{"openai", "POST", "/v2/chat/completions", ""},
		{"openai", "POST", "/v1/chat/completions", "api_key=x"},
		{"openai", "POST", "/v1/chat/completions", "x=1#frag"},
	}
	for _, c := range bad {
		if _, err := ResolveURL(providers, c.provider, c.method, c.path, c.query); err == nil {
			t.Errorf("%+v accepted", c)
		}
	}
}

func TestPublicIPUnit(t *testing.T) {
	for _, tc := range []struct {
		ip   string
		want bool
	}{
		{"8.8.8.8", true},
		{"1.1.1.1", true},
		{"127.0.0.1", false},
		{"10.0.0.5", false},
		{"192.168.1.1", false},
		{"172.16.0.1", false},
		{"169.254.169.254", false},
		{"100.100.100.200", false},
		{"::1", false},
		{"fc00::1", false},
		{"224.0.0.1", false},
	} {
		if got := isPublicIP(parseIP(tc.ip)); got != tc.want {
			t.Errorf("%s = %v, want %v", tc.ip, got, tc.want)
		}
	}
}

func BenchmarkRelayThroughput(b *testing.B) {
	payload := bytes.Repeat([]byte("x"), 32*1024)
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		for range 64 {
			_, _ = w.Write(payload)
		}
	})
	relayBase, _ := testEnv(b, upstream)
	b.ResetTimer()
	b.SetBytes(int64(64 * len(payload)))
	for range b.N {
		c := dialTunnel(b, relayBase)
		body := []byte(`{}`)
		open := newOpen("test", "POST", "/v1/chat/completions", nil, body)
		signOpen(testSecret, open)
		_, _, out := fullExchange(b, c, open, body)
		c.close()
		if len(out) != 64*len(payload) {
			b.Fatalf("short read: %d", len(out))
		}
	}
}

// Command zaihttp is a tiny localhost proxy that gives the gateway a Chrome
// TLS fingerprint for chat.z.ai.
//
// Why: the Z.AI/Aliyun edge inspects the TLS ClientHello. Go's and Node's
// default stacks present a non-browser handshake and get challenged, so the
// signed transport cannot survive on `fetch` alone. This helper dials
// chat.z.ai with uTLS (Chrome hello, HTTP/1.1) and streams the response back,
// letting the gateway keep its normal HTTP shape.
//
// Egress is process-sticky via ZAI_EGRESS_PROXY: empty (direct TCP),
// http(s):// (HTTP CONNECT), or socks5/socks5h:// (real SOCKS5, socks5h
// does remote DNS). uTLS always happens AFTER the tunnel is up, so
// chat.z.ai still sees a Chrome ClientHello. One helper process = one
// egress identity; do not rotate the proxy mid-session.
//
// It is intentionally narrow: only https://chat.z.ai is dialable, only POST
// /proxy is served, and it listens on loopback unless told otherwise.
//
//	go run ./cmd/zaihttp                    # 127.0.0.1:8477
//	ZAI_UTLS_PROXY=http://127.0.0.1:8477    # gateway side
//	ZAI_EGRESS_PROXY=socks5h://127.0.0.1:9050
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"fmt"
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
	egress, err := parseEgress(os.Getenv("ZAI_EGRESS_PROXY"))
	if err != nil {
		log.Fatalf("ZAI_EGRESS_PROXY: %v", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true,"egress":"`+egress.kind+`"}`)
	})
	mux.HandleFunc("/proxy", handleProxy)
	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("zaihttp listening addr=%s target=%s egress=%s", addr, targetHost, egress.kind)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("listen: %v", err)
	}
}

type egressConfig struct {
	kind     string // direct | http | https | socks5
	addr     string // host:port of the proxy, empty for direct
	user     string
	pass     string
	remoteDNS bool // socks5h: send hostname to the proxy
}

func parseEgress(raw string) (egressConfig, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return egressConfig{kind: "direct"}, nil
	}
	u, err := url.Parse(s)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return egressConfig{}, fmt.Errorf("invalid")
	}
	user, pass := "", ""
	if u.User != nil {
		user = u.User.Username()
		pass, _ = u.User.Password()
	}
	host := u.Host
	if !strings.Contains(host, ":") {
		switch u.Scheme {
		case "http":
			host += ":80"
		case "https":
			host += ":443"
		case "socks5", "socks5h":
			host += ":1080"
		}
	}
	switch strings.ToLower(u.Scheme) {
	case "http":
		return egressConfig{kind: "http", addr: host, user: user, pass: pass}, nil
	case "https":
		return egressConfig{kind: "https", addr: host, user: user, pass: pass}, nil
	case "socks5":
		return egressConfig{kind: "socks5", addr: host, user: user, pass: pass, remoteDNS: false}, nil
	case "socks5h":
		return egressConfig{kind: "socks5", addr: host, user: user, pass: pass, remoteDNS: true}, nil
	default:
		return egressConfig{}, fmt.Errorf("unsupported scheme")
	}
}

func dialUpstream(ctx context.Context, egress egressConfig) (net.Conn, error) {
	d := &net.Dialer{Timeout: 15 * time.Second}
	target := targetHost + ":443"
	if egress.kind == "direct" {
		return d.DialContext(ctx, "tcp", target)
	}
	proxyConn, err := d.DialContext(ctx, "tcp", egress.addr)
	if err != nil {
		return nil, err
	}
	var ready net.Conn = proxyConn
	if egress.kind == "https" {
		host, _, _ := net.SplitHostPort(egress.addr)
		tlsConn := tls.Client(proxyConn, &tls.Config{ServerName: host, NextProtos: []string{"http/1.1"}})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			proxyConn.Close()
			return nil, err
		}
		ready = tlsConn
	}
	switch egress.kind {
	case "http", "https":
		if err := httpConnect(ctx, ready, target, egress); err != nil {
			ready.Close()
			return nil, err
		}
		return ready, nil
	case "socks5":
		if err := socks5Connect(ctx, ready, targetHost, 443, egress); err != nil {
			ready.Close()
			return nil, err
		}
		return ready, nil
	default:
		ready.Close()
		return nil, fmt.Errorf("unsupported egress")
	}
}

func httpConnect(ctx context.Context, conn net.Conn, target string, egress egressConfig) error {
	var b strings.Builder
	b.WriteString("CONNECT " + target + " HTTP/1.1\r\n")
	b.WriteString("Host: " + target + "\r\n")
	if egress.user != "" {
		token := base64.StdEncoding.EncodeToString([]byte(egress.user + ":" + egress.pass))
		b.WriteString("Proxy-Authorization: Basic " + token + "\r\n")
	}
	b.WriteString("\r\n")
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
		defer conn.SetDeadline(time.Time{})
	}
	if _, err := io.WriteString(conn, b.String()); err != nil {
		return err
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("connect status %d", resp.StatusCode)
	}
	return nil
}

func socks5Connect(ctx context.Context, conn net.Conn, host string, port uint16, egress egressConfig) error {
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
		defer conn.SetDeadline(time.Time{})
	}
	methods := []byte{0x00}
	if egress.user != "" {
		methods = []byte{0x02, 0x00}
	}
	greet := append([]byte{0x05, byte(len(methods))}, methods...)
	if _, err := conn.Write(greet); err != nil {
		return err
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil {
		return err
	}
	if reply[0] != 0x05 {
		return fmt.Errorf("socks version")
	}
	switch reply[1] {
	case 0x00:
		// no auth
	case 0x02:
		u := []byte(egress.user)
		p := []byte(egress.pass)
		auth := make([]byte, 0, 3+len(u)+len(p))
		auth = append(auth, 0x01, byte(len(u)))
		auth = append(auth, u...)
		auth = append(auth, byte(len(p)))
		auth = append(auth, p...)
		if _, err := conn.Write(auth); err != nil {
			return err
		}
		ar := make([]byte, 2)
		if _, err := io.ReadFull(conn, ar); err != nil {
			return err
		}
		if ar[1] != 0x00 {
			return fmt.Errorf("socks auth")
		}
	default:
		return fmt.Errorf("socks method")
	}

	req := []byte{0x05, 0x01, 0x00}
	if egress.remoteDNS {
		req = append(req, 0x03, byte(len(host)))
		req = append(req, []byte(host)...)
	} else if ip := net.ParseIP(host); ip != nil {
		if v4 := ip.To4(); v4 != nil {
			req = append(req, 0x01)
			req = append(req, v4...)
		} else {
			req = append(req, 0x04)
			req = append(req, ip.To16()...)
		}
	} else {
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil || len(ips) == 0 {
			return fmt.Errorf("socks resolve")
		}
		ip := ips[0].IP
		if v4 := ip.To4(); v4 != nil {
			req = append(req, 0x01)
			req = append(req, v4...)
		} else {
			req = append(req, 0x04)
			req = append(req, ip.To16()...)
		}
	}
	portBytes := make([]byte, 2)
	binary.BigEndian.PutUint16(portBytes, port)
	req = append(req, portBytes...)
	if _, err := conn.Write(req); err != nil {
		return err
	}
	hdr := make([]byte, 4)
	if _, err := io.ReadFull(conn, hdr); err != nil {
		return err
	}
	if hdr[1] != 0x00 {
		return fmt.Errorf("socks status %d", hdr[1])
	}
	switch hdr[3] {
	case 0x01:
		_, err := io.CopyN(io.Discard, conn, 4+2)
		return err
	case 0x03:
		l := make([]byte, 1)
		if _, err := io.ReadFull(conn, l); err != nil {
			return err
		}
		_, err := io.CopyN(io.Discard, conn, int64(l[0])+2)
		return err
	case 0x04:
		_, err := io.CopyN(io.Discard, conn, 16+2)
		return err
	default:
		return fmt.Errorf("socks atyp")
	}
}

func sanitizeDialErr(err error) string {
	if err == nil {
		return "dial failed"
	}
	s := err.Error()
	// Never leak proxy URLs, credentials, or host:port of the egress.
	if strings.Contains(s, "socks") {
		return "egress tunnel failed"
	}
	if strings.Contains(s, "connect status") {
		return "egress tunnel failed"
	}
	return "dial failed"
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

	egress, _ := parseEgress(os.Getenv("ZAI_EGRESS_PROXY"))
	conn, err := dialUpstream(ctx, egress)
	if err != nil {
		http.Error(w, sanitizeDialErr(err), http.StatusBadGateway)
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

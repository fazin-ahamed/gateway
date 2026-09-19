// Package egress is the shared proxy-tunnel implementation used both by the
// production zaihttp proxy path and by the loopback proxy-pool checker.
//
// One egress establishes a raw TCP path to a target host:port through an
// optional proxy: direct TCP, HTTP CONNECT, HTTPS CONNECT, SOCKS5 (local DNS)
// or SOCKS5H (remote DNS). TLS to the *target* is always the caller's job and
// happens after Dial returns, so the production path can layer uTLS on top and
// still present a Chrome ClientHello to chat.z.ai.
package egress

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Canonical failure classes. These are the only strings the checker records,
// so a caller never has to parse a raw error message.
const (
	ClassConnectTimeout = "connect_timeout"
	ClassConnectFailed  = "connect_failed"
	ClassDNSFailed      = "dns_failed"
	ClassAuthFailed     = "auth_failed"
	ClassTunnelRejected = "tunnel_rejected"
	ClassTLSFailed      = "tls_failed"
	ClassRequestFailed  = "request_failed"
	ClassBadConfig      = "bad_config"
)

// NegotiationTimeout bounds proxy connect + tunnel + proxy-TLS. The caller
// clears the conn deadline before streaming a real (possibly long) body.
const NegotiationTimeout = 15 * time.Second

// Config is a parsed egress. The zero value with Kind=="direct" is a direct
// dial.
type Config struct {
	Kind      string // direct | http | https | socks5
	Addr      string // proxy host:port, empty for direct
	User      string
	Pass      string
	RemoteDNS bool // socks5h: hostname is resolved by the proxy
}

// classErr carries a canonical failure class alongside the underlying error.
type classErr struct {
	class string
	err   error
}

func (e *classErr) Error() string { return e.class + ": " + e.err.Error() }
func (e *classErr) Unwrap() error { return e.err }

// Class extracts the canonical failure class from an error returned by Dial,
// defaulting to connect_failed for anything unclassified.
func Class(err error) string {
	var ce *classErr
	if errors.As(err, &ce) {
		return ce.class
	}
	return ClassConnectFailed
}

// Parse normalizes a proxy URL. Empty is direct. Rejects path/query/fragment,
// over-long SOCKS credentials, and unknown schemes. IPv6 literals are handled
// via Hostname()/Port().
func Parse(raw string) (Config, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return Config{Kind: "direct"}, nil
	}
	u, err := url.Parse(s)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return Config{}, fmt.Errorf("invalid proxy url")
	}
	if u.Path != "" && u.Path != "/" {
		return Config{}, fmt.Errorf("unexpected path")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return Config{}, fmt.Errorf("unexpected query/fragment")
	}
	user, pass := "", ""
	if u.User != nil {
		user = u.User.Username()
		pass, _ = u.User.Password()
	}
	if len(user) > 255 || len(pass) > 255 {
		return Config{}, fmt.Errorf("credential too long")
	}
	host := u.Hostname()
	port := u.Port()
	if host == "" {
		return Config{}, fmt.Errorf("no host")
	}
	if port == "" {
		switch strings.ToLower(u.Scheme) {
		case "http":
			port = "80"
		case "https":
			port = "443"
		case "socks5", "socks5h":
			port = "1080"
		}
	}
	addr := net.JoinHostPort(host, port)
	switch strings.ToLower(u.Scheme) {
	case "http":
		return Config{Kind: "http", Addr: addr, User: user, Pass: pass}, nil
	case "https":
		return Config{Kind: "https", Addr: addr, User: user, Pass: pass}, nil
	case "socks5":
		return Config{Kind: "socks5", Addr: addr, User: user, Pass: pass, RemoteDNS: false}, nil
	case "socks5h":
		return Config{Kind: "socks5", Addr: addr, User: user, Pass: pass, RemoteDNS: true}, nil
	default:
		return Config{}, fmt.Errorf("unsupported scheme")
	}
}

// Timings records how long each negotiation stage took, in milliseconds.
type Timings struct {
	ConnectMs int64
	TunnelMs  int64
}

// Dial opens a tunnel to targetHost:targetPort. On success the returned conn
// carries no deadline (the negotiation deadline is cleared) so the caller can
// stream freely. Errors carry a canonical failure class (see Class).
func (c Config) Dial(ctx context.Context, targetHost string, targetPort uint16) (net.Conn, Timings, error) {
	var t Timings
	target := net.JoinHostPort(targetHost, fmt.Sprintf("%d", targetPort))
	d := &net.Dialer{Timeout: 15 * time.Second}
	if c.Kind == "direct" || c.Kind == "" {
		start := time.Now()
		conn, err := d.DialContext(ctx, "tcp", target)
		t.ConnectMs = time.Since(start).Milliseconds()
		if err != nil {
			return nil, t, &classErr{connectClass(err), err}
		}
		return conn, t, nil
	}
	negCtx, negCancel := context.WithTimeout(ctx, NegotiationTimeout)
	defer negCancel()

	connectStart := time.Now()
	proxyConn, err := d.DialContext(negCtx, "tcp", c.Addr)
	t.ConnectMs = time.Since(connectStart).Milliseconds()
	if err != nil {
		return nil, t, &classErr{connectClass(err), err}
	}
	if dl, ok := negCtx.Deadline(); ok {
		_ = proxyConn.SetDeadline(dl)
	}
	tunnelStart := time.Now()
	var ready net.Conn = proxyConn
	if c.Kind == "https" {
		host := c.Addr
		if h, _, splitErr := net.SplitHostPort(c.Addr); splitErr == nil {
			host = h
		}
		tlsConn := tls.Client(proxyConn, &tls.Config{ServerName: host, NextProtos: []string{"http/1.1"}})
		if err := tlsConn.HandshakeContext(negCtx); err != nil {
			proxyConn.Close()
			t.TunnelMs = time.Since(tunnelStart).Milliseconds()
			return nil, t, &classErr{ClassTLSFailed, err}
		}
		ready = tlsConn
	}
	switch c.Kind {
	case "http", "https":
		if err := httpConnect(negCtx, ready, target, c); err != nil {
			ready.Close()
			t.TunnelMs = time.Since(tunnelStart).Milliseconds()
			return nil, t, err
		}
	case "socks5":
		if err := socks5Connect(negCtx, ready, targetHost, targetPort, c); err != nil {
			ready.Close()
			t.TunnelMs = time.Since(tunnelStart).Milliseconds()
			return nil, t, err
		}
	default:
		ready.Close()
		return nil, t, &classErr{ClassBadConfig, fmt.Errorf("unsupported egress")}
	}
	t.TunnelMs = time.Since(tunnelStart).Milliseconds()
	_ = proxyConn.SetDeadline(time.Time{})
	return ready, t, nil
}

func connectClass(err error) string {
	if err == nil {
		return ClassConnectFailed
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return ClassConnectTimeout
	}
	var de *net.DNSError
	if errors.As(err, &de) {
		return ClassDNSFailed
	}
	return ClassConnectFailed
}

func httpConnect(ctx context.Context, conn net.Conn, target string, c Config) error {
	var b strings.Builder
	b.WriteString("CONNECT " + target + " HTTP/1.1\r\n")
	b.WriteString("Host: " + target + "\r\n")
	if c.User != "" {
		token := base64.StdEncoding.EncodeToString([]byte(c.User + ":" + c.Pass))
		b.WriteString("Proxy-Authorization: Basic " + token + "\r\n")
	}
	b.WriteString("\r\n")
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	if _, err := io.WriteString(conn, b.String()); err != nil {
		return &classErr{ClassTunnelRejected, err}
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil {
		return &classErr{ClassTunnelRejected, err}
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusProxyAuthRequired {
		return &classErr{ClassAuthFailed, fmt.Errorf("proxy auth required")}
	}
	if resp.StatusCode != http.StatusOK {
		return &classErr{ClassTunnelRejected, fmt.Errorf("connect status %d", resp.StatusCode)}
	}
	return nil
}

func socks5Connect(ctx context.Context, conn net.Conn, host string, port uint16, c Config) error {
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	methods := []byte{0x00}
	if c.User != "" {
		methods = []byte{0x02, 0x00}
	}
	greet := append([]byte{0x05, byte(len(methods))}, methods...)
	if _, err := conn.Write(greet); err != nil {
		return &classErr{ClassTunnelRejected, err}
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil {
		return &classErr{ClassTunnelRejected, err}
	}
	if reply[0] != 0x05 {
		return &classErr{ClassTunnelRejected, fmt.Errorf("socks version")}
	}
	switch reply[1] {
	case 0x00:
		// no auth
	case 0x02:
		u := []byte(c.User)
		p := []byte(c.Pass)
		auth := make([]byte, 0, 3+len(u)+len(p))
		auth = append(auth, 0x01, byte(len(u)))
		auth = append(auth, u...)
		auth = append(auth, byte(len(p)))
		auth = append(auth, p...)
		if _, err := conn.Write(auth); err != nil {
			return &classErr{ClassAuthFailed, err}
		}
		ar := make([]byte, 2)
		if _, err := io.ReadFull(conn, ar); err != nil {
			return &classErr{ClassAuthFailed, err}
		}
		if ar[1] != 0x00 {
			return &classErr{ClassAuthFailed, fmt.Errorf("socks auth rejected")}
		}
	default:
		return &classErr{ClassAuthFailed, fmt.Errorf("no acceptable socks method")}
	}

	req := []byte{0x05, 0x01, 0x00}
	if c.RemoteDNS {
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
			return &classErr{ClassDNSFailed, fmt.Errorf("socks resolve")}
		}
		var chosen net.IP
		for _, a := range ips {
			if a.IP.To4() != nil {
				chosen = a.IP
				break
			}
		}
		if chosen == nil {
			chosen = ips[0].IP
		}
		if v4 := chosen.To4(); v4 != nil {
			req = append(req, 0x01)
			req = append(req, v4...)
		} else {
			req = append(req, 0x04)
			req = append(req, chosen.To16()...)
		}
	}
	portBytes := make([]byte, 2)
	binary.BigEndian.PutUint16(portBytes, port)
	req = append(req, portBytes...)
	if _, err := conn.Write(req); err != nil {
		return &classErr{ClassTunnelRejected, err}
	}
	hdr := make([]byte, 4)
	if _, err := io.ReadFull(conn, hdr); err != nil {
		return &classErr{ClassTunnelRejected, err}
	}
	if hdr[1] != 0x00 {
		return &classErr{ClassTunnelRejected, fmt.Errorf("socks status %d", hdr[1])}
	}
	switch hdr[3] {
	case 0x01:
		_, err := io.CopyN(io.Discard, conn, 4+2)
		return wrapDiscard(err)
	case 0x03:
		l := make([]byte, 1)
		if _, err := io.ReadFull(conn, l); err != nil {
			return &classErr{ClassTunnelRejected, err}
		}
		_, err := io.CopyN(io.Discard, conn, int64(l[0])+2)
		return wrapDiscard(err)
	case 0x04:
		_, err := io.CopyN(io.Discard, conn, 16+2)
		return wrapDiscard(err)
	default:
		return &classErr{ClassTunnelRejected, fmt.Errorf("socks atyp")}
	}
}

func wrapDiscard(err error) error {
	if err == nil {
		return nil
	}
	return &classErr{ClassTunnelRejected, err}
}

// CheckResult is the outcome of a single proxy connectivity test. It is
// metadata only — never the response body — so this can never be used to
// exfiltrate content through the loopback checker.
type CheckResult struct {
	Success      bool   `json:"success"`
	FailureClass string `json:"failure_class,omitempty"`
	HttpStatus   int    `json:"http_status,omitempty"`
	ConnectMs    int64  `json:"connect_ms"`
	TunnelMs     int64  `json:"tunnel_ms"`
	TLSMs        int64  `json:"tls_ms"`
	TotalMs      int64  `json:"total_ms"`
}

// Check exercises the full path: TCP → proxy negotiation → TLS to a neutral
// fixed destination → a tiny HTTP request. It never touches chat.z.ai and
// never accepts a caller-supplied destination, so it cannot be turned into a
// general-purpose SSRF proxy. It does not attempt to discover the exit IP.
func Check(ctx context.Context, cfg Config, testHost string, testPort uint16, requestPath string) CheckResult {
	overall := time.Now()
	res := CheckResult{}
	conn, timings, err := cfg.Dial(ctx, testHost, testPort)
	res.ConnectMs = timings.ConnectMs
	res.TunnelMs = timings.TunnelMs
	if err != nil {
		res.FailureClass = Class(err)
		res.TotalMs = time.Since(overall).Milliseconds()
		return res
	}
	defer conn.Close()

	tlsStart := time.Now()
	tlsConn := tls.Client(conn, &tls.Config{ServerName: testHost, NextProtos: []string{"http/1.1"}})
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		res.TLSMs = time.Since(tlsStart).Milliseconds()
		res.FailureClass = ClassTLSFailed
		res.TotalMs = time.Since(overall).Milliseconds()
		return res
	}
	res.TLSMs = time.Since(tlsStart).Milliseconds()

	req := "HEAD " + requestPath + " HTTP/1.1\r\nHost: " + testHost + "\r\nUser-Agent: zaihttp-egress-check\r\nConnection: close\r\n\r\n"
	if _, err := io.WriteString(tlsConn, req); err != nil {
		res.FailureClass = ClassRequestFailed
		res.TotalMs = time.Since(overall).Milliseconds()
		return res
	}
	br := bufio.NewReader(tlsConn)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodHead})
	if err != nil {
		res.FailureClass = ClassRequestFailed
		res.TotalMs = time.Since(overall).Milliseconds()
		return res
	}
	resp.Body.Close()
	// Any well-formed HTTP response proves the tunnel + TLS + request worked;
	// the status itself (even 403/404) is useful signal for a URL reachability
	// test. Only the status line is kept — never the body.
	res.HttpStatus = resp.StatusCode
	res.Success = true
	res.TotalMs = time.Since(overall).Milliseconds()
	return res
}

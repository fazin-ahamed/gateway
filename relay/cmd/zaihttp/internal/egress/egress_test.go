package egress

import (
	"bufio"
	"context"
	"encoding/binary"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func TestParseModes(t *testing.T) {
	d, err := Parse("")
	if err != nil || d.Kind != "direct" {
		t.Fatalf("empty: %+v %v", d, err)
	}
	h, err := Parse("http://user:secret@10.0.0.1:8080")
	if err != nil || h.Kind != "http" || h.Addr != "10.0.0.1:8080" || h.User != "user" || h.Pass != "secret" {
		t.Fatalf("http: %+v %v", h, err)
	}
	s, err := Parse("socks5://127.0.0.1:9050")
	if err != nil || s.Kind != "socks5" || s.RemoteDNS {
		t.Fatalf("socks5 should resolve locally: %+v %v", s, err)
	}
	sh, err := Parse("socks5h://127.0.0.1:9050")
	if err != nil || sh.Kind != "socks5" || !sh.RemoteDNS {
		t.Fatalf("socks5h: %+v %v", sh, err)
	}
	if _, err := Parse("ftp://127.0.0.1:21"); err == nil {
		t.Fatal("ftp must be rejected")
	}
	if _, err := Parse("not-a-url"); err == nil {
		t.Fatal("garbage must be rejected")
	}
}

func TestParseIPv6AndValidation(t *testing.T) {
	v6, err := Parse("socks5h://[::1]:9050")
	if err != nil || v6.Addr != "[::1]:9050" || !v6.RemoteDNS {
		t.Fatalf("ipv6: %+v %v", v6, err)
	}
	v6d, err := Parse("http://[2001:db8::1]")
	if err != nil || v6d.Addr != "[2001:db8::1]:80" {
		t.Fatalf("ipv6 default port: %+v %v", v6d, err)
	}
	if _, err := Parse("http://1.2.3.4:8080/path"); err == nil {
		t.Fatal("path must be rejected")
	}
	if _, err := Parse("http://1.2.3.4:8080?x=1"); err == nil {
		t.Fatal("query must be rejected")
	}
	longUser := "http://" + strings.Repeat("u", 256) + ":p@1.2.3.4:8080"
	if _, err := Parse(longUser); err == nil {
		t.Fatal("over-long username must be rejected")
	}
}

func TestClassifyConnectTimeout(t *testing.T) {
	// TEST-NET-3 is unroutable; a short deadline yields a connect timeout.
	cfg := Config{Kind: "http", Addr: "203.0.113.1:8080"}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	_, _, err := cfg.Dial(ctx, checkHostForTest, 443)
	if err == nil {
		t.Fatal("expected a dial error")
	}
	if cls := Class(err); cls != ClassConnectTimeout && cls != ClassConnectFailed {
		t.Fatalf("expected connect timeout/failed, got %s", cls)
	}
}

const checkHostForTest = "chat.z.ai"

func TestHTTPConnectSendsCONNECTAndClassifiesReject(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	gotLine := make(chan string, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		br := bufio.NewReader(c)
		line, _ := br.ReadString('\n')
		gotLine <- line
		// drain to blank line
		for {
			l, err := br.ReadString('\n')
			if err != nil || l == "\r\n" || l == "\n" {
				break
			}
		}
		_, _ = io.WriteString(c, "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
	}()
	cfg := Config{Kind: "http", Addr: ln.Addr().String()}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _, err = cfg.Dial(ctx, "chat.z.ai", 443)
	if err == nil {
		t.Fatal("403 CONNECT must be an error")
	}
	if Class(err) != ClassTunnelRejected {
		t.Fatalf("403 CONNECT should be tunnel_rejected, got %s", Class(err))
	}
	select {
	case line := <-gotLine:
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
		_, _ = c.Write([]byte{0x05, 0x00})
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
		rep := []byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0}
		port := make([]byte, 2)
		binary.BigEndian.PutUint16(port, 0)
		_, _ = c.Write(append(rep, port...))
	}()
	cfg := Config{Kind: "socks5", Addr: ln.Addr().String(), RemoteDNS: true}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, _, err := cfg.Dial(ctx, "chat.z.ai", 443); err != nil {
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

func TestSOCKS5AuthRejectedClassified(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
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
		_, _ = c.Write([]byte{0x05, 0x02}) // demand user/pass
		// read auth: ver, ulen
		vu := make([]byte, 2)
		if _, err := io.ReadFull(c, vu); err != nil {
			return
		}
		rest := make([]byte, int(vu[1]))
		_, _ = io.ReadFull(c, rest)
		pl := make([]byte, 1)
		_, _ = io.ReadFull(c, pl)
		pw := make([]byte, int(pl[0]))
		_, _ = io.ReadFull(c, pw)
		_, _ = c.Write([]byte{0x01, 0x01}) // auth failure
	}()
	cfg := Config{Kind: "socks5", Addr: ln.Addr().String(), User: "u", Pass: "bad"}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _, err = cfg.Dial(ctx, "chat.z.ai", 443)
	if err == nil {
		t.Fatal("auth failure must error")
	}
	if Class(err) != ClassAuthFailed {
		t.Fatalf("expected auth_failed, got %s", Class(err))
	}
}

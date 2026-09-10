package relay

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Minimal RFC 6455 server-side WebSocket implementation using only the
// standard library. One connection carries one proxied provider request, so
// the implementation favors small bounded buffers over features.

const (
	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xA

	maxFramePayload = 2 << 20 // 2 MiB per frame cap
	maxMessageBytes = 8 << 20 // 8 MiB fragmented-message cap
)

var (
	errClosedConn = errors.New("websocket closed")
	errProtocol   = errors.New("websocket protocol error")
)

// serveWS validates the upgrade request, hijacks the connection, and returns
// the WebSocket. Only GET + Upgrade: websocket + version 13 are accepted.
type wsConn struct {
	conn net.Conn
	rw   *bufio.ReadWriter
	wmu  sync.Mutex
	// readTimeout, when positive, extends the read deadline before every
	// frame so keepalive pongs sustain arbitrarily long streams.
	readTimeout time.Duration
}

func serveWS(w http.ResponseWriter, r *http.Request) (*wsConn, error) {
	if r.Method != http.MethodGet {
		return nil, errProtocol
	}
	if !headerHasToken(r.Header.Get("Upgrade"), "websocket") {
		return nil, errProtocol
	}
	if r.Header.Get("Sec-WebSocket-Version") != "13" {
		return nil, errProtocol
	}
	key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if key == "" {
		return nil, errProtocol
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("hijack unsupported")
	}
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		return nil, err
	}
	accept := websocketAccept(key)
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
	if _, err := rw.WriteString(resp); err != nil {
		conn.Close()
		return nil, err
	}
	if err := rw.Flush(); err != nil {
		conn.Close()
		return nil, err
	}
	return &wsConn{conn: conn, rw: rw}, nil
}

func websocketAccept(key string) string {
	h := sha1.New()
	h.Write([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

func headerHasToken(header, token string) bool {
	for part := range strings.SplitSeq(header, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}

// readMessage returns the next complete data message. Ping frames are
// answered with pong internally; close frames are acknowledged and surfaced
// as errClosedConn. Client frames must be masked.
func (c *wsConn) readMessage() (opcode int, payload []byte, err error) {
	var message []byte
	var messageOp = -1
	for {
		if c.readTimeout > 0 {
			_ = c.conn.SetReadDeadline(time.Now().Add(c.readTimeout))
		}
		fin, op, frame, err := c.readFrame()
		if err != nil {
			return 0, nil, err
		}
		switch op {
		case opPing:
			_ = c.writeFrame(opPong, frame)
			continue
		case opPong:
			continue
		case opClose:
			_ = c.writeFrame(opClose, frame)
			return 0, nil, errClosedConn
		case opText, opBinary:
			if messageOp != -1 {
				return 0, nil, errProtocol
			}
			messageOp = op
			message = frame
		case opContinuation:
			if messageOp == -1 {
				return 0, nil, errProtocol
			}
			if len(message)+len(frame) > maxMessageBytes {
				return 0, nil, errProtocol
			}
			message = append(message, frame...)
		default:
			return 0, nil, errProtocol
		}
		if fin {
			if messageOp == -1 {
				return 0, nil, errProtocol
			}
			return messageOp, message, nil
		}
	}
}

func (c *wsConn) readFrame() (fin bool, opcode int, payload []byte, err error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(c.rw, header); err != nil {
		return false, 0, nil, err
	}
	fin = header[0]&0x80 != 0
	opcode = int(header[0] & 0x0f)
	masked := header[1]&0x80 != 0
	length := int64(header[1] & 0x7f)
	switch length {
	case 126:
		ext := make([]byte, 2)
		if _, err := io.ReadFull(c.rw, ext); err != nil {
			return false, 0, nil, err
		}
		length = int64(ext[0])<<8 | int64(ext[1])
	case 127:
		ext := make([]byte, 8)
		if _, err := io.ReadFull(c.rw, ext); err != nil {
			return false, 0, nil, err
		}
		length = 0
		for i := range ext {
			length = length<<8 | int64(ext[i])
		}
		if length < 0 {
			return false, 0, nil, errProtocol
		}
	}
	isControl := opcode >= 0x8
	if isControl && (!fin || length > 125) {
		return false, 0, nil, errProtocol
	}
	if length > maxFramePayload {
		return false, 0, nil, errProtocol
	}
	// Client-to-server frames must be masked per RFC 6455.
	if !masked {
		return false, 0, nil, errProtocol
	}
	var maskKey [4]byte
	if _, err := io.ReadFull(c.rw, maskKey[:]); err != nil {
		return false, 0, nil, err
	}
	payload = make([]byte, length)
	if _, err := io.ReadFull(c.rw, payload); err != nil {
		return false, 0, nil, err
	}
	for i := range payload {
		payload[i] ^= maskKey[i%4]
	}
	return fin, opcode, payload, nil
}

// writeFrame serializes one server-to-client frame (never masked).
func (c *wsConn) writeFrame(opcode int, payload []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
	header := []byte{0x80 | byte(opcode)}
	n := len(payload)
	switch {
	case n <= 125:
		header = append(header, byte(n))
	case n <= 65535:
		header = append(header, 126, byte(n>>8), byte(n))
	default:
		header = append(header, 127, 0, 0, 0, 0, byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
	}
	if _, err := c.rw.Write(header); err != nil {
		return err
	}
	if _, err := c.rw.Write(payload); err != nil {
		return err
	}
	return c.rw.Flush()
}

func (c *wsConn) writeText(payload []byte) error   { return c.writeFrame(opText, payload) }
func (c *wsConn) writeBinary(payload []byte) error { return c.writeFrame(opBinary, payload) }
func (c *wsConn) writePing() error                 { return c.writeFrame(opPing, nil) }

func (c *wsConn) writeClose(code int) error {
	payload := []byte{byte(code >> 8), byte(code)}
	return c.writeFrame(opClose, payload)
}

func (c *wsConn) close() error { return c.conn.Close() }

// newMaskKey generates a client masking key.
func newMaskKey() [4]byte {
	var key [4]byte
	_, _ = rand.Read(key[:])
	return key
}

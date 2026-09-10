package relay

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"
)

// Auth validates Worker open messages. Replay resistance comes from a
// timestamp window plus a bounded in-memory nonce cache. The cache is
// per-instance; HMAC + timestamp window remain the primary defense if more
// than one instance ever runs.
type Auth struct {
	secret    []byte
	window    time.Duration
	mu        sync.Mutex
	nonces    map[string]int64
	order     []string
	maxNonces int
	now       func() time.Time
}

// NewAuth requires a secret of at least 16 characters.
func NewAuth(secret string) (*Auth, error) {
	if len(secret) < 16 {
		return nil, errors.New("KOYEB_RELAY_SECRET must be at least 16 characters")
	}
	return &Auth{
		secret:    []byte(secret),
		window:    5 * time.Minute,
		nonces:    make(map[string]int64),
		maxNonces: 20000,
		now:       time.Now,
	}, nil
}

// CanonicalString builds the signed payload. Body is covered by its SHA-256,
// never by embedding the body itself.
func CanonicalString(timestamp, nonce, requestID, provider, method, path, query, bodySHA256 string) string {
	return "v1\n" + timestamp + "\n" + nonce + "\n" + requestID + "\n" + provider + "\n" + method + "\n" + path + "\n" + query + "\n" + bodySHA256
}

// Sign returns the hex HMAC-SHA256 of the canonical string.
func (a *Auth) Sign(canonical string) string {
	mac := hmac.New(sha256.New, a.secret)
	mac.Write([]byte(canonical))
	return hex.EncodeToString(mac.Sum(nil))
}

// VerifyOpen checks timestamp, nonce freshness, and signature in constant time.
func (a *Auth) VerifyOpen(o *OpenMessage) error {
	if o.Version != 1 {
		return errors.New("unsupported protocol version")
	}
	if len(o.Nonce) < 16 || len(o.Nonce) > 128 {
		return errors.New("bad nonce")
	}
	ts, err := strconv.ParseInt(o.Timestamp, 10, 64)
	if err != nil {
		return errors.New("bad timestamp")
	}
	now := a.now().UnixMilli()
	drift := now - ts
	if drift < 0 {
		drift = -drift
	}
	if drift > int64(a.window/time.Millisecond) {
		return errors.New("stale timestamp")
	}
	if o.RequestID == "" || len(o.RequestID) > 128 {
		return errors.New("bad request id")
	}
	canonical := CanonicalString(o.Timestamp, o.Nonce, o.RequestID, o.Provider, o.Method, o.Path, o.Query, o.BodySHA256)
	mac := hmac.New(sha256.New, a.secret)
	mac.Write([]byte(canonical))
	want := mac.Sum(nil)
	got, err := hex.DecodeString(o.Signature)
	if err != nil {
		return errors.New("bad signature encoding")
	}
	if subtle.ConstantTimeCompare(got, want) != 1 {
		return fmt.Errorf("bad signature")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if exp, seen := a.nonces[o.Nonce]; seen && exp > now {
		return errors.New("replayed nonce")
	}
	// Evict oldest nonces when full to keep memory bounded.
	for len(a.order) >= a.maxNonces {
		oldest := a.order[0]
		a.order = a.order[1:]
		delete(a.nonces, oldest)
	}
	a.nonces[o.Nonce] = now + int64((10*time.Minute)/time.Millisecond)
	a.order = append(a.order, o.Nonce)
	// Opportunistic expiry sweep on every 512th insert.
	if len(a.order)%512 == 0 {
		kept := a.order[:0]
		for _, n := range a.order {
			if a.nonces[n] > now {
				kept = append(kept, n)
			} else {
				delete(a.nonces, n)
			}
		}
		a.order = kept
	}
	return nil
}

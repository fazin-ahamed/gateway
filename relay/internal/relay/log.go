package relay

import (
	"log"
	"time"
)

// Fields are the sanitized structured log fields. Credentials, headers,
// prompts, and response bodies must never be added here.
type Fields struct {
	RequestID  string
	Provider   string
	Transport  string
	Status     int
	ConnectMs  int64
	TTFBms     int64
	DurationMs int64
	BytesIn    int64
	BytesOut   int64
	Disconnect string
	ColdStart  bool
	ErrorClass string
}

func Log(f Fields) {
	log.Printf("request_id=%s provider=%s transport=%s status=%d connect_ms=%d ttfb_ms=%d duration_ms=%d bytes_in=%d bytes_out=%d disconnect=%s cold_start=%v error_class=%s",
		f.RequestID, f.Provider, f.Transport, f.Status, f.ConnectMs, f.TTFBms, f.DurationMs, f.BytesIn, f.BytesOut, f.Disconnect, f.ColdStart, f.ErrorClass)
}

func millis(d time.Duration) int64 { return int64(d / time.Millisecond) }

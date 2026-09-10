package relay

// Protocol messages. Control frames are small JSON text frames; provider
// response bytes travel as raw binary frames and are never parsed.
type OpenMessage struct {
	Type       string            `json:"type"`
	Version    int               `json:"version"`
	RequestID  string            `json:"requestId"`
	Provider   string            `json:"provider"`
	Method     string            `json:"method"`
	Path       string            `json:"path"`
	Query      string            `json:"query"`
	Headers    map[string]string `json:"headers"`
	BodySHA256 string            `json:"bodySha256"`
	BodyLen    int               `json:"bodyLen"`
	Timestamp  string            `json:"timestamp"`
	Nonce      string            `json:"nonce"`
	Signature  string            `json:"signature"`
}

type RequestEndMessage struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
}

type AcceptedMessage struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
}

type ResponseMessage struct {
	Type      string            `json:"type"`
	RequestID string            `json:"requestId"`
	Status    int               `json:"status"`
	Headers   map[string]string `json:"headers"`
}

type ResponseEndMessage struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	Bytes     int64  `json:"bytes"`
}

type ErrorMessage struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

// Forwardable request headers. Everything else from the Worker is dropped.
// Provider credentials stay in the gateway; they arrive here inside the
// authenticated tunnel and are forwarded only to the allowlisted upstream.
var forwardRequestHeaders = map[string]bool{
	"content-type":      true,
	"accept":            true,
	"authorization":     true,
	"x-api-key":         true,
	"anthropic-version": true,
	"anthropic-title":   true,
	"http-referer":      true,
	"x-title":           true,
}

// Forwardable response headers. Hop-by-hop, internal, and credential-adjacent
// headers are stripped.
var forwardResponseHeaders = map[string]bool{
	"content-type": true,
	"retry-after":  true,
	"x-request-id": true,
	"x-trace-id":   true,
}

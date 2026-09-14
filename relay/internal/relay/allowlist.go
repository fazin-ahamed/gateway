package relay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
)

// Provider is one allowlisted upstream: exact scheme + host plus allowed
// path prefixes. There is intentionally no free-form URL field anywhere.
type Provider struct {
	ID           string   `json:"id"`
	Scheme       string   `json:"scheme"`
	Host         string   `json:"host"`
	PathPrefixes []string `json:"path_prefixes"`
}

// DefaultProviders covers common first-party AI endpoints. Unknown providers
// are rejected. Add private gateways via RELAY_PROVIDERS_JSON instead of
// committing their hostnames here.
func DefaultProviders() []Provider {
	return []Provider{
		{ID: "openai", Scheme: "https", Host: "api.openai.com", PathPrefixes: []string{"/v1/"}},
		{ID: "anthropic", Scheme: "https", Host: "api.anthropic.com", PathPrefixes: []string{"/v1/"}},
		{ID: "openrouter", Scheme: "https", Host: "openrouter.ai", PathPrefixes: []string{"/api/v1/"}},
		{ID: "groq", Scheme: "https", Host: "api.groq.com", PathPrefixes: []string{"/openai/v1/"}},
		{ID: "gemini", Scheme: "https", Host: "generativelanguage.googleapis.com", PathPrefixes: []string{"/v1beta/", "/v1/"}},
		{ID: "deepseek", Scheme: "https", Host: "api.deepseek.com", PathPrefixes: []string{"/v1/"}},
		{ID: "mistral", Scheme: "https", Host: "api.mistral.ai", PathPrefixes: []string{"/v1/"}},
		{ID: "xai", Scheme: "https", Host: "api.x.ai", PathPrefixes: []string{"/v1/"}},
		{ID: "together", Scheme: "https", Host: "api.together.xyz", PathPrefixes: []string{"/v1/"}},
		{ID: "fireworks", Scheme: "https", Host: "api.fireworks.ai", PathPrefixes: []string{"/inference/v1/"}},
	}
}

// ResolveURL maps provider + path + query to an upstream URL or rejects.
func ResolveURL(providers map[string]Provider, provider, method, rawPath, rawQuery string) (*url.URL, error) {
	p, ok := providers[strings.ToLower(provider)]
	if !ok {
		return nil, errors.New("unknown provider")
	}
	if method != http.MethodPost && method != http.MethodGet {
		return nil, errors.New("method not allowed")
	}
	if rawPath == "" || !strings.HasPrefix(rawPath, "/") {
		return nil, errors.New("bad path")
	}
	if strings.Contains(rawPath, "\\") || !isPrintableASCII(rawPath) {
		return nil, errors.New("bad path")
	}
	clean := path.Clean(rawPath)
	if clean != rawPath || strings.HasPrefix(clean, "/..") {
		return nil, errors.New("bad path")
	}
	allowed := false
	for _, prefix := range p.PathPrefixes {
		if strings.HasPrefix(clean+"/", prefix) || clean == strings.TrimSuffix(prefix, "/") {
			allowed = true
			break
		}
	}
	if !allowed {
		return nil, errors.New("path not allowed")
	}
	if rawQuery != "" {
		if !isPrintableASCII(rawQuery) || strings.Contains(rawQuery, "#") {
			return nil, errors.New("bad query")
		}
		lower := strings.ToLower(rawQuery)
		for _, banned := range []string{"key=", "token=", "secret=", "auth", "password="} {
			if strings.Contains(lower, banned) {
				return nil, errors.New("credentials in query are not allowed")
			}
		}
	}
	u := &url.URL{Scheme: p.Scheme, Host: p.Host, Path: clean, RawQuery: rawQuery}
	if u.Host != p.Host {
		return nil, errors.New("host mismatch")
	}
	return u, nil
}

func isPrintableASCII(s string) bool {
	for i := range s {
		if s[i] < 0x20 || s[i] > 0x7e {
			return false
		}
	}
	return true
}
func PublicIPOnlyDialer(base *net.Dialer) func(ctx context.Context, network, addr string) (net.Conn, error) {
	// RELAY_ALLOW_PRIVATE=1 is a test-only escape hatch for synthetic
	// providers on loopback. Never set it in production.
	if os.Getenv("RELAY_ALLOW_PRIVATE") == "1" {
		return base.DialContext
	}
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
		if err != nil {
			return nil, err
		}
		for _, ip := range ips {
			if !isPublicIP(ip) {
				return nil, fmt.Errorf("blocked non-public upstream ip for %s", host)
			}
		}
		return base.DialContext(ctx, network, net.JoinHostPort(ips[0].String(), port))
	}
}

func isPublicIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsMulticast() || !ip.IsGlobalUnicast() {
		return false
	}
	// Cloud metadata endpoints, explicit even though covered above.
	if ip.String() == "169.254.169.254" || ip.String() == "100.100.100.200" {
		return false
	}
	return true
}

// ProvidersFromEnv parses RELAY_PROVIDERS_JSON to add or override providers.
func ProvidersFromEnv() ([]Provider, error) {
	raw := strings.TrimSpace(os.Getenv("RELAY_PROVIDERS_JSON"))
	if raw == "" {
		return nil, nil
	}
	var extra []Provider
	if err := json.Unmarshal([]byte(raw), &extra); err != nil {
		return nil, fmt.Errorf("RELAY_PROVIDERS_JSON: %w", err)
	}
	for _, p := range extra {
		if p.ID == "" || (p.Scheme != "https" && p.Scheme != "http") || p.Host == "" || len(p.PathPrefixes) == 0 {
			return nil, errors.New("RELAY_PROVIDERS_JSON: each provider needs id, scheme, host, path_prefixes")
		}
		if strings.ToLower(p.Scheme) != "https" && !strings.HasPrefix(os.Getenv("RELAY_ALLOW_HTTP"), "1") {
			return nil, errors.New("RELAY_PROVIDERS_JSON: only https is allowed")
		}
	}
	return extra, nil
}

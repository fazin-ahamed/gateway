# Astrosphere

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The operator uses the existing console to manage API access and inspect AI usage. Public visitors need a read-only overview of recorded token usage, the model catalogue, and gateway information without signing in.

## Product Purpose

Astrosphere is a self-hosted AI gateway with an OpenAI-compatible API and a management console. The root page makes aggregate usage and model information accessible without navigating into the console.

## Operating Context

The shared Hono application runs on a Node host with SQLite and on Cloudflare Workers with D1. The existing Svelte console is served under `/console`; API clients use `/v1`. The Node deployment currently uses an allocated high port in a hosting container.

## Capabilities and Constraints

The public view is read-only. API calls and private console operations retain their existing authentication. Public responses must exclude API keys, account identities, request bodies, request headers, costs, provider credentials, provider URLs, and internal routing identifiers.

Usage must come from the body-free `request_summaries` ledger rather than optional trajectory capture. Totals describe recorded history, not an unverifiable lifetime total. Unknown values remain unknown. Model capabilities and availability must follow the gateway's existing serving rules.

Existing console behavior and unrelated working-tree deployment changes remain unchanged.

## Brand Commitments

The user confirmed Astrosphere as the public name and requested the existing console identity be preserved. Antislop applies during implementation.

## Evidence on Hand

- `client-console/src/lib/styles/tokens.css` defines the existing Astrosphere identity and light/dark palettes.
- `client-console/src/routes/+page.svelte` implements the signed-in usage overview.
- `ai-gateway/src/console/request-ledger.js` records body-free request usage.
- `ai-gateway/src/index.js` implements model discovery, health, and authenticated console routes.
- The existing Node sign-in view was verified in a real browser at the public host.

## Product Principles

- Show recorded measurements instead of fabricated activity or reliability claims.
- Keep public aggregates separate from private account operations.
- Preserve model capability and availability semantics across runtimes.
- Make the public directory usable on narrow screens and with a keyboard.

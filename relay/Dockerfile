# syntax=docker/dockerfile:1

# ---- build ----
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download 2>/dev/null || true
COPY . ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/relay ./cmd/relay

# ---- run ----
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/relay /relay
# Koyeb injects $PORT and terminates TLS at the edge; the relay speaks
# plain HTTP/WebSocket on $PORT behind it.
EXPOSE 8000
USER nonroot:nonroot
ENTRYPOINT ["/relay"]

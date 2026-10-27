# ADR 0002 — All server traffic of the desktop app goes through Rust

Status: accepted for Phase 1

## Context

The server uses a self-signed certificate. Trust comes from the fingerprint the user confirms once
(SPEC 4.14), not from a certificate authority. The web view (WebView2) cannot pin a certificate,
and it must not trust the certificate globally either.

## Decision

- Every API call goes through a Tauri command (`api_request`). The Rust side (`server-link`) uses a
  TLS verifier that accepts **only** the confirmed certificate.
- Access and refresh tokens stay in Rust memory and never reach the interface code. The access token
  is refreshed before it expires, and again once after a 401 `UNAUTHENTICATED`. Any other 401 (idle
  time, disabled account) ends the session, and the interface is told about it.
- Realtime (Socket.IO, SPEC 3.2): `server-link/src/socket.rs` is a minimal Socket.IO v4 client over
  WebSocket, running on the same pinned TLS connection. It speaks the standard protocol of the
  `socket.io` server (open `0`, connect `40{auth}`, ping `2`/`3`, events `42`). It reconnects after any
  loss. After every (re)connection the interface refetches everything it shows.
- The interface reaches all of this only through `src/adapters` (SPEC 3.1). The `web` adapter (plain
  HTTP, `socket.io-client`) exists only for the automated browser tests.

## Why not the official JavaScript client in the web view

It would need the web view to trust the self-signed certificate. That means installing it into the
Windows trust store, which weakens security for the whole computer.

## Session activity

The client sends `x-alyassir-user-active: 1` only after real keyboard or mouse use in the last minute.
Background refreshes do not keep a session alive. The 60-minute idle rule (SPEC 7.3) is therefore
about the person, not the network traffic.

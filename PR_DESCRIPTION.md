# Structured access log for /api/admin with req-id, latency, status, size, actor

## Overview
This PR implements structured access logging for the `/api/admin` route group. Every admin request now produces a consistent, machine-readable `admin_access_log` entry containing correlation ID, latency, HTTP status, response size, and actor information.

## Problem Statement
`/api/admin` requests lacked structured access logging. Admin operations (user lookups, market management, audit inspection, etc.) were invisible in the access log stream, making debugging, auditing, and operational observability difficult.

## Solution
1. **Extended `accessLog` middleware** — Added `admin_access_log` log name for `/api/admin` paths and updated actor resolution to capture `req.adminAddress` (set by `requireAdmin`), falling back to `req.user.id` and `"anonymous"`.
2. **Mounted on `/api/admin`** — Registered `app.use("/api/admin", accessLog)` before the first admin route in `src/index.ts` so the `res.on("finish")` handler is set up before any route handler produces a response.
3. **Comprehensive test suite** — 23 isolated unit tests covering all required fields, correlation preservation, latency measurement, status codes, response size, actor resolution, error paths, sensitive data protection, and multi-request isolation.

## Changes

### 1. **src/middleware/accessLog.ts** (+12/-4 lines)
- ✅ Added `admin_access_log` log name case in the route-prefix detection chain
- ✅ Updated actor resolution priority: `req.adminAddress` → `req.user?.id` → `"anonymous"`
- ✅ Updated JSDoc to document the new log name

### 2. **src/index.ts** (+7/-1 lines)
- ✅ Imported `accessLog` from middleware
- ✅ Added `app.use("/api/admin", accessLog)` before the first admin route registration
  - Critical ordering: must run before admin route handlers so the `finish` listener is attached before the response is sent

### 3. **tests/adminAccessLog.test.ts** (new, 316 lines)
- 23 tests covering:
  - Basic successful request with all 5 required fields
  - Correlation ID preservation (client-supplied, X-Request-Id fallback, UUID generation)
  - Latency measurement (numeric, non-negative)
  - HTTP status codes: 200, 400, 403, 500
  - Response size via Content-Length, absent, and empty
  - Actor from `adminAddress`, fallback to `user.id`, default to `"anonymous"`
  - All sub-paths under `/api/admin`
  - Complete access logs for error responses
  - Multi-request isolation
  - Sensitive data exclusion (no tokens, body, cookies)
  - Correlation ID sanitisation
  - X-Correlation-Id response header

### 4. **README.md** (+57 lines)
- ✅ Added "Structured Access Logging" section documenting:
  - All logged route groups and their log names
  - Complete log fields table
  - Actor resolution strategy
  - Correlation ID resolution chain
  - Security considerations

## Security Considerations
- ✅ No credentials, tokens, cookies, or auth headers logged
- ✅ Actor limited to stable identifier (Stellar address via `req.adminAddress` / user ID via `req.user?.id`)
- ✅ Correlation IDs sanitised (max 128 chars, alphanumeric + `-_` only) to prevent log injection
- ✅ Only `req.path` logged — query strings (potential PII) excluded
- ✅ Logger redacts `req.headers.authorization` and `req.headers.cookie`
- ✅ Admin auth (`requireAdmin`) not modified or weakened
- ✅ Response size measurement doesn't alter response behavior

## Testing
- ✅ **49/49 tests pass** across admin (23), users (25), and feature-flags (1) access log suites
- ✅ **100% line coverage** and **97.14% branch coverage** for `src/middleware/accessLog.ts`
- ✅ **0 new lint errors** (all 16 pre-existing errors in unrelated files)
- ✅ All tests use pure-isolation mocks — no Express app, no DB connections

## Acceptance Criteria
- ✅ `/api/admin` produces structured `admin_access_log` entries
- ✅ Logs contain `req-id`, `latency`, `status`, `size`, `actor`
- ✅ Correlation IDs correctly preserved (never regenerated for the same request)
- ✅ Boundary validation respected (unchanged — relies on existing Zod schemas)
- ✅ Standardized error envelopes intact (unchanged)
- ✅ Sensitive information not logged
- ✅ Changed-line coverage ≥ 90% (actual: 100%)
- ✅ Documentation updated (README.md + JSDoc)
- ✅ Lint, tests passed
- ✅ No unrelated refactors — scoped to issue #637 only

## Related Issues
- Closes #637

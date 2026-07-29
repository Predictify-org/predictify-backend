# SQL Injection Security Regression Suite

This document explains the design, setup, and execution of the SQL Injection (SQLi) security regression test suite for the GrantFox/Predictify backend.

## Design Philosophy

The security suite runs automated integration tests against all API endpoints by firing a catalog of common SQL injection payloads into every input parameter. 

The security tests serve two key purposes:
1. **Validation Verification**: Ensuring that strict schema validators (Zod validation boundary) correctly reject malformed payloads with a `400 Bad Request` validation error, preventing the request from ever reaching the database layer.
2. **Safe Database Processing**: Ensuring that arbitrary string fields (like search queries or textual dispute reasons) that pass validation are handled safely using Drizzle's parameterized queries, returning standard HTTP responses (e.g. `200 OK`, `404 Not Found`) and **never** causing database syntax exceptions or internal server errors (`500 Internal Server Error`).

## Payload Catalog

The catalog is located in `tests/security/payloads.ts` and contains the following payload categories:
- **Tautologies**: Queries that evaluate to always true (e.g. `' OR '1'='1`).
- **Piggybacked / Stacked Queries**: Appended commands to perform unauthorized operations (e.g. `'; DROP TABLE users; --`).
- **UNION-based Injections**: Attempts to merge results from other tables (e.g. `' UNION SELECT username, password FROM users --`).
- **Boolean-based/Error-based logic**: Conditional statements (e.g. `' AND 1=2 --`).
- **Comments and Special Characters**: Escape codes to bypass parser logic (e.g. `--`, `/*`, `'; --`).

## Test Coverage

The test suite in `tests/security/sqli.test.ts` executes over 580 test cases, verifying:
- **Main Application Routes**:
  - `/api/auth` (challenge, verify, refresh, logout)
  - `/api/markets` (list, search, fetch, update, disputes, events)
  - `/api/notifications` (preferences)
  - `/api/users` (predictions, profiles, follows)
  - `/api/predictions` (explain)
  - `/api/leaderboard` (overall, user specific)
- **Admin / Internal Routes**:
  - `/api/admin/audit` (audit logs query)
  - `/api/admin/users` (user aggregated view)
  - `/api/admin/recon` (market reconciliation reports)
  - `/api/admin/webhooks` (dead-letter queue listing and replay)

### Mocks and Sandbox Isolation
To prevent the tests from requiring a running PostgreSQL database or local Redis instance, the suite mocks:
- `pg` and `drizzle-orm` database query outputs.
- `ioredis` and `bullmq` queue connections.
- Auth middleware (`requireAuth`, `requireAdmin`, etc.) to bypass external signature and credential validation during the injection tests.

## Running Tests

To run the security regression suite:

```bash
npx jest tests/security/sqli.test.ts --forceExit
```

*Note: The `--forceExit` flag is recommended to ensure Jest terminates cleanly in the presence of open handles from the logging and queue configuration.*

## CI/CD Integration

The test suite is designed to run automatically in CI. Because it does not rely on a live database connection or Redis container, it executes quickly (under 1 minute) and can be included in pre-commit hooks or regular PR testing pipelines without complex infrastructure dependencies.

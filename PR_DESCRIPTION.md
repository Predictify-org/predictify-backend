## Description
This PR enforces a CORS allowlist from the environment on the `/api/stats` endpoint.

- Reads allowed origins from `STATS_CORS_ALLOWED_ORIGINS`.
- Deny by default (when the allowlist is empty, all cross-origin requests are denied).
- Preflight `OPTIONS` requests are cached.
- Includes focused tests for the CORS changes and updates existing tests to include the `Origin` header.

## API / Visible Changes
- `/api/stats` now rejects cross-origin requests that do not match the `STATS_CORS_ALLOWED_ORIGINS` environment variable.
- You must set `STATS_CORS_ALLOWED_ORIGINS` in your environment (e.g., `STATS_CORS_ALLOWED_ORIGINS=http://localhost:5173,https://app.predictify.dev`).

Closes #

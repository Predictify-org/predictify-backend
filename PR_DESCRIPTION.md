## Description
This PR implements the Idempotency-Key middleware for POST/PATCH endpoints on `/api/reports`, ensuring safe retries.

- Fixed a bug where `persisted` flag was missing in the global idempotency middleware, throwing a ReferenceError.
- Fixed a bug where `res.json` manually inserted records causing duplicate database inserts.
- Addressed undefined variables `TTL_MS` and `correlationId` in `idempotency.ts`.
- Explicitly mounted the `idempotency` middleware inside `createReportsRouter` (in `src/routes/reports.ts`) for all `POST` and `PATCH` methods.

## API / Visible Changes
- Global `audit_logs` will now contain detailed states outlining what token roles were issued when impersonating.

Closes #123

feat: add GET /api/audit/user/:addr per-user audit history endpoint (#325)

## Summary

Implements per-user audit history for the GrantFox FWC26 campaign.
Adds `GET /api/audit/user/:addr` which returns a paginated, cursor-based
list of audit log entries scoped to a single Stellar wallet address.

## Changes

### New files
- `src/routes/audit/user.ts` — route handler (factory pattern, matches
  existing audit sub-route conventions)
- `src/__tests__/routes/auditUser.test.ts` — 22 unit tests; all DB and
  auth dependencies mocked via jest
- `docs/user-audit-api.md` — API reference documentation

### Modified files
- `src/repositories/auditLogRepo.ts` — added `getAuditLogsByUser()`;
  dedicated function that always pins the `walletAddress` predicate so it
  cannot be accidentally omitted by callers
- `src/index.ts` — registered `userAuditRouter` at `/api/audit/user`
- `openapi.yaml` — added `AuditLogEntry` and `UserAuditPage` component
  schemas; full `/api/audit/user/{addr}` path entry with response examples

## Endpoint contract

```
GET /api/audit/user/:addr
Authorization: Bearer <jwt>
```

Query params: `cursor`, `limit` (1–100, default 20), `action`, `startDate`, `endDate`

Response:
```json
{ "data": [...], "nextCursor": "eyJ..." | null }
```

Pagination uses the same `(created_at DESC, id DESC)` keyset cursor as
`GET /api/admin/audit`. See `docs/audit-log-pagination.md`.

## Security

- `requireAuth` — 401 on missing/invalid JWT
- Non-admin callers requesting a different address receive 403; the
  forbidden attempt is logged at warn level with caller + requested address
- `:addr` validated against `G[A-Z2-7]{55}` before any DB access — bad
  addresses never reach the query layer
- Query schema uses `.strict()` — unknown params rejected with 422
- Rate limited: 60 req/min per JWT, keyed on Authorization header
- Correlation ID propagated from ALS context to every log line

## Test coverage

22 tests across:
- Happy path (empty page, entries returned, filters forwarded, cursor
  returned, cursor forwarded)
- Address validation (wrong prefix, too short, lowercase, special chars,
  valid)
- Query param validation (bad limit, bad dates, unknown params, boundary
  values)
- Authorisation (non-admin cross-address → 403, own address → 200,
  admin cross-address → 200, unauthenticated → 401)
- Error handling (repo throws → 500, error body present)
- Structured logging (user_audit_fetch log emitted, correlationId present,
  user_audit_forbidden warning emitted)

## Checklist

- [x] Implementation matches description
- [x] Input validation at the boundary; standardised error envelope
- [x] Structured logging with correlation IDs
- [x] Rate limiting applied
- [x] OpenAPI spec updated
- [x] API reference docs added
- [x] No diagnostics (tsc, language server)
- [x] Follows repo lint and code style

## Description
This PR persists audit rows for state-changing calls on the `/api/impersonate` endpoint, capturing the actor, action, and before/after states.

- Enriched `createAuditLog` calls in `src/routes/admin/users/impersonate.ts` to log `beforeState: null` and `afterState: { targetAddress, role: "user" }`.
- Restored missing `getCircuitBreaker` utility function in `src/lib/circuitBreaker.ts` to correctly mock/track circuit breakers.
- Updated `tests/adminImpersonate.test.ts` and `tests/impersonateCircuitBreaker.test.ts` to strictly assert the new payload format.

## API / Visible Changes
- Global `audit_logs` will now contain detailed states outlining what token roles were issued when impersonating.

Closes #

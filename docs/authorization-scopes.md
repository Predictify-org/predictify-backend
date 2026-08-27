# Authorization scopes

Predictify privileged work is divided into explicit least-privilege domains.
The scope claim is an array of exact strings in an access token. A route that
performs a privileged action must declare the domain it requires and the
middleware rejects a token that does not contain that exact scope.

## Scope catalog

| Scope | Intended use |
| ----- | ------------ |
| `market:manage` | Create, update, feature, disable, and finalize markets |
| `settlement:execute` | Settlement actions and force-resolution recovery |
| `report:read` | Audit, reconciliation, schema, and rate-limit inspection |
| `operations:recover` | Reindex, cache, webhook, plugin, and operational recovery |

The catalog is exported as `ADMIN_SCOPES` from
`src/middleware/authorizationScopes.ts`. Callers should use those constants
instead of repeating string literals in route modules.

## Route declaration

Use `requireScopedAdmin` when constructing a privileged router:

```ts
router.use(requireScopedAdmin(ADMIN_SCOPES.MARKET_MANAGE));
```

For a single route, use the same middleware in the route declaration:

```ts
router.post(
  "/:id/force-finalize",
  requireScopedAdmin(ADMIN_SCOPES.SETTLEMENT_EXECUTE),
  finalizeMarket,
);
```

`requireScopedAdmin` composes the existing JWT/admin identity validation with
the scope check. It does not trust a caller-provided header, query parameter,
or body field. Token signature, issuer, audience, and expiration continue to
be checked by the existing JWT service.

Legacy admin tokens without a `scopes` claim remain accepted during migration.
This compatibility behavior applies only to a token whose role is exactly
`admin`; an `operator` token must always include the required scope. Once all
admin tokens have been reissued with scopes, the compatibility branch can be
removed in a dedicated migration. Tokens that do contain scopes are never
treated as broad administrators.

## Failure contract

Unauthenticated or invalid tokens retain the existing `403`/`forbidden`
contract from the admin middleware. A valid token that lacks the route's exact
scope receives:

```json
{
  "error": {
    "code": "forbidden_scope",
    "requiredScope": "market:manage"
  }
}
```

The required scope is returned to help a correctly authenticated operator
request the right role. No token contents, signature details, or missing-scope
list is returned. This prevents authorization failures from becoming a token
introspection endpoint.

Scope comparisons are exact. `market:manage:all`, `market`, and
`market:manage/other` do not satisfy `market:manage`. Duplicate scope strings
do not provide additional privilege. A malformed non-array or mixed-type
`scopes` claim is treated as absent, which means it cannot authorize an
operator.

## Domain boundaries

An operator issued only `market:manage` may manage a market but cannot read
audit exports, trigger settlement recovery, or rebuild operational state. An
operator issued only `report:read` can inspect reports but cannot mutate a
market or execute a settlement. This is intentionally an allow-list model:
adding a new privileged route requires choosing one scope explicitly.

`scopeForAdminPath` is also used as a central safety net by the shared
`requireAdmin` middleware for older routers that have not yet moved their
scope declaration next to the route. Its mapping is deterministic and covers
market, settlement, reporting, and operational route families. New route code
should still use `requireScopedAdmin` visibly so code review can verify the
boundary locally.

## Operator audit

Successful and denied operator scope decisions emit structured audit log
entries with the actor, required scope, granted scopes, HTTP method, path, and
request IP. The entries use `operator.scope_granted` and
`operator.scope_denied` action identifiers. Scope strings are not secrets, but
token values and authorization headers are never logged.

The audit event is emitted at the policy boundary, before the handler runs.
This captures both successful authorization and blocked cross-domain
attempts. Business handlers remain responsible for their existing entity
mutation audit records; the scope event answers the separate question of who
was allowed to attempt the action.

## Issuing tokens

Token issuers should derive scopes from a server-side role policy, not accept
an arbitrary scope list from a login request. A sample operator token payload
is:

```json
{
  "sub": "G...",
  "role": "operator",
  "scopes": ["report:read"],
  "iss": "predictify",
  "aud": "predictify-api",
  "exp": 1893456000
}
```

Keep the list narrow and include only the domains needed by the operator's
job. When a temporary elevation is needed, issue a short-lived token with the
additional scope and record the approval outside the request body. Token
rotation and revocation continue to follow the existing JWT key-ring and
refresh-token policies.

## Testing policy

The scope test suite covers the catalog, exact matching, cross-domain denial,
missing and malformed claims, legacy admin compatibility, path mapping, and
middleware composition. Each privileged route family should additionally have
an integration test that sends a token with its required scope and a token with
a neighboring domain scope. Tests should assert the stable `forbidden_scope`
code and avoid asserting implementation-specific JWT error text.

When adding a new privileged family:

1. Add or select a scope in the catalog.
2. Add the path fallback in `scopeForAdminPath` if the router still uses the
   legacy middleware.
3. Declare `requireScopedAdmin` in the route module.
4. Add positive, missing-scope, cross-domain, expired, and malformed-token
   regression tests.
5. Add an audit assertion for operator authorization decisions.
6. Update this table and the route inventory documentation.

The policy is deliberately separate from business authorization. It answers
whether a privileged domain may be entered; handlers still validate resource
ownership, input schemas, rate limits, and state transitions.

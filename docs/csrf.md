# CSRF Protection

## Status: forward-looking, not an active fix

**Read this before assuming this middleware closes a live vulnerability.**

CSRF is a risk specifically for browser-managed, ambient credentials —
cookies, which the browser attaches to cross-site requests automatically.
A bearer token in an `Authorization` header, or a token round-tripped in
a request body, does not have this property.

As confirmed against this codebase's actual routes and services
(`src/routes/auth.ts`, `src/services/authVerifyService.ts`,
`src/middleware/auth.ts`), **every current auth flow issues and reads
tokens via response/request bodies and the `Authorization` header. No
route sets a session cookie.** `POST /api/auth/verify` returns
`{ accessToken, expiresIn }` in the JSON body; `POST /api/auth/refresh`
and `POST /api/auth/logout` take `refreshToken` in the request body.
None of this is CSRF-exploitable.

This middleware is added as groundwork per issue #310, and is designed
to activate automatically — with no further code changes — if a
cookie-based session is introduced later (e.g. by future wallet-auth
work). Until then, it is a deliberate no-op on every real request this
service handles.

## How it works — double-submit cookie pattern

1. `issueCsrfToken` middleware sets a random token in a cookie
   (`CSRF_COOKIE_NAME`, default `csrf_token`). Intentionally **not**
   `httpOnly`, so client-side JS can read its value.
2. The client echoes that value back in a request header
   (`CSRF_HEADER_NAME`, default `X-CSRF-Token`) on state-changing
   requests.
3. `verifyCsrfToken`, mounted on mutating routes, checks the cookie and
   header match (constant-time comparison) before allowing the request
   through.
4. A cross-site attacker's page can trigger the cookie to be sent
   automatically, but cannot read its value or set the custom header
   for the victim — so a forged request fails the check.

Stateless: no server-side token store required.

### When the middleware no-ops

- **Safe methods** (`GET`, `HEAD`, `OPTIONS`) always pass through.
- **Requests with no `SESSION_COOKIE_NAME` cookie present** always pass
  through — which, per the status note above, is every request this
  service currently handles.

## Integration requirements (read before wiring this in)

Confirmed against the real `src/index.ts`:

1. **`cookie-parser` is not currently mounted in `createApp()`.** Nothing
   needs it today, since no route reads or sets cookies. If/when a
   cookie-based session is introduced, add
   `app.use(cookieParser())` in `createApp()` **before** any route using
   `issueCsrfToken`/`verifyCsrfToken` — otherwise `req.cookies` is
   `undefined` and this middleware silently no-ops on every request.
2. **Correlation IDs come from `requestContextStorage`** (`src/lib/requestContext.ts`),
   which `createApp()` populates with `{ requestId }` for every request,
   derived from `pino-http`'s `genReqId`. `csrf.ts` reads
   `requestContextStorage.getStore()?.requestId` directly, so CSRF
   rejections carry the same correlation ID as every other log line and
   error response for that request — no separate ID-derivation logic.

## Usage

```ts
import cookieParser from "cookie-parser"; // add this if not already present
import { issueCsrfToken, verifyCsrfToken } from "./middleware/csrf";

app.use(cookieParser());

// If/when a cookie-based session is introduced:
app.post("/login", issueCsrfToken, loginHandler);
app.get("/csrf-token", issueCsrfToken, (req, res) => res.sendStatus(204));

app.post("/predictions", verifyCsrfToken, createPredictionHandler);
app.delete("/predictions/:id", verifyCsrfToken, deletePredictionHandler);
```

Requires `cookie-parser` mounted upstream so `req.cookies` is populated.

## Configuration

All new env vars are validated via the existing zod env schema and have
defaults — no `.env` change is required.

| Variable                | Default        | Description                                                      |
|-------------------------|-----------------|--------------------------------------------------------------------|
| `CSRF_COOKIE_NAME`       | `csrf_token`    | Name of the CSRF token cookie (non-`httpOnly`).                     |
| `CSRF_HEADER_NAME`       | `x-csrf-token`  | Header clients must echo the token back in.                        |
| `CSRF_TOKEN_TTL_SECONDS` | `7200`          | Lifetime of an issued CSRF token cookie, in seconds.                |
| `SESSION_COOKIE_NAME`    | `session`       | Cookie name whose presence triggers enforcement. Not currently set by any route — see status note above. |

## Error response

Rejections use the existing `RouteError`/error-handling conventions
(`kind: "Forbidden"`, HTTP 403). Confirmed against the real
`errorHandler`, the response body is:

```json
{
  "error": {
    "code": "Forbidden",
    "message": "CSRF token missing or invalid",
    "correlationId": "e92d11fd-5c90-442c-97c8-d137873d9f6e",
    "requestId": "e92d11fd-5c90-442c-97c8-d137873d9f6e"
  }
}
```

Rejections are logged (pino, `warn` level) with the correlation ID,
request path/method, and a machine-readable `reason`
(`missing_csrf_cookie` | `missing_csrf_header` | `csrf_token_mismatch`).

## Deployment notes (for whenever a session cookie is introduced)

- `NODE_ENV=production` marks the CSRF cookie `Secure` (HTTPS only).
- The session cookie itself should use `SameSite=Lax`/`Strict` and
  `httpOnly: true`. This middleware only checks for the session
  cookie's *presence*; the session cookie's own security configuration
  is what determines real-world exposure.

## Testing

`tests/security/csrf.test.ts` tests the middleware in isolation, mounted
on a minimal router — following this repo's `tests/security/` convention
(see `sqli.test.ts`) but self-contained, since no route in
`src/index.ts`'s `createApp()` currently exercises cookie-based auth.
The test app wires up `requestContextStorage` the same way `createApp()`
does, so correlation-ID behavior is verified against the real mechanism,
not a stand-in. Covers token issuance, safe-method exemption (including
when the middleware is mounted directly on a safe-method route), no-op
behavior for both Bearer-header and body-token requests (matching
today's real auth patterns), all missing/mismatched/malformed token
combinations, duplicate-header handling, correlation ID propagation
(context-stored, `req.id` fallback, and fresh-uuid fallback), and an
end-to-end login → mutate flow. 100% statement/branch/function/line
coverage on `src/middleware/csrf.ts`.

**Follow-up suggestion:** once a route sets a real session cookie, add
a route-level regression test here (or in that route's own test file)
verifying `verifyCsrfToken` is actually mounted and enforced on it —
this suite only proves the middleware works correctly in isolation, not
that any current route uses it.
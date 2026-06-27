# Security — Content-Security-Policy (CSP)

## Overview

Predictify uses [helmet](https://helmetjs.github.io/) to set strict HTTP
security headers globally, including a tight `Content-Security-Policy` that
blocks inline scripts, inline styles, and untrusted origins.

## Global CSP

```
app.use(helmet());
```

The global CSP sets `script-src 'self'` and `style-src 'self' https:` (among
other directives), which prevents inline scripts and inline styles outside the
explicit `/docs` exception.

**This global CSP must not be weakened.**

## Exception: `/docs` (Swagger UI)

Swagger UI renders its interface using inline `<script>` and `<style>` tags.
These are blocked by the strict global CSP, causing the docs page to fail.

### Solution

A **scoped** CSP middleware is mounted **only** on the `/docs` route,
**before** the global Helmet middleware. This ensures:

| Route          | CSP behaviour                                          |
|----------------|--------------------------------------------------------|
| `/docs`        | Relaxed — allows Swagger UI inline assets and Swagger CDN |
| Everything else| Strict — Helmet defaults (no inline scripts/styles)       |

### Relaxed directives (scoped to `/docs`)

```
Content-Security-Policy:
  default-src 'self';
  script-src  'self' 'unsafe-inline' https://cdn.jsdelivr.net;
  style-src   'self' 'unsafe-inline' https://cdn.jsdelivr.net;
  img-src     'self' data: https://validator.swagger.io;
  connect-src 'self';
```

### Why `'unsafe-inline'` instead of nonces/hashes?

Swagger UI (via `swagger-ui-express`) generates its HTML dynamically at
runtime. The inline scripts change with each release, making nonce injection
impractical without forking the library. `'unsafe-inline'` is the
officially recommended approach for hosting Swagger UI.

The risk is mitigated by:

1. **Path scoping** — only `/docs` gets the relaxed policy.
2. **No user input** — the Swagger UI page serves a static OpenAPI spec;
   there is no user-controlled content that could be injected.
3. **Other headers** — helmet still applies `X-Frame-Options`,
   `X-Content-Type-Options`, `Strict-Transport-Security`, etc. globally.

### Implementation reference

- **Middleware**: [`src/middleware/csp.ts`](../src/middleware/csp.ts)
- **Route definition**: [`src/routes/docs.ts`](../src/routes/docs.ts)
- **Mount point**: [`src/index.ts`](../src/index.ts) — `/docs` is mounted
  before the global Helmet middleware so it receives its own scoped CSP.
- **Test**: [`tests/csp.test.ts`](../tests/csp.test.ts) — asserts the CSP
  header differs between `/docs` and other routes and that the Swagger CDN is
  only allowed on `/docs`.

## Verification

```bash
npm test -- --testPathPattern=csp
```

The test suite verifies:

- `/docs` CSP contains `'unsafe-inline'`
- `/docs` CSP allows `https://cdn.jsdelivr.net`
- `/health` (and by extension all `/api/*`) does **not** allow `'unsafe-inline'`
- `/health` does **not** allow the Swagger CDN
- The CSP header values for `/docs` and `/health` are not equal

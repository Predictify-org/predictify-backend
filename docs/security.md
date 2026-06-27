# Security — Content-Security-Policy (CSP)

## Overview

Predictify uses [helmet](https://helmetjs.github.io/) to set strict HTTP
security headers globally, including a tight `Content-Security-Policy` that
blocks inline scripts, inline styles, and untrusted origins.

## Global CSP

```
app.use(helmet());
```

Helmet's default CSP sets `script-src 'self'` (among other directives), which
prevents Cross-Site Scripting (XSS) attacks by disallowing inline `<script>`
tags and scripts loaded from external origins.

**This global CSP must not be weakened.**

## Exception: `/docs` (Swagger UI)

Swagger UI renders its interface using inline `<script>` and `<style>` tags.
These are blocked by the strict global CSP, causing the docs page to fail.

### Solution

A **scoped** helmet middleware is mounted **only** on the `/docs` route,
**before** the global `helmet()` call. This ensures:

| Route          | CSP behaviour                                          |
|----------------|--------------------------------------------------------|
| `/docs`        | Relaxed — allows `'unsafe-inline'` for scripts/styles  |
| Everything else| Strict — helmet defaults (no inline scripts/styles)    |

### Relaxed directives (scoped to `/docs`)

```
Content-Security-Policy:
  default-src 'self';
  script-src  'self' 'unsafe-inline';
  style-src   'self' 'unsafe-inline';
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

- **Route definition**: [`src/routes/docs.ts`](../src/routes/docs.ts)
- **Mount point**: [`src/index.ts`](../src/index.ts) — `/docs` is mounted
  before `helmet()` so it receives its own scoped CSP.
- **Test**: [`tests/csp.test.ts`](../tests/csp.test.ts) — asserts the CSP
  header differs between `/docs` and other API routes.

## Verification

```bash
npm test -- --testPathPattern=csp
```

The test suite verifies:

- `/docs` CSP contains `'unsafe-inline'`
- `/health` (and by extension all `/api/*`) CSP does **not** contain `'unsafe-inline'`
- The CSP header values for `/docs` and `/health` are not equal

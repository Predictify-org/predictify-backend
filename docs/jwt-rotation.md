# JWT key rotation

Predictify issues access tokens (`POST /api/auth/verify`, `POST /api/auth/refresh`)
as HS256 JWTs. This document explains how multiple signing keys are loaded,
how the verifier picks the right one, and the runbook for rotating a key
without invalidating tokens that are already out in the wild.

## Why rotate

A signing key may need to change because: it leaked, a scheduled rotation
policy requires it, or an employee/system that had access to it is being
decommissioned. Rotating naively (just swapping `JWT_SECRET`) immediately
invalidates every outstanding access token, forcing every signed-in user to
re-authenticate. Key-ID (`kid`) based rotation avoids that.

## How it works

### Key ring (`src/utils/keyRing.ts`)

The app loads a *ring* of keys, each identified by a `kid`:

- `JWT_SECRET` (required, existing variable) is always loaded under the
  reserved kid `"default"`. Deployments that never touch the variables below
  keep working exactly as before — this is a fully backward-compatible
  addition.
- `JWT_KEYS` (optional) adds more keys, as comma-separated `kid:secret`
  pairs:

  ```
  JWT_KEYS=2026-07-01:7f3c9c2c4f0c4d5a8e9b1a2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6,2026-06-01:a91e7b54...
  ```

  Each secret must be at least 32 characters. Kids may only contain letters,
  digits, `.`, `_`, `-`, and must be unique (`"default"` is reserved).
- `JWT_ACTIVE_KID` (optional) selects which loaded kid signs *new* tokens.
  Defaults to `"default"`.

The ring is parsed once per process at startup (same fail-fast pattern as
`src/config/env.ts`) — a malformed `JWT_KEYS` or an `JWT_ACTIVE_KID` that
doesn't match any loaded key crashes on boot rather than failing silently at
request time.

### Signing and verification (`src/services/jwtService.ts`)

- `signAccessToken(payload)` signs with the active key and stamps its `kid`
  into the JWT header (via the standard `keyid` option — no custom claims).
- `verifyAccessToken(token)` reads the **unsigned** header to find the `kid`,
  looks up the matching key in the ring (active *or* retired), and verifies
  the signature against it. Tokens without a `kid` header — i.e. every token
  issued before this feature shipped — fall back to `"default"`
  (`JWT_SECRET`), so existing sessions are unaffected by the upgrade.

Every call site that previously called `jwt.sign` / `jwt.verify` directly
(`refreshTokenService`, `authVerifyService`, `requireAuth`, `requireAdmin`,
`middleware/auth`) now goes through this single module, so a rotation is
effective everywhere at once.

Because verification accepts any loaded key, a token signed before a
rotation stays valid until it naturally expires (`JWT_TTL_SECONDS`) — keys
are never removed from the ring while a token signed with them could still
be outstanding.

## Rotation runbook

Use `npm run jwt:rotate -- <command>` (wraps `scripts/rotate-jwt-key.ts`).
By default the script only **prints** the resulting `JWT_KEYS` /
`JWT_ACTIVE_KID` values — paste them into your secrets manager / deployment
config. Pass `--write` to also update a local `.env` file (handy in dev);
`--file <path>` overrides which file is read/written.

Rotation is a deliberate three-step, three-deploy process. Each step is
single-purpose so a partial rollout (some instances updated, some not) is
always safe:

### 1. Add the new key

```bash
npm run jwt:rotate -- add
# or pin a specific kid: npm run jwt:rotate -- add 2026-07-01
```

This generates a new random secret and adds it to `JWT_KEYS`.
**`JWT_ACTIVE_KID` is left unchanged** — nothing signs with the new key yet.

Deploy this change everywhere. Once every instance has it, every verifier in
the fleet recognizes the new `kid`, even though nothing has used it yet.

### 2. Activate the new key

```bash
npm run jwt:rotate -- activate 2026-07-01
```

This flips `JWT_ACTIVE_KID`. Deploy again — from this point on, new tokens
are signed with the new key. Tokens signed with the old key are still
accepted (it's still in `JWT_KEYS`), so users mid-session are unaffected.

### 3. Remove the retired key

Wait at least `JWT_TTL_SECONDS` after step 2 deployed everywhere — long
enough that no token signed with the old key can still be outstanding —
then:

```bash
npm run jwt:rotate -- remove 2026-06-01
```

The script refuses to remove `"default"` (it's tied to `JWT_SECRET`, not
`JWT_KEYS`) and refuses to remove whichever kid is currently active, to
prevent locking out new sign-ins. Deploy once more to complete the rotation.

### Inspecting current state

```bash
npm run jwt:rotate -- list
```

Prints every loaded kid and marks which one is active. Secrets are never
printed by `list`.

## Security notes

- Secrets are validated at load time (`>= 32` chars) — the same bar as
  `JWT_SECRET` today.
- `pino`'s redaction config (`src/config/logger.ts`) already strips
  `Authorization` headers and `token` fields from logs; the key ring itself
  never logs secret material.
- An unrecognized `kid` (e.g. a forged header naming a key that was already
  removed) is treated as an invalid token — verification fails closed, the
  same as a bad signature.
- Rotation never widens the trust boundary: every key in the ring is one
  that an operator explicitly added via `JWT_SECRET` or `JWT_KEYS`.

## Testing

```bash
npm test -- tests/keyRing.test.ts tests/jwtService.test.ts
```

Covers: multi-key loading, duplicate/invalid kid rejection, secret-length
validation, `JWT_ACTIVE_KID` resolution and mismatch errors, signing embeds
the active kid, verification routes by kid (active and retired keys),
fallback for tokens with no `kid`, rejection of unknown kids, and the usual
expired/wrong-issuer/wrong-audience/tampered-signature cases.

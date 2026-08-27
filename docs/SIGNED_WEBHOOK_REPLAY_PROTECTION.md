# Signed webhook replay protection

Predictify webhook deliveries can be verified with a versioned header:

```text
v1=<key-id>,t=<unix-seconds>,n=<nonce>,s=<hex-hmac>
```

The HMAC input is deliberately unambiguous and byte-preserving:

```text
predictify-webhook-v1\n<key-id>\n<timestamp>\n<nonce>\n<raw-body>
```

Receivers must retain the raw request bytes. Parsing and serialising JSON
before verification can change whitespace or property ordering and is not
equivalent to the signed message.

## Rotation

Each key has an activation time and optional expiry. The newest active key is
used for signing. During rotation, keep the old key active until the maximum
delivery/retry window has elapsed; this permits in-flight deliveries to finish
without making the new key depend on the old key. A key is rejected outside its
window, even if its HMAC is otherwise valid.

The `SignedWebhookSecurity` class accepts a bounded key ring, supports explicit
rotation/removal, and exposes only public key metadata for operations. Secrets
are copied into private buffers and are never returned by `listKeys`.

## Verification order

1. Parse the bounded header and reject malformed fields.
2. Resolve the key and check its activation/expiry window.
3. Check timestamp skew against the configured tolerance.
4. Compute the expected HMAC over the exact raw bytes and compare with
   `timingSafeEqual` after validating equal fixed-length digest sizes.
5. Atomically claim the nonce in the bounded replay store.

Invalid signatures do not consume nonce entries. A valid signature can be used
only once per key and nonce while the replay entry is alive. The in-memory
nonce store is suitable for the current single-process test/development path;
multi-process deployments should implement `NonceStore` with a shared,
conditional insert and expiry (for example, Redis `SET NX EX`).

## Failure handling

All verification failures return a stable reason internally, but callers should
use one generic client-facing 401/400 response so an attacker cannot learn
whether a key id, timestamp, nonce, or signature was almost valid. Log only a
request correlation id and the reason at a protected server-side log level.

The dispatcher keeps the legacy single-secret signing path when no rotating
security object is configured. Passing `SignedWebhookSecurity` opts a caller
into timestamped signatures and persists the timestamp/nonce headers alongside
the delivery, so retries reuse the same signed message and cannot accidentally
receive a new signature for the same body.

For incident response, rotate to a new key id and retain the prior key through
the configured overlap period. Removing a key immediately invalidates every
message signed by it, including deliveries already queued for retry. Operators
should therefore coordinate key removal with queue depth and the longest
configured retry window. Nonce-store expiry should exceed the timestamp
tolerance so a valid message cannot become acceptable again after its replay
record has expired.
Alert on repeated verification failures without logging payloads or secrets.

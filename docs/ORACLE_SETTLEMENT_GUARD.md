# Oracle settlement guard

Settlement callers should fetch a snapshot and evaluate it immediately before
the atomic market-state mutation. `evaluateOracleSnapshot` is pure and returns
either a deterministic median decision or an auditable rejection reason.

Freshness is evaluated against the caller's trusted current time. An
observation is fresh when `now - observedAt <= maxAgeSeconds`; observations
ahead of the clock beyond `maxClockSkewSeconds` are rejected. Prices must be
finite and strictly positive, and source identities are unique.

The default policy requires three fresh sources and limits deviation to 100
basis points from the median. A single fallback is never implicit: callers
must enable it explicitly, provide a distinct named source, and still satisfy
the same validity and freshness checks. The decision records whether fallback
was used so operators can distinguish normal quorum settlement from degraded
recovery.

Outage behavior is fail-closed when fallback is disabled or invalid. Recovery
is deterministic: once enough fresh sources return and agree within the
configured boundary, the same snapshot is accepted without a separate mode
switch. Callers should persist the rejection reason in their settlement audit
record, while returning a generic client-facing error if the reason could
reveal provider health or configuration.

Persist the accepted source set and observation time with settlement metadata.
That evidence lets operators reconstruct exactly which quorum passed.

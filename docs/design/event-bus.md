# Event bus

Deterministic pipeline for integration events. Models do not choose these handlers.

`runEvent` is detect → decide → act → verify → log. A handler with `maxTier` other than 0 or 1 is rejected before it runs, so the bus cannot send email, SMS, or money. Those stay on the existing tool policy.

A timed-out attempt is aborted and is not retried. `ctx.once` applies the effect at most once for that key inside the process. Dead letters store the full event key in metadata. A successful replay writes `ops.dead_letter.resolved`. The once-set is not a cross-worker lease.

The circuit breaker is in-process. HTTP 5xx and timeouts count as failures. Proposed migration `0022` (not applied) is the shared table shape. The running app journals through `audit_events` and does not read those tables.

Outbound HTTP goes through `fetchAllowlisted`: `https://api.weather.gov` only, redirects manual, every hop checked again.

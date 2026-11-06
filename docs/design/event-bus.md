# Event bus

Deterministic pipeline for integration events. Models do not choose these handlers.

`runEvent` is detect → decide → act → verify → log. A handler with `maxTier` other than 0 or 1 is rejected before it runs, so the bus cannot send email, SMS, or money. Those stay on the existing tool policy.

Idempotency is an audit row `ops.event` keyed by `(tenant_id, idempotency_key)`. Dead letters are `ops.dead_letter`. A manager replays from `/orgs/[orgId]/recovery`. The replay reuses the key, so a success still happens once.

The circuit breaker is in-process. Proposed migration `0022` (not applied) is the shared table shape for events, dead letters, and breaker state, plus an audit action index. The running app does not read those tables.

Outbound HTTP goes through `assertSafeOutbound`. The only allowlisted host is `api.weather.gov`.

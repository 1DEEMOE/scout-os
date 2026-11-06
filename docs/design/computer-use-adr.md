# ADR-002: Computer use

Status: DEFERRED
Date: 2026-11-03

## Decision

No computer-use provider in the MVP. All MVP agents use official APIs (Gmail, CRM, invoicing, Stripe).

We define the interface now so later work doesn't reshape the executor:

```ts
interface ComputerSession {
  start(opts: { tenantId: string; taskId: string; allowedDomains: string[] }): Promise<SessionRef>;
  act(ref: SessionRef, action: ComputerAction): Promise<Observation>;
  stop(ref: SessionRef): Promise<void>;
}
```

Every `act` goes through the same policy engine as API tools. CAPTCHA and MFA prompts end the session and escalate to a human; they are never solved automatically.

## Before un-deferring

Evaluate Browserbase, E2B and Daytona on: per-minute cost, session isolation per tenant, recording/replay for audit, data residency, and license terms. Record results here and get owner approval (cost impact).

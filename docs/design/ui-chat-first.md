# ADR-005: Chat-first interface (branch `ui/chat-first`)

Status: built, awaiting independent verification (OMEGA). Owner request 2026-11-06: calm, chat-first and premium, in the spirit of modern assistant apps.

## Clean-room statement

Built from publicly describable qualities only (chat-first home, inline approvals, quiet sidebar, white space, one accent, rounded cards, subtle motion, light and dark themes, phone parity). No code, assets, icons, logos, text or exact layouts were taken from Grok, bops.bot or any other product. The mark is original geometry (`brand-mark.tsx`, `chat-ui.tsx`). Typeface: Schibsted Grotesk (OFL-1.1), self-hosted from npm.

## Decisions

- **Today is a conversation with Scout.** The briefing, approvals, payment-change warnings, front-desk requests, flagged documents, overdue invoices and failed jobs arrive as Scout messages. Nothing from the old Today page was dropped. The composer sits under the heading (not sticky) so it never covers content; threads keep it pinned at the bottom.
- **Approvals inline, rules unchanged.** `ApprovalCard` calls the same `approval.decide` / `approval.confirm` procedures with the same labels ("OK", "OK (needs second person)", "Decline", "Confirm and run"). Tiers 0–4, the second confirmation by a different person, no self-approval and expiry are all enforced on the server as before. The colored rail only shows the tier.
- **Shell:** a 280px sidebar on large screens (Today, Needs your OK with count, Conversations and recent threads, Teammates, Routines, Library, Workspace, theme, sign out). Below 1024px: a top bar with a Menu drawer (focus moves to Close, Escape returns focus to Menu) and the same five bottom tabs as before. Nav landmark names ("Organization", "Primary") and link names are kept, so the existing tests and assistive tech see the same structure.
- **Tokens** (`globals.css`): cool neutral surfaces, one lagoon-teal accent, warn/caution/danger for tiers. The dark theme is applied by `data-theme` or the system preference. An inline boot script sets the stored choice before first paint (no flash). `contrast.test.ts` checks every text/background pair is at least 4.5:1 in both themes.
- **Motion:** one rise-in for new messages and the drawer slide (200–220ms). Everything collapses under `prefers-reduced-motion`.
- **Message-first chat:** a conversation is created by its first message (title = the message, truncated), replacing the old separate "title, then Start" step. The `approvals.spec` chat test was updated to that flow, with the same assertions.

## Accessibility (WCAG 2.2 AA) and performance

- Automated: axe (`@axe-core/playwright`, tags up to `wcag22aa`, including `target-size` and `color-contrast`) on Today, Approvals, Front desk, Chat and sign-in, in light, explicit dark, system dark and phone layouts: no violations. Keyboard-only path to the composer, visible focus ring, drawer focus management.
- Controls are at least 40–44px (minimum 24px required).
- Lab metrics on Today (local production build, `chat-first.spec.ts`): CLS 0, LCP about 0.1–0.15s, longest interaction about 24ms. **These are lab numbers.** The p75 targets (LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1) are field metrics and need real-user monitoring after deploy to confirm.

## Not done here

Visual baselines (pixel diff) aren't committed: screenshots depend on the machine's font rendering. Evidence screenshots are in `docs/plans/evidence/chat-first/`, and layout is asserted by tests (no horizontal scroll, landmarks, focus).

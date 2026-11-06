# ADR-005: Chat-first interface (branch `ui/chat-first`)

Status: built, awaiting independent verification (OMEGA). Owner request 2026-11-06: calm, chat-first and premium, in the spirit of modern assistant apps.

## Clean-room statement

Built from publicly describable qualities only (chat-first home, inline approvals, quiet sidebar, white space, one accent, rounded cards, subtle motion, light and dark themes, phone parity). No code, assets, icons, logos, text or exact layouts were taken from Grok, bops.bot or any other product. The mark is original geometry (`brand-mark.tsx`, `chat-ui.tsx`). Typeface: Schibsted Grotesk (OFL-1.1), self-hosted from npm.

## Decisions

- **Today is a conversation with Scout.** The briefing, approvals, payment-change warnings, front-desk requests, flagged documents, overdue invoices and failed jobs arrive as Scout messages. Nothing from the old Today page was dropped. The composer sits under the heading (not sticky) so it never covers content; threads keep it pinned at the bottom.
- **Approvals inline, rules unchanged.** `ApprovalCard` calls the same `approval.decide` / `approval.confirm` procedures with the same labels ("OK", "OK (needs second person)", "Decline", "Confirm and run"). Tiers 0–4, the second confirmation by a different person, no self-approval and expiry are all enforced on the server as before. The colored rail only shows the tier.
- **Shell (superseded by "Sidebar v2" below):** originally a 280px sidebar with every section visible and a Menu drawer on phones.
- **Tokens** (`globals.css`): cool neutral surfaces, one lagoon-teal accent, warn/caution/danger for tiers. The dark theme is applied by `data-theme` or the system preference. An inline boot script sets the stored choice before first paint (no flash). `contrast.test.ts` checks every text/background pair is at least 4.5:1 in both themes.
- **Motion:** one rise-in for new messages and the drawer slide (200–220ms). The rise and the palette pop move only; they never fade, so text stays at full contrast on the first frame. Everything collapses under `prefers-reduced-motion`.
- **Message-first chat:** a conversation is created by its first message (title = the message, truncated), replacing the old separate "title, then Start" step. The `approvals.spec` chat test was updated to that flow, with the same assertions.

## Accessibility (WCAG 2.2 AA) and performance

- Automated: axe (`@axe-core/playwright`, tags up to `wcag22aa`, including `target-size` and `color-contrast`) on Today, Approvals, Front desk, Chat and sign-in, in light, explicit dark, system dark and phone layouts: no violations. Keyboard-only path to the composer, visible focus ring, drawer focus management.
- Controls are at least 40–44px (minimum 24px required).
- Lab metrics on Today (local production build, `chat-first.spec.ts`): CLS 0, LCP about 0.1–0.15s, longest interaction about 24ms. **These are lab numbers.** The p75 targets (LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1) are field metrics and need real-user monitoring after deploy to confirm.

## Not done here

Visual baselines (pixel diff) aren't committed: screenshots depend on the machine's font rendering. Test runs write shots under `apps/web/test-results/evidence/` (override the root with `WOS_EVIDENCE_DIR`). Checked-in samples stay in `docs/plans/evidence/chat-first/`. Layout is asserted by tests (no horizontal scroll, landmarks, focus).


## Sidebar v2 (2026-11-06, owner request: "a powerful engine underneath, nothing that feels compacted")

- **One navigation model** (`orgs/[orgId]/nav-model.ts`) feeds the sidebar, the icon rail, the phone tabs, the More sheet and the command palette, so a page can't be reachable in one and missing in another, and pages a role can't open (Scout, Analytics, Storm reports and Scout setup for viewers; Audit log for non-managers; New chat for viewers) are never offered anywhere. Unit-tested in `test/nav-model.test.ts`.
- **Five primary items, each an icon plus a label:** Today (the chat), Approvals (count badge, announced as "N waiting"), Work (jobs and tasks), Customers, and Scout (leads). Orgs without Scout and viewers get "Leads" (the inbox) instead.
- **Everything else behind one More section**, in three groups: Teammates & routines; Library (conversations, inbox, invoices, analytics, storm reports); Workspace (settings, team, integrations, front desk, Scout setup, contact rules, plan & billing, audit log, guided setup). More and each group start closed. Open/closed state is remembered per browser (localStorage, wrapped in try/catch), and the group containing the current page opens itself.
- **Spacing:** 44px rows with 8px gaps, 15px labels, generous section padding, no row dividers, and one quiet active state (accent-soft background, accent icon). Group titles (Teammates, Library, Workspace) are ink so they stay easy to read; their icons stay muted. Asserted in `e2e/sidebar.spec.ts`.
- **Icon rail:** the collapse button (or Ctrl/Cmd+\, or the palette) narrows the sidebar to an 84px rail. Labels become tooltips on hover and focus but stay the links' accessible names. The choice is set on `<html data-rail>` by an inline boot script before first paint (`boot.ts`), so there's no wide-then-narrow flash. A Tailwind `rail:` variant scopes rail styles to large screens.
- **Phones:** the same five items as bottom tabs (icon + label, 56px tall), a top bar with Search and More, and More as a bottom sheet (focus moves to Close, focus is trapped while open, Escape returns focus to More) containing the groups, the workspace switcher and the profile, with sign-out.
- **Command palette:** Ctrl/Cmd-K (or the Search button) opens a modal dialog with a combobox and a grouped listbox (WAI-ARIA combobox pattern: arrows move `aria-activedescendant`, Enter runs, Escape closes from anywhere in the dialog — not only when the input is focused — and returns focus). It holds every page, recent conversations, workspaces and actions (new chat, collapse sidebar, themes, sign out). Search matches every word against labels and keywords ("gmail" finds Integrations).
- **Current page:** an in-page anchor (Team, Integrations) is current only on its own page, not on a subpage such as Front desk.
- **Footer:** one row with the workspace switcher (initial plus name) and the profile button. Sign-out, theme and Help live in the profile menu (44px targets). Both are disclosure popovers: Escape or a click outside closes them, and focus returns to the button.
- **Skip link:** "Skip to content" is the first tab stop.
- **Fixed on the way:** the theme boot script was imported from a `"use client"` module into the server layout, so the inline script could be a client reference rather than the string. Both boot scripts now live in the plain module `boot.ts`.
- Icons are original 24px line drawings (`icons.tsx`), not from any icon set.

## Plug and play for selling (2026-11-06)

See `docs/design/plug-and-play.md`.

# ADR-006: Plug and play for selling

Status: built on `ui/chat-first`, awaiting OMEGA verification. Owner request 2026-11-06: the client buys, Darian sends a link, and they're set up and seeing value in under 10 minutes, with no long onboarding.

## Flow

1. **Operator screen** `/admin/clients` (`app/admin/clients`). Darian enters the business name, trade, an optional service-area ZIP and the client's email (typed twice). `provisionClientWorkspace` (core `onboarding/quickstart.ts`) creates the workspace with its name, trade, time zone and the trade's trial plan, plus **one owner invitation**. It returns the invite link once; only the token's hash is stored.
2. **One link.** `/accept-invite?org=…&token=…&email=…&ws=…&zip=…`. The `email`, `ws` and `zip` values are display and pre-fill hints only. The token is the secret, and `acceptInvitation` still checks that the signed-in email matches the invitation. The client sets a name and password (or uses Google when configured) and is accepted automatically, then lands on `/orgs/<id>/welcome`. Opening the link while signed in as the right person accepts straight away; as a different person, the page says whose invite it is and offers to sign out.
3. **At most three short steps**, each skippable, with defaults pre-filled and a visible "about N minutes left":
   1. *Your business:* name and trade (from the operator), ZIP (from the link), and time zone (from the device). `quickstartBusiness` saves them and, for roofing with a known ZIP, saves and reviews the Scout service area.
   2. *Connect your email:* "Connect Gmail" uses the existing Google OAuth integration when `GOOGLE_CLIENT_ID` is set. Otherwise the step says plainly that it isn't switched on. "Skip for now" records the step.
   3. *What should Scout watch?* Briefing time (6, 7 or 8 am) and "Show me 3 sample opportunities" (roofing). `finishQuickstart` loads the DEMO sample (every row `demo=true` and labelled "(DEMO)"), creates the morning briefing routine at the chosen hour, runs the first briefing inline and marks setup complete.
4. **First win:** Today opens with the generated briefing first, then "You're set up. Here are 3 sample opportunities to try first" (DEMO, with a "Remove sample data" button).

`e2e/plug-and-play.spec.ts` times the whole thing (operator form → link → client on a phone → briefing) and counts the client's clicks, including taps into fields. Last local run: **9 s total (6 s for the client), 6 client clicks.** The assertions are under 10 minutes and at most 15 clicks.

## Security and least privilege

- **Platform admin** is granted only by server configuration: `WOS_PLATFORM_ADMIN_USER_IDS` (preferred) or `WOS_PLATFORM_ADMIN_EMAILS` (honoured only for a **verified** email). It is unset by default, so nobody is an admin. Core re-reads the user from the database before provisioning, and everyone else gets a 404 (page and API).
- **The operator does not become a member** of the workspace they create, so they can't read the client's data afterwards.
- **Granting an owner is a tier-4 access change.** It requires the email typed twice (second confirmation) and is audited at tier 4 as `platform.workspace.provision`, with the operator as actor. Approval tiers and enforcement are otherwise unchanged.
- Each step is audited at tier 1 and attributed to the client. The new tRPC procedures are covered by the all-endpoints isolation sweep (another org's owner gets 404; signed-out callers get 401). `packages/core/test/quickstart.test.ts` covers provisioning, refusals, single use, email binding, the three steps, skips and cross-tenant refusal.
- **Nothing is emailed.** Darian sends the link himself.

## Google sign-in

`better-auth` `socialProviders.google` is enabled only with `WOS_GOOGLE_SIGNIN=1` plus `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. The Google client must list `<BETTER_AUTH_URL>/api/auth/callback/google`. The button isn't shown otherwise. It uses the existing `auth_accounts` table, so no migration is needed. **Live Google sign-in is UNVERIFIED:** no real Google client was available here.

## Nothing to install

The app has a web app manifest (`app/manifest.ts`: standalone, `start_url /orgs`) and icons rendered from the original mark (`public/icons`, reproducible with `scripts/render-icons.mjs`), plus `apple-touch-icon` and `appleWebApp` metadata, so phones can add it to the home screen. `/help` explains home-screen install and an *optional* desktop shortcut (help docs only, as asked). There's no service worker or offline mode. Adding to the home screen on real iOS and Android devices is **UNVERIFIED** here (headless browser only).

## What waits on Darian's review: proposed migration 0020 (not applied)

`packages/db/proposed/0020_workspace_brand_and_watch.sql` (plus rollback, dry-run applied and rolled back cleanly on a throwaway copy of the test database). The runner reads only `migrations/`, so it's never applied automatically.

- `organizations.brand_accent`: an operator-chosen accent from a fixed palette. Until then, a workspace is branded with its name and initial, and the admin screen says so.
- `routines.watch_topics`: which briefing sections a workspace wants (`pending_approvals` is mandatory). Until then, step 3 offers only options that really work (briefing time, samples), and the briefing covers every section.

## Known gaps

- If a client loses their link, the operator can't re-issue it, because they aren't a member. The fix is a platform-level provisions table (proposed for a later migration) or a manual re-provision.
- After connecting Gmail in step 2, the OAuth callback returns to Settings, not to step 3. The setup card on Today brings them back.
- Self-serve sign-up (create an org from `/orgs`) still uses the older 5-step guided setup, which stays available under More → Workspace → Guided setup.

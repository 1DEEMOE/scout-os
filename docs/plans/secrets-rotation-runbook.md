# Secrets rotation runbook

When to use it: on a schedule (every 6–12 months), when someone with access leaves, or **immediately** if a secret may have leaked. Every rotation below is a tier-4 action (secrets): do it yourself, or with a second owner watching. Record what you rotated and when in `docs/plans/session-log.md`.

Order if a leak is suspected: rotate the leaked secret first, then check the audit log (Workspace → Audit log) for anything that used it.

## 1. `WOS_SECRETS_KEY`: the key that encrypts stored credentials and bank details

What it protects: Gmail/HubSpot/Stripe tokens (`integration_connections`), bank details (`payment_destinations`, `payment_detail_changes`). Each stored value starts with the id of the key that sealed it, so the app can hold two keys during a rotation.

1. Make a new key: `openssl rand -base64 32`. Pick a new id, e.g. `v2` (the first key's id is `v1` unless you set one).
2. On **both** the web and worker services set:
   - `WOS_SECRETS_KEY` = the **new** key, `WOS_SECRETS_KEY_ID` = `v2`
   - `WOS_SECRETS_KEY_PREVIOUS` = the **old** key, `WOS_SECRETS_KEY_PREVIOUS_ID` = `v1`
   Then redeploy. New values use v2, and old values still open.
3. Back up the database (Render: take a manual snapshot), then from a machine with the same env plus `DATABASE_URL_ADMIN`:
   - Dry run: `pnpm --filter @wos/core rotate-secrets -- --confirm v2 --dry-run`
   - For real: `pnpm --filter @wos/core rotate-secrets -- --confirm v2`
   It prints, per table, how many were re-sealed. Rows it can't open are **left untouched** and listed (exit code 2). Investigate those before going further. Each affected workspace gets a tier-4 `secrets.rotate` audit entry.
4. Run it once more. It should report 0 re-sealed.
5. Remove `WOS_SECRETS_KEY_PREVIOUS` and `WOS_SECRETS_KEY_PREVIOUS_ID`, then redeploy. Destroy every copy of the old key.

Tested by `packages/core/test/secrets-rotation.test.ts`: dry run, wrong confirmation, unreadable rows left alone, values readable after removing the old key, audit entries, and re-runs.

## 2. `BETTER_AUTH_SECRET`: signs sessions

Changing it signs **everyone** out (sessions stop validating). No data is lost.
1. `openssl rand -base64 32`, set it on the web service, redeploy.
2. Tell users they'll need to sign in again.

## 3. Database passwords (`app_user`, `wos_owner`, admin role)

Do one role at a time so the app never loses its connection:
1. `ALTER ROLE app_user PASSWORD '<new>';` (as a superuser or the Render database owner).
2. Update `DATABASE_URL` on web and worker straight away, and redeploy. Requests fail between the two steps, so do them back to back, ideally in a quiet hour.
3. Same for `wos_owner` (only `DATABASE_URL_OWNER`, used by migrations) and the admin URL (worker reconciler and rotation only).

## 4. Third-party keys

Each provider lets you create a new key before revoking the old one. Always create, deploy, check, then revoke.

| Secret | Where to rotate | Check after |
|---|---|---|
| `GOOGLE_CLIENT_SECRET` | Google Cloud console → Credentials → the OAuth client → add secret, then disable the old one | Connect Gmail in a test workspace |
| `STRIPE_SECRET_KEY` | Stripe dashboard → Developers → API keys → roll key | Plan & billing page loads; a test checkout |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Webhooks → the endpoint → roll signing secret | Send a test event; it shows as delivered |
| `ANTHROPIC_API_KEY` | Anthropic console → API keys → create, then delete the old one | Ask Scout something in a test workspace |
| `SMTP_URL` password | Your email provider | Use "Forgot password" on a test account |

A user's own connected-account tokens (their Gmail) aren't rotated by you. They disconnect and reconnect in Settings → Integrations. Disconnecting deletes the stored token.

## 5. Things that are NOT secrets but feel like it

- `WOS_PLATFORM_ADMIN_USER_IDS` / `_EMAILS`: access control. Change them to remove someone's operator access, then redeploy.
- Booking links: replace from Settings → Front desk ("Replace link"); the old code stops working at once.

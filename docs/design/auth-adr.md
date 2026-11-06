# ADR-003: Authentication

Status: ACCEPTED for Milestone 1 (owner may revisit)
Date: 2026-11-03

## Options considered

| | Better Auth 1.7 | Auth.js (next-auth) | Supabase Auth |
|---|---|---|---|
| License | MIT | ISC | Apache-2.0 (hosted service) |
| Data lives in | Our Postgres | Our Postgres (adapter) | Supabase's auth schema |
| Email + password built in | Yes | Discouraged (Credentials provider) | Yes |
| Rate limiting built in | Yes | No | Yes |
| Lock-in | Low | Low | Medium (tied to a Supabase project) |

## Decision

Better Auth, email and password, sessions in our database, passwords hashed by the library (scrypt), 12-character minimum, built-in rate limiting left on.

Its tables are mapped onto ours: `users` (approved list) plus three auth-only tables, `auth_sessions`, `auth_accounts`, `auth_verifications`. **These three are additions to the approved table list**; any auth library needs session and credential storage. They are global (not tenant-scoped) and hold no tenant data.

## Consequences

- OAuth providers (Google sign-in) are a config change later, using `auth_accounts`.
- Email verification and password reset need an email sender; deferred until Milestone 3 brings mail. Until then, accounts are unverified and that's acceptable only for development.

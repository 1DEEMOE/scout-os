# License Register

All direct dependencies as pinned in package.json, with licenses from `npm view <pkg>@<version> license` (2026-11-03). Every one permits commercial SaaS use.

| Package | Version | License | Use |
|---|---|---|---|
| @anthropic-ai/sdk | 1.4.0 | Apache-2.0 | Model provider (router) |
| @eslint/js | 10.0.1 | MIT | Lint |
| @googleapis/gmail | 22.0.2 | Apache-2.0 | Gmail adapter |
| @hubspot/api-client | 14.1.3 | ISC | HubSpot adapter |
| @opentelemetry/api | 1.9.1 | Apache-2.0 | Tracing (pinned 1.9.1 by workspace override) |
| @opentelemetry/sdk-node | 0.208.0 | Apache-2.0 | Optional OTel SDK (no-op without a collector endpoint) |
| @playwright/test | 1.64.1 | Apache-2.0 | Browser tests |
| @tailwindcss/postcss | 4.3.4 | MIT | Tailwind build |
| @trpc/client | 11.24.0 | MIT | Browser API client |
| @trpc/server | 11.24.0 | MIT | API layer |
| @types/node | 26.6.6 | MIT | Types |
| @types/pg | 8.23.1 | MIT | Types |
| @types/react | 19.3.0 | MIT | Types |
| @vercel/otel | 2.2.1 | MIT | OpenTelemetry registration in Next.js |
| better-auth | 1.7.16 | MIT | Authentication (ADR-003) |
| drizzle-orm | 0.45.4 | Apache-2.0 | Database access |
| eslint | 10.14.0 | MIT | Lint |
| google-auth-library | 11.3.3 | Apache-2.0 | Google OAuth |
| next | 16.4.5 | MIT | Web app (App Router) |
| pg | 8.23.1 | MIT | Postgres driver |
| pg-boss | 12.38.0 | MIT | Durable job queue (ADR-001) |
| pino | 10.4.0 | MIT | Structured logs |
| react | 19.3.1 | MIT | UI |
| react-dom | 19.3.1 | MIT | UI |
| stripe | 23.1.0 | MIT | Stripe Invoicing adapter and platform billing |
| superjson | 2.2.6 | MIT | API serialization (dates) |
| tailwindcss | 4.3.4 | MIT | Styling |
| tsx | 4.23.15 | MIT | Runs migrations, worker and scripts |
| typescript | 6.0.3 | Apache-2.0 | Language (6.x: typescript-eslint does not support 7 yet) |
| typescript-eslint | 8.72.1 | MIT | Lint |
| vitest | 5.1.0 | MIT | Unit and integration tests |
| zod | 4.6.7 | MIT | Validation and tool schemas |
| PostgreSQL | 16 | PostgreSQL License | Database |

## Transitive licenses that need a note

From `pnpm licenses list --prod`. Everything else is MIT, ISC, Apache-2.0, BSD, 0BSD or Unlicense.

| Package | License | Comes from | Assessment |
|---|---|---|---|
| @img/sharp-libvips-* | LGPL-3.0-or-later | Next.js image optimizer (optional) | Dynamically linked and unmodified; LGPL allows this. We serve no images through it today. See ip-flags #7. |
| lightningcss | MPL-2.0 | Tailwind CSS build | Build tool, unmodified; MPL is file-level and applies only to modifications. |
| caniuse-lite | CC-BY-4.0 | Build tooling (browser data) | Data used at build time; attribution requirement only. |

## Not planned yet

| Package | License | Note |
|---|---|---|
| @temporalio/client | MIT | Rejected for the MVP (ADR-001); upgrade path. |

## Excluded or restricted

| Item | License | Decision |
|---|---|---|
| Bops (OrgoAI/bops) | FSL-1.1-ALv2 | **No code, assets, prompts or branding used.** We build a competing product, which the license forbids. Research used public behavior only. |
| n8n | Sustainable Use License | Not a dependency. Do not embed or resell. |

## Scout OS (Session 6)

No new dependencies were added. The CSV reader (`packages/core/src/scout/csv.ts`) and distance function are written in-house. Data source: NOAA Storm Prediction Center local storm reports — US government work, public domain in the US (see ip-flags #9).

## Platform email (2026-11-05)

| Name | Version | License | Use |
|---|---|---|---|
| nodemailer | 10.2.1 | MIT-0 | Platform email over SMTP (password resets, invitations) |
| @types/nodemailer | 8.0.2 | MIT | Type definitions (dev only) |

## Chat-first UI (2026-11-06)

| Name | Version | License | Use |
|---|---|---|---|
| @fontsource-variable/schibsted-grotesk | 5.3.0 | OFL-1.1 (font), MIT (package) | Self-hosted interface typeface |
| @axe-core/playwright | 4.14.0 | MPL-2.0 | Accessibility checks in e2e tests only (dev dependency, not shipped) |

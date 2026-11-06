# Capability Matrix — Session 1

Date: 2026-11-03. Session: Claude (cloud workspace) running the Part B kickoff, not Claude Code or Cursor.
Rerun Step 1 when you open the repo in Claude Code or Cursor, because their tools differ.

## Repository state

| Item | State |
|---|---|
| Existing code | None. Greenfield. |
| Files present | `CLAUDE.md`, `.cursor/rules/workforce-os.mdc`, `README.md`, `prompts/` (4 files), `docs/` skeleton |
| Package manifests, CI, deploy config | None |
| Git | Not initialized in this session. Owner runs `git init` locally. |

## Local toolchain (verified by command in this session)

| Capability | Status | Evidence |
|---|---|---|
| Shell | AVAILABLE | bash |
| Node.js | AVAILABLE | `node --version` → v22.23.4 |
| pnpm | AVAILABLE | `pnpm --version` → 10.28.0 |
| npm registry | AVAILABLE | HTTP 200 from registry.npmjs.org/next |
| PostgreSQL client | AVAILABLE | psql 16.15 |
| PostgreSQL server | UNAVAILABLE | `pg_isready` → no response |
| Docker CLI | AVAILABLE | 29.9.2 |
| Docker daemon | UNAVAILABLE | `docker info` failed |
| Python | AVAILABLE | 3.13.18 |
| Git / worktrees | AVAILABLE (git 2.43); worktrees UNTESTED | |

## Research tools

| Capability | Status | Notes |
|---|---|---|
| Web search | AVAILABLE | Used for all competitor research |
| Web fetch | PARTIAL | bops.bot and github.com/OrgoAI/bops refused by allowlist. raw.githubusercontent.com README fetched instead. |
| Browser automation (Claude in Chrome, built-in browser) | UNTESTED | Tools exist on the owner's desktop; not needed for Step 2 |
| Subagents | AVAILABLE, NOT USED | Research was sequential; no parallel execution is claimed |

## MCP servers

| Server | Status | Relevance |
|---|---|---|
| `rea` (owner's Windows desktop) | AVAILABLE — `get_device_info` reports `announced`; `list_documents` answered "no app open" | Allowed only on our own builds. Barred from Bops by CLAUDE.md. |
| Supabase | CONNECTED, UNTESTED | Candidate managed Postgres with RLS for dev/staging |
| Netlify | CONNECTED, UNTESTED | Static hosting only; not a fit for workers |
| Zapier, Asana, Google Drive, Figma, Gamma, Sanity, Wix, Exa, others | CONNECTED, UNTESTED | Not needed for Session 1 |
| Gmail, HubSpot, QuickBooks, Stripe | NOT CONNECTED | Milestones 3–5 and 8 use sandbox accounts the owner creates |

## What this unblocks

- Step 2 research: unblocked by web search; Bops claims rely on the published README plus third-party listings (see confidence column there).
- Milestone 1: needs a running Postgres. Options: local Docker on the owner's machine, Supabase branch, or a Postgres install. **Owner decision.**
- Verified commands (proposed, not yet run): `pnpm install`, `pnpm test`, `pnpm lint && pnpm typecheck`, `pnpm build`.

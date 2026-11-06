# Competitive Intelligence — Session 1

Researched 2026-11-03. Every claim lists a source and confidence.
**H** = vendor's own published material. **M** = two or more third-party sources agree. **L** = one third-party source, or sources conflict.
Marketing copy is labelled as such. Nothing here was taken from Bops source code; only its public README was read.

## 1. Bops (Organic Intelligence, Inc. / Orgo)

| Area | Finding | Source | Conf. |
|---|---|---|---|
| Form factor | macOS desktop app, Apple silicon only. Electron shell around a local Next.js server. Also lists iOS/Web/API/CLI. | README; EveryDev | H (Mac); L (others) |
| Team model | One lead bot that delegates to specialist bots the user adds; bots message each other and report back in chat. One team per workspace. | README | H |
| Channels | App, Slack, Telegram, Discord; text, phone and email on paid plans. WhatsApp "coming soon". | README | H |
| Computer use | Bots run on Orgo cloud VMs (4 cores, 16 GB, multi-screen). User can watch live and take over. Optional tasks in the user's own Chrome; file/shell access needs an explicit opt-in. | README | H |
| Memory | Per-workspace long-term memory across channels, via Honcho. | README | H |
| Approvals | Reads run freely; sending, creating and paying wait for approval. A "just do it" mode skips approval except for payments, costly lookups and emailing newly found contacts. | README | H |
| Integrations | Composio for ~1,000–1,400 apps (figures differ by source); AgentMail for email; AgentPhone for phone; treg for business data lookups. | README; EveryDev; Composio | M |
| Credentials | Passwords and 2FA stored in macOS Keychain, never shown to models. | README | H (vendor claim, unverified) |
| Models | OpenAI only (Responses API computer tool; Codex CLI for Mac tasks; OpenAI voice). | README | H |
| Pricing | Free $0 ($5 one-time credit, shared computer with hour cap); Pro $20/mo ($20 credit); Max $200/mo ($200 credit). Credit does not roll over. | README; EveryDev | H |
| Pricing conflict | Max computers: README says up to 3, EveryDev says up to 5. Free computer: README says 10 hrs/mo, EveryDev says always-on. | README vs EveryDev | L — treat as UNKNOWN |
| Maturity | Latest listed release v0.0.6; listed on directories Oct 2026. | EveryDev | M |
| License | FSL-1.1-ALv2: anything except a competing product; each version becomes Apache-2.0 after two years. Trademarks reserved. | README (LICENSE file not fetched) | M |

**Explicit unknowns:** multi-user/team permissions inside one workspace; audit log depth; data residency; what happens to VMs and memory when a plan lapses; reliability of computer-use runs; SOC 2 or similar.

**Read of the market position:** Bops is a single-operator, desktop-first, consumer-priced product. Its strengths are channels (phone, email identities per bot) and watchable computers. Its gaps for business buyers are Mac-only, one-model dependency, unclear multi-user controls and an approval bypass mode.

## 2. Adjacent competitors

| | Lindy | Relevance AI | n8n | CrewAI |
|---|---|---|---|---|
| Type | Hosted AI-employee builder | Hosted "AI workforce" builder | Workflow automation with AI nodes | Multi-agent framework + hosted platform |
| Published pricing | Plus $29.99, Pro $99.99, Max $199.99 per seat/mo; no free plan [M] | Free tier only on public page; Pro/Team unpublished; usage = Actions + model pass-through [L] | Cloud Starter ~€20–24/mo, 2,500 executions [L] | OSS free; Enterprise Basic free (50 runs/mo); Enterprise custom [L] |
| License | Proprietary SaaS | Proprietary SaaS | Sustainable Use License: no reselling, rebranding or embedding without a deal [M] | Core framework MIT [M] |
| Cost model risk | Credits pool and pause when empty; no overage | Two meters (actions + model spend) | Execution-based | Self-host cost is yours |

### 12-criteria matrix

Scores: 1 (weak) – 5 (strong). **These are analyst judgments from the sources above, not measurements.** `?` means no reliable evidence was found.

| Criterion | Bops | Lindy | Relevance | n8n | CrewAI |
|---|---|---|---|---|---|
| Onboarding ease | 4 | 4 | 3 | 2 | 1 |
| Workflow depth | 3 | 3 | 4 | 5 | 4 |
| Agent collaboration | 4 | 3 | 4 | 2 | 5 |
| Computer-use reliability | ? | ? | ? | 1 | 1 |
| Memory | 4 | ? | ? | 2 | 3 |
| Phone/email | 5 | ? | ? | 2 | 1 |
| Transparency/control | 3 | ? | 3 | 4 | 4 |
| Cost predictability | 3 | 2 | 2 | 4 | 3 |
| SMB fit | 4 | 3 | 2 | 2 | 1 |
| White-label | 1 | ? | ? | 1 (needs deal) | 4 (MIT) |
| Deployment flexibility | 2 | 1 | 1 | 5 | 5 |
| Integrations | 5 | 4 | 4 | 5 | 2 |

Gaps to close in Session 2 research: Lindy and Relevance computer-use, memory, approvals and white-label all need vendor-doc confirmation.

## 3. Recommended initial segment: small service businesses

Pick **small professional-service firms (1–10 people): bookkeepers, tax preparers, agencies, home-service offices.**

Reasons:
1. Their work is the MVP's agents: inbox triage, client follow-up, invoices, scheduling, weekly reporting.
2. They need real controls (who approved what, client-data isolation), which favours enforced approvals and audit over a solo desktop app.
3. Solopreneurs are already served cheaply by Bops at $20/mo; competing there on price is a weak start.
4. A design partner is available: the owner's own tax practice (~135 clients) can pilot it on sandbox data first. **Owner to confirm.**

## 4. Differentiation strategy (prioritized)

1. **Approvals enforced in platform code, with no "just do it" bypass for Tier 2+, and a full audit trail.** This is the trust story Bops can't tell with a bypass mode.
2. **Web-based and multi-user from day one.** Owner plus staff in one org, role-based permissions. Bops is Mac-only.
3. **API-first, computer-use second.** Fewer flaky VM runs, lower cost per task.
4. **Predictable pricing.** Flat seat price with a clear task allowance and a hard spend cap; no credits that silently pause work (Lindy's pain point).
5. **Model independence** via the router. Bops depends on one model vendor.

Deliberately not competing on yet: phone numbers per agent, white-label, dedicated computers (deferred per roadmap).

## Sources

- [Bops README (raw GitHub)](https://raw.githubusercontent.com/OrgoAI/bops/main/README.md)
- [EveryDev — Bops listing](https://www.everydev.ai/tools/bops)
- [Composio — Bops by Orgo](https://composio.dev/built-with/bops-by-orgo)
- [Jet Admin — Lindy pricing](https://www.jetadmin.io/blog/lindy-pricing/)
- [Automation Atlas — Relevance AI pricing](https://automationatlas.io/answers/relevance-ai-pricing-explained-2026/)
- [Activepieces — n8n Sustainable Use License guide](https://www.activepieces.com/blog/n8n-sustainable-use-license-commercial-use-2026-guide)
- [Automation Atlas — CrewAI pricing](https://automationatlas.io/answers/crewai-pricing-explained-2026/)

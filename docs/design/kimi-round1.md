# Kimi round 1

Clean-room trust UX. Public product ideas only. No competitor text, layout, or code.

Approval policy is unchanged. A suggested rule can be saved only for tier 0–1, and never for money, irreversible actions, or anything tier 2 or higher. Saving a rule does not change `evaluatePolicy`. A chat sentence such as “every Friday, list next week's customers” creates a real `routines` row. The applied schema only allows `morning_briefing`, so that is the kind: `maxTier` stays 0 and the run does not send. Anything that would pay, delete, or send is refused and is not scheduled. Opportunity cards are drafts. SMS and voice stay mock. The text-Scout panel is labelled DEMO and does not use a phone.

Activity-feed group names are a hash of the scrubbed task id or audit target. An email address or a provider key in that field is not shown.

Background practice approvals (`requestedBy` starting with `system:` or `routine:`) expire in 30–60 minutes. `WOS_BACKGROUND_APPROVAL_MINUTES` sets the window and is clamped to that range. The default is 45. A person who asked in chat still waits the normal approval window.

Retry closures are stored only when the provider is a mock and `WOS_MOCK_MODE=1`. A live provider is not replayed from that closure and is not reported as `mock: true`. The original approval-gated tool path remains the way a live call runs.

“remember …” and “forget …” in chat call the memory service. The reply shows a Remembered chip whose Undo button calls `memory.forget`. First-run Undo forgets the practice fact and does not write it again.

New preference rows live in `memory_records` (`kimi:*`) and the existing audit log. Scheduled chat routines use the existing `routines` table. No migration is applied. An in-flight effect is a lock: a second caller waits on it instead of starting another.

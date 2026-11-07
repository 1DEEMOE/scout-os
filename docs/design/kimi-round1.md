# Kimi round 1

Clean-room trust UX. Public product ideas only. No competitor text, layout, or code.

Approval policy is unchanged. A suggested rule can be saved only for tier 0–1, and never for money, irreversible actions, or anything tier 2 or higher. Saving a rule does not change `evaluatePolicy`. Chat routines are stored as notes with `maxTier` 0 or 1 and `sends: false`. Opportunity cards are drafts. SMS and voice stay mock. The text-Scout panel is labelled DEMO and does not use a phone.

New rows live in `memory_records` (`kimi:*`) and the existing audit log. No migration is applied. Replay of a failed mock email, CRM, payment, or model call re-runs the stored idempotent mock. An in-flight effect is a lock: a second caller waits on it instead of starting another.

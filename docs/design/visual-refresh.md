# Visual refresh

Status: Nova is the shipped palette. No approval, routing, or schema change.

## Palette

The signature palette is Nova. Light mode is a cool paper (`#f7f6f8`) with near-black ink (`#16141c`) and an ink navigation bar (`#14121a`). The accent is violet (`#6d28d9`). Dark mode is near-black (`#100e14`) with a lighter violet (`#c4b5fd`).

Primary buttons use a violet-to-coral gradient (`#6d28d9` to `#e11d48` in light, `#c4b5fd` to `#fda4af` in dark). Badges, meters, charts, and body text stay a solid color, so finance, health, and education screens stay calm. Body ink on paper is above 7:1. Secondary text and accents stay above 4.5:1. Status is never color alone: badges keep their words, and the approval rail is only a second cue.

An industry accent changes only the accent hue. The paper, ink, and type stay the same. Light and dark still follow the system, or the explicit choice in Settings and the profile menu.

## Type, space, motion

Body type is 18px. Settings, under Appearance, offers 18, 20, and 22 next to light and dark. The choice is stored in this browser and applied before first paint. Small labels stay at least 16px. Controls stay at least 44px. The chat-first layout keeps its wide gaps. Motion is a short rise with no fade. `prefers-reduced-motion` still turns animation off.

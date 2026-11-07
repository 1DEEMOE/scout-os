# Visual refresh

Status: tokens and shared components. No approval, routing, or schema change.

## Palette

The signature palette is Kiln, darkened after review. Light mode keeps a warm reading surface (`#efe4d4`) and puts the header and navigation on near-black espresso (`#120e0c`), so the chrome feels like a dark frame around the work. The accent on that light surface is oxblood (`#6e2a1c`). On the dark bar it is burnished bronze (`#e8b56a`). Dark mode is near-black throughout (`#0e0c0a`) with the same bronze (`#e2b06a`). It is not a blue or purple SaaS theme. Body ink on paper is above 7:1. Secondary text is above 4.5:1. Status is never color alone: badges keep their words, and the approval rail is only a second cue.

An industry accent changes only the accent hue (pine, copper, rose, sage, and so on) from the workspace pack. The paper, ink, and type stay the same.

## Candidates

Kiln remains the shipped default. Three other palettes are switchable from Settings and the profile menu, stored in this browser only (`data-palette`). Nothing is sent to the server.

Signal is a clean bright paper with electric indigo (`#4c25d6` in light, `#c4b6ff` in dark) and a coral mark (`#c21048` / `#ff9aaf`). Harbor keeps a mist reading surface and a midnight navigation bar, with mint (`#0a6b56` on the page, `#3dface` on the bar and in dark mode). Nova uses a cool paper and an ink bar. Its accent fills are a violet-to-coral gradient; link text stays a solid violet that clears the contrast floor.

Body ink on paper is at least 7:1 in every candidate and both modes. Secondary text, accents, chrome text, and each industry shift stay at least 4.5:1.

Signal is the one to ship if a single choice is needed. The bright page is easier for long reading and for every age, the indigo action color is clear, and the coral mark supplies the pop without turning the whole product into a nighttime theme or a gradient. Harbor is the dramatic alternative. Nova pops the hardest and is the least calm for finance, health, and education.

## Type, space, motion

Body type is 18px, with a reading-size control in the profile menu and in Settings for 18, 20, and 22. The choice is stored in this browser and applied before first paint. Small labels stay at least 16px. Controls stay at least 44px. The chat-first layout keeps its wide gaps. Motion is a short rise with no fade. `prefers-reduced-motion` still turns animation off.

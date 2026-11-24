# Finman — «STATEMENT DESK» (24.11.2026)

Owner, 23.11: the app looks «максимальная, странная, примитивная»; after sign-in nothing is clear — he wants a real
dashboard, first steps, to be led by the hand. 15 sign-ups, everyone left; funnel goal: of 10 who see the first
screen, 5 reach their own data (now 2). Benchmark LEVEL (not look): Monarch, Copilot Money, YNAB, Revolut —
calm density, one clear number per block, sidebar navigation, no marketing type inside the product.

Replaces «CLEAR DAY» (cold `#F1F4F9`, Rubik, cobalt `#2B50F0`, oversized pill slabs) — different on all 5 axes.

## Tokens (law — components use only these)
- `--sd-canvas #F2F4F3` (stone with a green cast; never cream) · `--sd-surface #FCFDFC` · `--sd-sunk #E8ECEA`
- `--sd-ink #10201B` (text) · `--sd-ink-2 #4A5A54` · `--sd-ink-3 #7A8882` · `--sd-line #DCE2DF` (hairline)
- `--sd-rail #0F1A17` (desktop sidebar, dark) · `--sd-rail-ink #C9D6D0` · `--sd-rail-active #1E2E29`
- `--sd-money #0E7A5A` (primary action, income, progress) · `--sd-money-soft #DDEFE7`
- `--sd-spend #C9502F` (ONLY money going out) · `--sd-warn #B7791F` (only warnings)
- Dark theme: canvas `#0D1412`, surface `#141D1A`, line `#24302C`, ink `#E6EEEA`, money `#3FBF8F`, spend `#E7765A`.
- Type: **Geologica** variable (self-host woff2, Latin+Cyrillic), UI 400/500, headings 600, numbers `font-variant-numeric: tabular-nums`.
  Scale: 12 / 13 / 14 (body) / 16 / 20 / 24 (page title) / 32 (the one big number per screen). Nothing above 32 inside the app.
- Radius: 10px cards, 8px buttons and inputs, 6px chips. No pills except status chips. Borders 1px `--sd-line`; shadow only on overlays.
- Spacing 4-based: 4 8 12 16 24 32 48.

## Layout
- Desktop ≥1024: left rail 232px (`--sd-rail`, logo, sections with icons, «Feedback», user at bottom) + content max 1120px, 24px gutters.
- Phone: slim top bar (logo, page title) + bottom tab bar: Home · Transactions · ＋ Add · Money map · More.
- Dashboard grid: main 8/12 + right column 4/12 (First steps, tips); phone — one column, First steps first.

## Signature
1. **Month strip** — one horizontal ruler at the top of Home: came in / went out / left this month, a tick for today,
   the one 32px number = what is left. Demo data shows it filled from the first second.
2. **First steps rail** — 4 numbered steps with a progress fraction («1 of 4»), the current step opened with one
   sentence and one button, done steps collapse with a drawn check. It leads the person by the hand.

## Motion (only this)
- Bars and the strip: `scaleX` 0→1, 420ms `cubic-bezier(.22,1,.36,1)`, stagger 40ms.
- The big number counts up 600ms once. Step check: stroke-dashoffset 260ms. Hover/press ≤150ms.
- `prefers-reduced-motion`: everything static.

## Bans
No hero-size headlines in the app, no pill slabs, no cobalt, no purple, no centered marketing blocks, no emoji icons,
no survey before day 3. Demo data is labelled «Example» in one small chip, never hidden.

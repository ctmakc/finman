# finman app — DESIGN.md

**Direction: CHART DATUM** — the app is the same product as the marketing site.
The site's `/data/projects/finman-money-site/DESIGN.md` is the parent law (why
the hydrographic chart, the tide staff, the upright/italic rule, the magenta
budget); this file is the app's token kit and the rules the app adds: a dark
variant and the conventions for data-dense screens. Components reference tokens
only — no raw hex, no magic numbers, no `#fff`.

## The five rules the app inherits

| Chart convention | In the app |
|---|---|
| Ground is printed chart water; deep water is the lighter band | `--shallows` is the page, `--deeps` is the header, modals, drawer, inputs' plate |
| Depth is tint + contour, never elevation | **radius 0, no shadows**, 1px `--fm-contour` rules; the single pill is for chips |
| Magenta = advisory / predicted only | `--fm-advisory` appears on the forecast figure, the forecast band and the chart envelope — **≤3 per viewport**, never on anything that already happened |
| Soundings are small numerals printed where they happened | KPI tiles are **soundings**: Azeret Mono 500 figure, upright small-caps label, a vertical contour between them |
| Upright = happened, italic = predicted | every forecast figure is italic (`.is-forecast` / `.is-predicted`, `.forecast-projected .value`, `.detail-item .value`, `.trend-prediction`) |

## Tokens (`public/css/style.css`, one `:root`)

Every colour is written once as `light-dark(light, dark)`; the theme is chosen
by `color-scheme` (`:root { color-scheme: light dark }` in system mode,
`html[data-theme="light|dark"]` pins one — that is all `public/js/theme.js`
needs). Colour tokens are registered with `@property` so
`getComputedStyle().getPropertyValue('--fm-*')` returns a resolved colour, which
is how `charts.js` reads them.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--shallows` / `--fm-bg` | `#C6E4E6` | `#0B2A2E` | page ground |
| `--deeps` / `--fm-surface` | `#EDF7F6` | `#10363B` | lighter band: header, modal, drawer, insight plate |
| `--fm-surface-2` | `#D9EDEE` | `#164247` | sunken (unused by chrome; legacy alias) |
| `--fm-ink` | `#0B2A2E` | `#D9EEF0` | all text; buttons are ink-filled |
| `--fm-ink-2` / `--fm-ink-3` | `#37585B` | `#A9CBCE` / `#9DC2C5` | secondary text, ≥4.5:1 on both grounds |
| `--fm-contour` / `--fm-border` | `#527E80` | `#5F9094` | 1px rules, ≥3:1 |
| `--fm-datum` / `--fm-border-strong` | `#0B2A2E` | `#D9EEF0` | 2px safety-floor rule, modal edge |
| `--fm-advisory` | `#BE0079` | `#BE0079` | forecast only (band, chart envelope) |
| `--fm-advisory-ink` | `#8E0059` | `#F39BD3` | small predicted text |
| `--fm-drying` | `#3F6B38` | `#9BCB92` | below the datum: over-budget, worst case |
| `--fm-positive` / `--fm-negative` | `#1E6B5B` / `#9E3A2B` | `#7FD1B8` / `#F2A292` | money in / out (surveyed fact, never magenta) |
| `--fm-warning` | `#7A5200` | `#E3C06A` | at-risk budget |
| `--fm-chart-1..6` | ink, contour, `#8AB0B3`, drying, negative, `#1E4C50` | mirrored | categorical series |
| `--fm-chart-income/expense/forecast/forecast-band/datum/grid/tick/surface`, `--fm-chart-font`, `--fm-chart-grid-alpha`, `--fm-chart-forecast-band-alpha` | | | semantic chart tokens for charts.js |

`--fm-primary*` aliases point at ink/contour/deeps so every legacy selector in
`parts/*.css` lands on the chart palette. Shadows: `none`. Radius: `0`,
`--radius-pill: 999px` for chips only.

## Type

| Role | Face | Rule |
|---|---|---|
| UI / display | **Familjen Grotesk** 400–700 variable, true italic | headings 500, tracking −0.02…−0.028em, left-aligned; page title `clamp(1.6rem, 1.1rem + 1.6vw, 2.25rem)` |
| Figures | **Azeret Mono** 500, `tabular-nums lining-nums` | every numeral: `.amount`, soundings, table amount/date cells, hero figure, chart ticks via `--fm-chart-font` |
| Long-form AI text | **Newsreader** 400, 18px/1.55 | `.fm-insight-text`, `.ai-msg-text`, `.ai-plan p` — never a heading, never above 20px |

Self-hosted woff2 in `public/vendor/fonts/` (copied from the site, latin +
latin-ext). Cyrillic strings (uk/ru dictionaries) fall back per glyph to the
system sans; that is accepted for now.

## Layout primitive — ruled rows

Cards are gone as objects: `.card` and every screen's card class become a
transparent surface with one 1px contour on top (`::before`, so it can be
drawn). Section headers sit on a half-strength contour. Budget/debt state
colours the top rule (ok = positive, at-risk = warning, over = drying). Tables
are printed rows: small-caps header on a datum rule, half-strength contours
between rows. KPI rows are soundings separated by vertical contours; at 390 they
become label-left / figure-right tide-table lines.

## Motion

| Element | Spec |
|---|---|
| Contour rules (`::before` of every ruled surface, the hero datum) | `scaleX` 0→1, 520ms `cubic-bezier(.16,1,.3,1)`, 60ms stagger by column |
| Rows (table rows, list items, drawer links) | hover → `translateX(6px)` 140ms `cubic-bezier(.32,.72,0,1)`, never lift |
| Count-ups | 380ms (JS, on real value changes only) |
| Forecast trace | 1400ms linear `stroke-dashoffset` (`--fm-dur-trace`, for charts.js) |

No fade-up reveals, no page-load opacity animation, transform/opacity only;
`prefers-reduced-motion` paints everything finished.

## Ledger position

Row "finman app «CHART DATUM / dark variant»" — same direction as finman.money
(row 75); novelty is not claimed, consistency is. Not used: cream/paper, serif
display, amber/gold accent, indigo, gradients, glassmorphism, shadows, the
template skeleton, uniform fade-up.

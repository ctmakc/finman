# finman app — DESIGN.md

## Direction: CLEAR DAY (12.11.2026, supersedes CHART DATUM's look)

Owner brief (via the front): closer to Wise in spirit, not a copy; fresher,
brighter, modern, friendly, rounder; money must feel trustworthy. Screens:
sign-in, sign-up, first-run start, post-import insight, dashboard, menu, forms,
buttons. Light and dark.

### Three directions considered
1. **CLEAR DAY** (chosen): cool daylight ground `#F1F4F9`, white plates floating
   on soft shadows, one cobalt accent `#2B50F0` (dark `#8098FF`), Rubik variable
   for everything, big calm money figures, pills and 14–28px radii, one solid
   accent card per screen (the AI CFO insight), `freshRise` spring entrance.
2. **MINT LEDGER**: pale mint ground, forest-green accent, Manrope, flat tinted
   panels with no shadows. Rejected: green collides with "positive" money
   colour, and green-on-mint reads as a Wise copy.
3. **PAPER BANK**: warm off-white, navy + coral, serif display figures. Rejected:
   cream + serif is the house slop the design ledger bans; it reads older.

### Locked rules
- **Ground and plates.** Page = `--shallows` (cool light / deep navy). Every card is a plate:
  `--deeps` fill, radius 24 (18 small), `--shadow`, no border, no `::before` rules.
  Section headers and rows separate with spacing and a soft 70% contour, never dashed.
- **One accent.** `--fm-primary` cobalt. Solid fill only on primary buttons, the
  drop-mark tile, the first category bar and the AI CFO insight card. Everything
  else uses `--fm-primary-tint`.
- **Type.** Rubik variable (`/vendor/fonts/rubik-*.woff2`, latin + latin-ext +
  cyrillic). Headings 600–650 with tight tracking; money figures tabular 600; no uppercase
  labels, no mono labels. Hero balance `clamp(2.8rem,…,4.6rem)` with the
  currency sign at 0.42em in ink-3.
- **Controls.** Buttons are pills (`.btn` surface-2, `.btn-primary` accent with
  `--fm-shadow-primary`); inputs are radius 14 on surface-2 fill with a 1.5px
  transparent border that turns primary on focus with a `--fm-focus` ring.
  Tabs are a segmented pill. Buttons never wrap.
- **Shell.** Header translucent with blur; nav links are pills, active = tint.
  Drawer panel radius `0 28 28 0`, pill links.
- **Motion.** `freshRise` 520ms `cubic-bezier(.3,1.3,.5,1)` on hero, drop plate,
  soundings (staggered) and auth card; hover lifts 2px. `prefers-reduced-motion`
  turns it off.
- **Implementation.** `public/css/fresh.css` is loaded after `style.css` and
  overrides it with `:root`-prefixed selectors; tokens stay in `style.css`
  `:root` (`light-dark()`). New components take radius/shadow from the
  `--fresh-*` variables in fresh.css.
- **Gates.** WCAG contrast on start / insight / dashboard / drawer in both
  themes; `test/fe-shell.test.js` token contrast (positive light is `#0A7752` so it
  passes on surface-2); `hero-image-check` on `/` (login hero = product shot `img/auth-hero.webp`).

---

## Previous direction (CHART DATUM) — kept for token history


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

## First run (2026-11-12, branch `feat/onboarding-activation-1112`)

Value inside the first minute, inside the same direction (no new tokens):

- **Front door** (`renderLoginPage`, `.auth-split`): 7/5 split, left plate = shallows
  `--fm-surface-2` with the promise ("Drop a bank statement…") + three ruled points
  + a crop of the real insight screen (`/img/auth-hero.webp`, demo data) as the hero
  picture; right = the form, "Create account" first for new visitors, email + password
  only (name optional). ≤900px: the plate becomes a top band (shot 13.5rem), points hidden.
- **Start screen** (`public/js/firstrun.js`, `parts/firstrun.css`): one step,
  7/4 grid — the statement dropzone is the primary action; demo data and "start from
  scratch" sit in the aside as ruled rows. Progress = a sounding line (`frTrack`).
- **Insight** (after import or demo): title "Your money, <range>", Newsreader lede with
  the three numbers that matter, a soundings row (in / spending / net / count), category
  bars (`fmContour` scaleX), recurring charges, biggest one-off expenses, AI CFO chips
  (pills — the only pills on the page).
- **Banners** above the dashboard: email confirmation (deeps, ink edge) and demo data
  (warning tint) with "Import my statement" / "Remove demo data".

## Engagement components — habit loop (2026-11-12, branch `feat/engagement-funnel-1112`)
Extends CLEAR DAY; no new tokens. Styles: `public/css/parts/engage.css` (`:root`-prefixed), script `public/js/engage.js`.
- **Setup rail** — the signature of this layer: five numbered marks on one track (first insight → second statement → budget → goal → weekly review). Done = cobalt tint + check, next = white mark with a cobalt ring and a slow 2.4s pulse; one next-step plate (surface-2, radius 18) with one primary button and one tint alternative. Dismissible; after five steps it collapses into a "Your week in money" card.
- **Side column** (7/5 split, one column ≤900px): streak card (big tabular figure, seven day dots, badge pills on warning-tint, fresh badge pops once), invite card (read-only link + Copy/Share), push card only when the browser can subscribe and is not yet subscribed.
- **AI CFO hero card** shows the rule-based tips from the user's own numbers: bold title + body, action pill, "Ask about this", `1 / 3 →` pager in contrast ink.
- **/week** — "Your week in money" / month: big period title, a delta pill (spending up = negative tint, down = positive tint), segmented Last week / Last month, the same four soundings as the first insight, category rail, biggest payments, budget/goal meters (8px pill bars: cobalt, over = negative, goal = positive), tips as white plates. Empty: plate with one action + a quiet ghost of the filled page (`aria-hidden`, 70% opacity).
- Motion: `freshRise` stagger on plates and soundings, meters grow `scaleX` 700ms expo-out, ring pulse on the next step; all off under reduced motion.
- AI chat replies render markdown (bold, lists, paragraphs) as DOM nodes only.

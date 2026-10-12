# finman app — DESIGN.md

**Direction: NORTHERN LIGHT.** Finman is a personal finance manager that should
feel like a well-made native app: calm white plates on a warm-neutral ground,
one brand green, a signature aurora gradient on the balance card, and a shell
that behaves the way people expect on each device (sidebar on a desktop, tab
bar on a phone). This file is the app's token kit and the rules every screen
follows. Components reference tokens only — no raw hex, no magic numbers.

The previous direction ("CHART DATUM": chart-water ground, radius 0, no
shadows, mono numerals) was retired in October 2026 because it read as austere.
Its ideas that survive: figures are always tabular, predicted values never
borrow the colours of facts, and chroma is rationed.

## The five rules

| Rule | In the app |
|---|---|
| **Plates on paper.** The page is `--fm-bg`, content sits on white `--fm-surface` cards with a 1px `--fm-border` and `--shadow-sm`; hover lifts to `--shadow`. | `.card`, `.dashboard-section`, `.account-card`, widgets, tables, modals |
| **One signature.** The aurora gradient (`--fm-aurora`: deep moss → brand green → teal → violet) appears on the dashboard balance card, the login panel, the brand mark and the "+" tab. Nowhere else. | `.fm-hero`, `.auth-aside`, `.fm-brand-mark`, `.fm-tab-add` |
| **Chroma is rationed.** Green `--fm-primary` is the only interactive colour. Amber `--fm-accent` marks goals and attention. Violet `--fm-advisory` marks the AI CFO and every forecast / predicted figure. Money in/out is `--fm-positive` / `--fm-negative`, never used for chrome. | nav active states, buttons, stat tiles, chips |
| **Figures are tabular.** Every amount, date and percentage renders in `--fm-font-num` with `tnum lnum`, weight 600–700, tracking −0.01em. Azeret Mono is reserved for identifiers (account numbers, tokens, code). | `.account-balance`, `.tx-cell-amount`, `.summary-amount`, `.fm-hero-figure` |
| **Native shell.** ≥1024px: fixed 248px sidebar with the full grouped navigation + a slim top bar (greeting, date, "Add transaction", theme, user). <1024px: top bar with menu + bottom tab bar (Home · Activity · **+** · Budgets · More) and a slide-in drawer for everything else. Modals become bottom sheets ≤640px. | `.fm-sidebar`, `.header`, `.fm-tabbar`, `.fm-drawer`, `.modal` |

## Tokens (`public/css/style.css`, one `:root`)

Every colour is written once as `light-dark(light, dark)`; the theme is chosen
by `color-scheme` (`:root { color-scheme: light dark }` in system mode,
`html[data-theme="light|dark"]` pins one — that is all `public/js/theme.js`
needs). Colour tokens are registered with `@property` so
`getComputedStyle().getPropertyValue('--fm-*')` returns a resolved colour,
which is how `charts.js` reads them.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--fm-bg` | `#F3F5F3` | `#0D1412` | page ground |
| `--fm-surface` | `#FFFFFF` | `#161E1B` | cards, header, modals, sidebar |
| `--fm-surface-2` / `-3` | `#EDF1EF` / `#E4EAE7` | `#1E2724` / `#263230` | sunken (table heads, chips, secondary buttons) / hover |
| `--fm-ink` / `-2` / `-3` | `#10201C` / `#4A5C57` / `#5C6E69` | `#E9EFEC` / `#A9B7B2` / `#96A5A0` | text; ink-2/3 are ≥4.5:1 on both plates |
| `--fm-border` / `--fm-border-strong` | `#DFE6E2` / `#B9C6C0` | `#26312E` / `#3A4844` | 1px rules, hover borders |
| `--fm-primary` / `-strong` / `-tint` | `#0E7C6B` / `#0A6758` / `#E3F3EF` | `#3ECFB2` / `#5FDCC3` / `#163A34` | the one interactive colour |
| `--fm-aurora-1..4`, `--fm-aurora` | `#0B3B36 → #0E7C6B → #3ECFB2 → #6D5DF5` | same | the signature gradient; text on it is `--fm-on-aurora` (white) / `-2` (74% white) |
| `--fm-advisory` / `-ink` / `-tint` | `#6D5DF5` / `#4F3FD6` / `#ECE9FF` | `#9D91FF` / `#B9B0FF` / `#2A2550` | AI CFO + forecasts only |
| `--fm-accent` / `-ink` / `-tint` | `#F0A020` / `#8A4B00` / `#FDF0D5` | `#FFB83D` / `#FFD089` / `#3D2E10` | goals, attention |
| `--fm-positive` / `-tint` | `#166534` / `#DCF5E6` | `#4ADE80` / `#13341F` | money in, on track |
| `--fm-negative` / `-tint` | `#B42318` / `#FBE4E1` | `#F87171` / `#3D1B1B` | money out, over budget (`--fm-drying` aliases this) |
| `--fm-warning` / `-tint` | `#8A4B00` / `#FCEBCF` | `#FBBF24` / `#3B2E10` | at-risk budget |
| `--fm-chart-1..6` | primary, advisory, accent, `#2E9BD6`, `#D9534F`, `#8AA39C` | mirrored | categorical series |
| `--fm-chart-income/expense/forecast/forecast-band/datum/grid/tick/surface`, `--fm-chart-font` | | | semantic chart tokens for `charts.js` |

Elevation: `--shadow-sm` (hairline), `--shadow` (hover / cards that matter),
`--shadow-lg` (modals, drawer, toasts), `--fm-shadow-primary` (primary button),
`--fm-shadow-aurora` (the hero). Dark mode keeps shadows but they fade into the
ground; borders carry the depth there.

Radius: `--radius-xs` 6 · `-sm` 8 · `-md` 12 · `-lg` 16 (cards) · `-xl` 22
(hero, modals, drawer) · `-pill` for chips, avatars and the user chip.

Shell geometry: `--fm-sidebar-w` 248px, `--fm-topbar-h` 60px,
`--fm-tabbar-h` 64px (+ `env(safe-area-inset-bottom)`).

## Type

| Role | Face | Rule |
|---|---|---|
| UI / display | **Familjen Grotesk** 400–700 variable | headings 600, tracking −0.02em; page title `clamp(1.5rem, 1.15rem + 1.2vw, 2rem)`; body 15px/1.5 |
| Figures | **Familjen Grotesk** with `tnum lnum` | every amount, date, percentage; weight 600–700; hero figure `clamp(2.4rem, 1.6rem + 3.6vw, 4rem)` 700 |
| Identifiers | **Azeret Mono** | account numbers, API tokens, code — never money |
| Long-form AI text | **Newsreader** 400, 1.06rem/1.5 | `.fm-insight-text`, assistant messages, plans — never a heading |
| Eyebrows / table heads | Familjen 700, 0.68–0.74rem, tracking 0.06–0.09em, uppercase, `--fm-ink-3` | `.fm-nav-group-title`, `th`, `.fm-hero-eyebrow` |

Self-hosted woff2 in `public/vendor/fonts/` (latin + latin-ext). Cyrillic
strings (uk/ru dictionaries) fall back per glyph to the system sans.

## Components

- **Buttons.** 40px tall, radius 10, weight 600. `.btn-primary` is brand green
  with `--fm-shadow-primary` and lifts 1px on hover; `.btn-secondary` /
  `.btn-outline` are white plates with a border; `.btn-danger` is a ghost that
  tints red on hover; `.btn-icon` is a 36px square ghost. Press = `scale(0.97)`.
- **Inputs.** 42px, radius 10, white plate, 1px border; focus = green border +
  4px 18% green ring. Labels 0.8rem 600 `--fm-ink-2`.
- **Chips / badges.** Pills on `--fm-surface-2`; tinted variants for
  success / warning / error / advisory.
- **Stat tiles.** A 42px tinted icon plate + label-over-value; income green,
  expense red, neutral green-tint.
- **Tables.** Inside a card; sticky uppercase head on `--fm-surface-2`; 52px
  rows; row actions appear on hover. Transactions show a **merchant avatar**
  (first letter on a plate whose hue is hashed from the description; income
  is always green, transfers violet). Below 768px every `.table` reflows into
  stacked cards using `data-label`; transaction rows use a dedicated
  merchant / amount / date / category grid.
- **Status cards.** Budgets, goals and debts carry a 4px left stripe:
  green = on track, amber = goal / at risk, red = over / overdue.
- **Progress.** 8px pill track on `--fm-surface-3`, gradient fill.
- **Modals.** Radius 22, `--shadow-lg`, blurred backdrop, `fmPop`; ≤640px they
  are bottom sheets with a grab handle (`fmSheet`).
- **Toasts.** Ink plate, white text, 4px coloured left edge, bottom-right
  (above the tab bar on phones).
- **Loading.** `.loading` renders shimmering skeleton rows/cards, never a
  spinner (the spinner element stays for legacy callers but is hidden).
- **Empty states.** Dashed card, 64px tinted icon plate, one sentence, one CTA.

## Motion

| Element | Spec |
|---|---|
| Page content (`#main-content > *`) | `fmRise` 280ms expo-out, 40ms stagger for the first three blocks |
| Hero / auth card | `fmRise` 420ms; the aurora blobs drift 14–20s ease-in-out (transform only) |
| Modals | `fmPop` 220ms; sheets `fmSheet` 260ms |
| Drawer | 280ms `cubic-bezier(.16,1,.3,1)` translateX; backdrop fades 220ms |
| Buttons / tabs | hover 160ms; press `scale(0.97)` with `--fm-ease-spring` |
| Skeletons | `fmShimmer` 1.4s linear |
| Count-ups | 380ms (JS, on real value changes only) |
| Forecast trace | 1200ms linear `stroke-dashoffset` |

`prefers-reduced-motion` paints everything finished (durations → 0, aurora
blobs static).

## Accessibility

Every token pairing used for text is ≥4.5:1 in both themes
(`test/fe-shell.test.js` enforces ink-3 / warning / positive / negative on both
plates). Focus is a 2px green outline with 2px offset on every interactive
element. Tap targets are ≥40px; the tab bar is 64px with safe-area padding.
The drawer traps focus and closes on Esc; the "More" tab and the header menu
button both control it (`aria-controls="app-drawer"`).

## Ledger position

Row "finman app «NORTHERN LIGHT»". Not used: cream/paper, serif display,
indigo as primary, glassmorphism outside the hero/insight card, uniform
fade-up, monospace money, radius 0.

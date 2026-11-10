# Source-derived design system

Authoritative source: `public/styles.css`, with structural examples from `public/index.html`. This is an extraction of the existing implementation, not a proposed starter. The initial pre-refinement sync preceded T4. This extraction now includes T8's automatic-update/loading component from the actual source, preserving T4 palette, type and layout. API, data and storage are unchanged.

## Colors — 12 opaque values

Every entry below is declared in `public/styles.css`.

| Token | Value | Use | Source |
| --- | --- | --- | --- |
| `--paper` | `#f3f3f0` | Low-chroma stone/bone page ground | `public/styles.css` |
| `--sheet` | `#ffffff` | Both work panels, inputs, primary-action text | `public/styles.css` |
| `--ink` | `#252c27` | Content, hover border | `public/styles.css` |
| `--muted` | `#596158` | Secondary text, placeholder, disabled text | `public/styles.css` |
| `--line` | `#e5e7e2` | Quiet panel/table/disabled borders | `public/styles.css` |
| `--control` | `#858c82` | Input and payment-choice borders | `public/styles.css` |
| `--green` | `#24553d` | Save, checked payment, focus, ledger symbol | `public/styles.css` |
| `--hover` | `#193f2c` | Primary action hover | `public/styles.css` |
| `--notice` | `#e9ebe5` | Open-test notice and disabled action | `public/styles.css` |
| `--error` | `#8b2929` | Actual failure text; never hidden | `public/styles.css` |
| `--selection` | `#d9e5dc` | Browser text selection | `public/styles.css` |
| `--selected` | `#edf3ee` | Checked payment background | `public/styles.css` |

`currentColor` inherits an existing role. SVG `fill="none"` is absence of paint, not an additional color. There are no gradients, raster assets, external fonts or unlisted literal colors in the chosen artboard.

## Typography — one stack, five sizes, four weights

Source for every entry: `public/styles.css`.

- `--font`: `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` — one stack, five family/fallback entries; no second face.
- `--text-small`: 14px — labels, hints, table and automatic-update status.
- `--text-body`: 16px — body, inputs and primary action; leading 1.5.
- `--text-section`: 20px — section headings and amount placeholder.
- `--text-title`: 24px — compact app title; leading 1.2, tracking -0.02em.
- `--text-amount`: 26px — editable amount; leading 1.2, tracking -0.02em.
- Weights: 400 body/placeholder, 500 labels/product, 600 sections/save/money/checked choice, 650 title.
- Section leading 1.3/tracking -0.01em. Dates, input amounts and table money use tabular figures; money right-aligned.

## Spacing — ten nonzero values

`4, 8, 10, 12, 16, 18, 20, 24, 28, 32px`; all are margins, gaps or padding in `public/styles.css` (zero resets excluded). Named roles: `--gap: 24px`, `--panel-pad: 24px`; phone overrides 20px and 18px respectively. Field gap 16px; label gap 8px; segmented-choice gap 8px. Source: `public/styles.css`.

Main frame 1184px including 32px side padding: 1120px inner = 400px entry + 24px gap + 696px ledger. Panels keep natural height rather than fabricate rows/empty fill. Below 960px they stack with 24px outer padding; below 560px, 16px outer margins and 18px panel padding. Source: `public/styles.css`.

## Radius and depth

Two surface-corner tokens: `--radius-panel: 8px`, `--radius-control: 6px`. The spinner's 50% radius is circular indicator geometry, not a third panel/control corner token. Zero shadow tokens and no resting shadows. Depth comes from clean white work sheets against stone/bone ground and a quiet 1px border. Source: `public/styles.css`.

## Components and states

All rules below: `public/styles.css`; native markup/labels: `public/index.html`.

- Header: compact title/subtitle with a 36px authored outline book/ledger SVG, 30px on phone; no box, giant mark or invented business name. Stroke 1.7, round caps/joins, inherited green.
- Open-test warning: removed from the production app in T4 (it was false copy for a session-gated business screen).
- Both panels: sheet, 1px line border, panel radius and common padding; no stretched empty panel.
- Fields: 48px height, 10px/12px padding, control border and control radius. Placeholder remains legible; hover border ink; disabled text remains opaque and readable.
- Payment: two equal full-label touch targets, minimum 48px, 8px padding/gap, native visible 18px radios. Label contents can wrap on very narrow screens rather than force horizontal overflow. Actual `:checked` controls selected fill, green edge/text and weight. No default payment is introduced.
- Keyboard: 3px green outline, 3px offset. When `:has` is supported, radio focus outlines the whole segment; without it, native input focus retains the global outline. Selected and focused are distinct states.
- Amount: 64px height, 26px tabular text, 12px/16px padding; a clear visual entry point, not a fake summary. Existing field constraints remain unchanged.
- Save: 52px minimum height, green fill, sheet text, 600 weight; hover darker. Disabled action uses notice/muted and quiet border.
- Automatic update: replaces the manual refresh button. Quiet 14px muted status, 48px minimum alignment height, 8px gap; toolbar wraps if date/status cannot fit. A reserved 16px decorative spinner slot avoids loading shift.
- Spinner: 16px border-box, 2px `currentColor` edge with transparent right side, circular 50% radius. Visibility is hidden while idle but inline space stays reserved; parent `aria-busy="true"` reveals it and rotates it at .8s linear. Save uses an empty absolute pseudo-element at 16px inline-start, vertically centered, so updating its text does not remove or move feedback. No extra opaque colors or fonts; `transparent` is absence of paint.
- Ledger: quiet row rules, no header band/zebra, right-aligned tabular money at weight 600; product lines preserved and safely wrapped; payment secondary. At 560px rows become product+amount over payment, without dropping fields.
- Storage, loading, empty, save and failure messages remain in their original DOM contracts. `data-error="true"` retains error ink. No pseudo-element hides status copy.
- Motion: 1px button press and a busy-only spinner. Reduced motion removes displacement and rotation but keeps the static open-ring indicator visible. No idle/entrance/shimmer animation.
- Async states: table and automatic indicator expose actual GET busy state; Save exposes POST busy with its existing loading text. Same-day rows and drafts/focus persist while refreshing. Selected-date changes clear only wrong-day rows. Errors say refresh failed/data may be old/automatic retry; recovery removes error styling. Visibility/page lifecycle cancels reads; saves pause them. Source behavior: `public/app.js`.

## T4 additions — same tokens only

The stocked v2 screen adds four components, each invented from the existing
source values; no token table above changes.

- Hamburger menu: the toolbar `#logout`-style quiet button (sheet fill, control
  border, 48px square, 20px stroke-1.7 outline glyph) anchors an absolute
  `app-menu` panel with sheet fill, line border and 8px panel radius; entries
  are 44px text buttons whose hover/focus uses the selected-green choice pair
  (`--selected`/`--green`).
- Product suggestions: the input's 48px control continues to own the label;
  the listbox is an absolute sheet panel under the field (line border, 6px
  radius, 280px scroll cap). Options are 44px rows — product text at weight
  500, meta (quedan/precio) at 14px muted; the hovered or `aria-selected`
  option uses the same selected fill.
- Negative-stock confirm buttons reuse the danger language that the row
  delete confirm already owns: `--error` edge/text on `--sheet`.
- Stock panel: `--panel-pad`, `--line`, `--radius-panel` restate the existing
  entry/ledger shell; its table reuses ledger row rules with archived rows set
  in muted ink (`Archivado` suffix). No gradients, shadows or fourth radius.

## Synchronization evidence

Initial source sync: 11 opaque colors, one stack, five sizes, four weights, ten spacing values, two radii, zero shadows. Final source sync: 12 colors (selected-choice role added), one stack, five sizes, four weights, ten spacing values, two radii, zero shadows.

T8 retains those token counts: 12 opaque colors, one stack/five sizes/four weights, ten spacing values, two surface radii, zero shadows. Spinner colors inherit source roles; its 50% geometry is noted separately.

Chosen artboard: `design/daily-sales/01-split-ledger.html`, inline final source styles with a disconnected preview adapter and automatic-status UI; empty data only, no pretend requests or active spinner. Other directions are unchanged. Parent owns the after-render inspector and screenshot critique; this source extraction does not claim rendered acceptance.

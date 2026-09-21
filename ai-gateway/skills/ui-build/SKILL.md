# ui-build

Implement a frontend surface from a design, spec, or existing system. Grounded in
[taste-skill](https://github.com/Leonxlnx/taste-skill) (design-taste-frontend) and
[impeccable](https://github.com/pbakaus/impeccable).

## Protocol

### 1. Read the brief before any code
Page kind, audience, vibe words, references, existing brand assets, quiet constraints
(accessibility-first, regulated, trust-first). Then state one **Design Read** line:
*"Reading this as: <page kind> for <audience>, with a <vibe> language, leaning toward <system or aesthetic>."*
Ambiguous brief → ask exactly one question, never a multi-question dump. If context
infers cleanly, declare the read and proceed.

**Anti-default discipline.** Do not default to: AI-purple gradients, centered hero over
dark mesh, three equal feature cards, glassmorphism on everything, infinite micro-loops,
Inter + slate-900. These are the LLM defaults — reach past them deliberately.

### 2. Pick the foundation honestly
If the brief reads as a real design system, install the **official package** (Fluent,
Material, Carbon, Polaris, Atlaskit, Primer, govuk-frontend, uswds, Radix Themes,
shadcn/ui, Tailwind). Never hand-recreate its CSS or import its tokens then override 90%.
**One system per project** — no Fluent mixed with Carbon.

If the brief is an *aesthetic* (glassmorphism, bento, brutalism, editorial, dark tech,
aurora, kinetic type), there is no official package: build with native CSS + Tailwind and
be honest in comments about borrowed inspiration. Apple "Liquid Glass" has no official web
implementation — label any approximation as an approximation.

### 3. Typographic discipline
- Display: `text-4xl md:text-6xl tracking-tighter leading-none`. Body: `text-base leading-relaxed max-w-[65ch]`.
- **Sans by default.** Serif is very discouraged as a project default — "feels premium" is
  not a reason. Serif only when the brief names a serif, or the family is genuinely
  editorial/luxury/publication AND you can say why this serif fits this brand.
  `Fraunces` and `Instrument_Serif` are banned as defaults.
- **Emphasis:** italic or bold of the *same* family. Never inject a serif word into a sans
  headline for visual interest.
- **Italic descenders:** with `y g j p q`, `leading-none` clips them — use `leading-[1.1]` +
  `pb-1` reserve. Audit every italic display word before shipping.

### 4. Color calibration
- One accent per page, saturation < 80%. **Lila rule:** no automatic purple glows or neon
  gradients; neutral bases (Zinc/Slate/Stone) with one high-contrast accent. Purple only if
  the brief asks, executed with intent.
- **Premium-consumer palette ban:** warm beige/cream + brass/clay/oxblood + espresso text is
  the single most-recurring AI tell. Banned as a default. Rotate: cold luxury (silver/chrome),
  forest (green/bone/amber), black-and-tan, cobalt+cream, terracotta+slate, olive+brick,
  monochrome + one saturated pop.
- **Consistency lock:** one accent on the whole page. A warm-grey site does not get a blue
  CTA in section 7. Same palette, same corner-radius scale, throughout.

### 5. Layout hard rules (violating any = broken work)
- **Hero fits the initial viewport.** Headline ≤ 2 lines, subtext ≤ 20 words / ≤ 4 lines,
  CTAs visible without scroll. Top padding ≤ `pt-24`.
- **Hero stack ≤ 4 text elements:** eyebrow *or* brand strip (pick one), headline, subtext,
  1 primary + ≤ 1 secondary CTA. No tagline under CTAs, no trust micro-strip, no pricing
  teaser, no feature bullets, no avatar row — those are separate sections below.
- **"Trusted by" logo wall goes under the hero, never inside it.** Logos only, no category
  labels. Real SVG logos (simpleicons CDN or devicon), both light and dark.
- **Nav fits one line at desktop**, height ≤ 80px (64–72 default).
- **Eyebrow restraint:** ≤ 1 eyebrow per 3 sections. Count `uppercase tracking` instances;
  more than `ceil(sections/3)` = fail. Drop the eyebrow; the headline is enough.
- **Split-header ban:** "left headline + right filler paragraph" is banned by default. Stack
  vertically at `max-w-[65ch]`.
- **Section-layout-repetition ban:** each layout family appears at most once per page. An
  8-section page needs ≥ 4 distinct families.
- **Zigzag cap:** ≤ 2 consecutive image+text splits; the third is a fail.
- **Bento cells = content count.** No empty tiles. ≥ 2–3 cells with real visual variation
  (image, pattern, tinted bg), not cream-on-cream type-only.
- **Grid over flex-math:** no `w-[calc(33%-1rem)]`. `min-h-[100dvh]`, never `h-screen`.

### 6. Interactive states are not optional
Loading (skeletons matching final layout, not generic spinners), empty, error, success;
tactile `:active` (`-translate-y-[1px]` / `scale-[0.98]`). **Button contrast** passes WCAG
AA (4.5:1 body, 3:1 large) — white-on-white and borderless-over-photo CTAs are banned.
**CTA wrap ban:** primary labels ≤ 3 words, must fit one line at desktop. **No duplicate
intent:** one label for "contact", one for "signup", one for "portfolio", everywhere on the
page. **Forms:** label above input, error below, no placeholder-as-label, contrast AA.

### 7. Assets
Image-gen tool first if available (section-specific, correct aspect). Real web photography
second. Last resort: labeled placeholder slots + tell the user. **Div-based fake screenshots
are banned** — use a real screenshot, a generated image, a real component preview, or skip it.
Even minimalist sites need 2–3 real images. Icons from a library (Phosphor, hugeicons, Radix,
Tabler) — never hand-rolled SVG paths. One icon family, one global `strokeWidth`.

## Verification
Render it in a browser, screenshot, compare to the reference at mobile + desktop. Inspect in
**bounded passes**: build fully → one batched inspection round (desktop + mobile together) →
fix everything in one batch → at most one confirm round → stop. Open-ended polish loops burn
money. Mode decides the bar: **Persuade** (the visitor decides and acts), **Operate** (the
visitor completes a task — scanability outranks expression), **Read** (the visitor
understands), **Experience** (the artifact leads).

## Done looks like
Renders at mobile + desktop, keyboard-navigable, AA contrast, one locked accent and radius
scale, real imagery, full state cycles, no LLM-default tells.

# ui-repair

Fix a layout break, visual mismatch, or accessibility failure in existing UI. Grounded in
[impeccable](https://github.com/pbakaus/impeccable) (audit / polish / harden) and
[taste-skill](https://github.com/Leonxlnx/taste-skill) §4 (bias-correction directives).

## Core stance

**Refinement preserves; redesign replaces.** A repair keeps the incumbent identity,
behavior, copy, and everything outside scope. It does not silently redesign the product. If
the underlying concept is clearly broken, say so and ask — do not restructure under the
guise of a fix.

## Protocol

### 1. Establish visual truth first
Run the app, open the actual page, screenshot the broken state **before** touching anything.
The rendered box model is the fact; the reported symptom is a claim. If the app cannot run,
start from committed visual-regression goldens or screenshot fixtures and reconcile them
against current tokens/CSS/assets.

### 2. Audit in one batched pass
Inspect desktop **and** mobile together in a single round, then fix every finding in one
batch, then at most one confirm round. Never an open-ended polish loop. Check:
- Hierarchy and cognitive load — what is the primary action, what is chrome
- Spacing rhythm, alignment, typography (real quotes, correct dashes, no double spaces)
- Color contrast WCAG AA: text, buttons, form placeholders, focus rings, helper + error text
- Responsive behavior at smallest supported width, default, and wide desktop
- All interactive states: hover, focus, disabled, loading, empty, error, success
- Keyboard reachability and DOM-vs-visual order

### 3. Fix the constraint, not the value
Devtools: which element overflows, which constraint conflicts, which parent's width is the
lie. The repair is usually one property on one selector. If you are touching five files you
are redecorating.
- `min-width: 0` on the flex child, not `overflow: hidden` on the parent
- missing `width` next to `max-width`, not a negative-margin patch
- absolute positioning compensating for a layout bug is a bug, not a fix
- contrast failure means change the color or the text's role — not a `font-weight` bump
- missing label means add a real label — not an `aria-label` duplicating visible text
- keyboard order is fixed in the DOM, never with tabindex gymnastics

### 4. Apply the hard rules when rework is needed
- One accent, one corner-radius scale, one palette, locked for the whole page
- Eyebrows ≤ 1 per 3 sections; split-header and empty bento cells are banned
- CTA labels ≤ 3 words on one line; one label per intent across the page
- Hero ≤ 4 text elements, subtext ≤ 20 words, CTAs above the fold
- Div-based fake screenshots stay banned — real image, generated image, or skip the preview

### 5. Verify the repair
Smallest supported width, default, wide desktop; keyboard path intact; the original failing
assertion now passes; the full test module and suite still green. If a shared contract
changed, sibling tests are the signal, not noise — run them, do not reason about them.

## Failure modes
- Iterating random property values until it "looks okay" without naming the cause
- Hiding overflow, suppressing the error, or special-casing the offending input
- Fixing only the desktop case and breaking the 320px viewport
- Redesigning the section while "fixing" it

## Done looks like
Cause named in one sentence, minimal diff applied, verified across widths and keyboard,
suite green, incumbent identity and copy intact.

# swe-feature

Add or change behavior in an existing repo with targeted verification. Prefer the smallest diff that is correct and complete.

## Protocol

1. **Find the seam first.** Where does this feature naturally attach? Read the nearest existing feature that does something similar and copy its structure — file placement, naming, error handling, test location. A second convention beside an existing one is worse than either.
2. **Ship the smallest complete unit.** No "part 1 of 3". If a sub-step is unreachable today, state what is missing and finish everything reachable. No stubs, no `TODO: implement later`, no fake fallback path.
3. **Every caller migrates.** Rename or move a symbol and the old name dies in the same commit. Shims, aliases, and deprecated re-exports are debt you are choosing over a clean cutover.
4. **Test the behavior, not the plumbing.** A test earns its place if a plausible bug fails it. It asserts what a consumer observes, never implementation details, field copies, or mock echoes. Throwaway scripts prove the new behavior; they do not get committed as tests.
5. **Run the full module, then the suite.** The one test you wrote is not the check. Sibling tests break when you change shared contracts — that is the signal, not noise.
6. **Off by default if shipped behind a flag.** A new code path that changes live serving must be gated, isolated, and exercised by tests only.

## Failure modes

- Half-implementing and calling it an MVP.
- Broad rewrite when a two-line change suffices.
- Adding tests that pin wording instead of behavior.

## Done looks like

Feature works end to end, every caller updated, suite green, diff minimal, nothing left as "follow-up".

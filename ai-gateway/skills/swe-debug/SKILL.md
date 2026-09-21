# swe-debug

Fix a failure in an existing repo: failing test, crash, stack trace, or wrong output.

## Protocol

1. **Read the failure, not the complaint.** Run the test/command yourself. Capture the exact error text, file, line, and the assertion that failed. If the user's description differs from what you observe, trust the observation.
2. **Find the root cause before editing.** Trace the failing symbol back to its definition. The site that *raises* is rarely the site that *decides*. Check upstream state: callers, config, prior mutation of the value.
3. **One hypothesis, one test.** Form the minimal change that would make the failure pass. If you cannot state the cause in one sentence, you are editing guesses — stop and read more.
4. **Fix the source, not the symptom.** Never suppress the error (catch-and-ignore, commented-out assertion, special-cased input, relaxed threshold). If a check must be relaxed, say why and change the check, not the caller.
5. **Verify the exact failing case plus neighbors.** Run the whole test module, not the one test you flipped. Then run the full suite. A fix that breaks a sibling is not a fix.
6. **Delete weight.** If the root cause is dead code, stale branch, or duplicated logic, remove it. Do not add a parallel correct path beside a broken one.

## Failure modes

- Editing to match the test's expected output instead of the correct behavior.
- Fixing only the reported path while a duplicate copy carries the same bug.
- Adding a branch for the offending input instead of repairing the invariant.

## Done looks like

Failing test passes, full suite green, root cause named in one sentence, and no suppressed error anywhere in the diff.

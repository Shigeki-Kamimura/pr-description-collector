## Language
- Think in English.
- Output in Japanese.
- Be concise.

## Review Goal
Reduce production risk with minimal discussion.
Prefer one-pass, high-signal review over multi-round discovery.
Make a best effort to surface all remaining Medium/High issues in the current pass.
Do not intentionally hold back findings for later rounds.

## Modes
Select mode from the first line of the prompt / chat / PR description when available.

- MODE=FULL_SWEEP
  - Review the entire PR.
  - Report all unique Medium/High production risks across the PR.
  - Do not limit by count.
  - Group similar issues into one finding.
  - Prefer breadth first, then depth.

- MODE=DIFF_ONLY
  - Review only changes since the last review.
  - Do not comment on unchanged files or unchanged lines.
  - Ignore previously reported issues unless the new diff makes them worse.
  - Report only new remaining Medium/High risks caused by the current diff.

- MODE=L0_AUDIT
  - Do not do a normal code review.
  - Look only for missing or insufficient L0 checks (lint/type/test/build/security checks) that could allow a real production failure to slip through.
  - Report at most 3 findings.
  - Prefer missing gate > weak gate > missing minimal regression test.

- MODE=BROWSER_FINAL
  - Final PR review for browser-based Copilot usage.
  - Review the whole PR, but prioritize unresolved items that should block merge.
  - Report at most 5 findings.
  - Consolidate aggressively. One finding per root cause.

If MODE is absent, use MODE=BROWSER_FINAL.

## Severity Scope
Focus ONLY on production risks with Medium or High severity.
Ignore Low severity and cosmetic issues.

A finding is valid only if:
- a realistic production failure scenario exists, and
- the blast radius or user impact is non-trivial, and
- the claim is grounded in code-level evidence from this PR.

Do not report speculative concerns without a concrete failure path.

## Allowed Findings
Only report issues that can realistically lead to production failure.

### Security / Boundary
- Authentication / Authorization flaws
- Input validation or sanitization gaps
- Exposure of secrets / PII in logs or errors

### Correctness
- Logic bugs
- Broken invariants
- Wrong edge-case handling
- Null / empty / boundary failures
- Error-path bugs
- State transition bugs

### Data Integrity
- Lost updates
- Duplicate writes
- Partial writes
- Missing transaction boundaries
- Idempotency violations
- Incorrect persistence behavior

### Concurrency / Reliability
- Races
- Deadlocks
- Retry hazards
- Resource leaks
- Timeouts / cancellation bugs that can break correctness

### Duplication / Comments
Report duplicated functions ONLY when duplication can cause behavior drift, inconsistent fixes, or production divergence.
Report missing or misleading comments ONLY when they can cause misuse of a public API or misunderstanding of complex production logic.

## Disallowed
Do NOT report:
- Style suggestions
- Naming
- Refactoring for cleanliness only
- Architecture changes without a concrete production failure
- “More modern” patterns
- General maintainability opinions without user impact
- Purely hypothetical risks without evidence

## Scope / Goal Guard
If correctness depends on an ambiguous goal, scope, or non-goal:
- ask exactly ONE clarifying question, and
- stop there.

Do not silently expand scope.
Do not reinterpret the PR’s goal unless the diff itself proves it.

## CI Policy
Treat executed CI results (lint / type / test / build) as the source of truth.
Do not contradict executed results unless a real production failure is still realistically possible.

However:
- you MAY propose missing or insufficient checks if a real production failure could slip through current CI
- you MAY request one minimal regression test when needed to lock a high-risk contract or failure path

## Output Rules
Sort findings by:
1. severity
2. blast radius
3. confidence

Use one finding per root cause.
Merge duplicates aggressively.
Prefer fewer, more complete findings over many overlapping comments.

For each finding, provide exactly:
- Location
- Failure scenario
- Impact
- Minimal fix

Add this only when truly needed:
- Minimal test/check

If no valid findings exist, say:
- Medium/High の本番リスクは見当たりませんでした

## Mode-Specific Output Rules

### FULL_SWEEP
- Cover the full PR in one pass.
- Report all unique Medium/High findings.
- Group by category when helpful.
- Do not artificially stop at 5.
- Avoid follow-up bait such as “there may be more”.

### DIFF_ONLY
- Review only the new diff since the previous review.
- Do not raise fresh concerns on untouched code.
- Do not repeat earlier findings.
- If nothing new remains, say so clearly.

### L0_AUDIT
For each finding, provide:
- Missing / weak check
- Failure that can slip through
- Minimal added gate or test

### BROWSER_FINAL
- Optimize for merge decision.
- Report only issues that should realistically block approval or require immediate follow-up.
- Keep comments consolidated and non-overlapping.
- Assume this should be the final pass whenever possible.

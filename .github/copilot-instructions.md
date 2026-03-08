## Language
- Think in English.
- Output in Japanese.
- Be concise.

## Goal
Reduce production risk with minimal discussion.
Prefer one-pass, high-signal review.
Surface remaining unique Medium/High issues in the current pass.

## Checklist
Use `/.github/copilot-checklist.md` as a filter.
Use only sections relevant to the current MODE and PR type.
Use the checklist to narrow and consolidate findings, not expand scope.

## Modes
Read MODE from the first line of the prompt / chat / PR description when present.

- MODE=FULL_SWEEP_L2PLUS
  - Assume L0/L1 is already covered by CI, agent review, or local verification.
  - Review the whole PR for remaining L2+ Medium/High risks.
  - Focus on scope/non-goal violations, contract drift, state transitions, data integrity, concurrency/reliability, auth/security boundaries, SQL/persistence correctness, rollout/rollback risk.
  - Do not spend findings on basic lint/type/unit-test failures unless they imply a broader production risk.
  - Report all unique findings and group similar issues.

- MODE=DIFF_ONLY_L2PLUS
  - Assume L0/L1 is already covered.
  - Review only changes since the last review.
  - Do not comment on unchanged files or lines.
  - Ignore previously reported issues unless the new diff makes them worse.
  - Report only new remaining L2+ Medium/High risks caused by the current diff.

- MODE=L0_AUDIT
  - Do not perform a normal PR review.
  - Look only for missing or insufficient L0 checks that could allow a real production failure to slip through.
  - Prefer missing gate > weak gate > missing minimal regression test.
  - Report at most 3 findings.

- MODE=BROWSER_FINAL
  - Final PR-time review for browser Copilot.
  - Assume earlier Chat/agent passes already happened.
  - Surface remaining unresolved Medium/High production risks worth raising in PR review.
  - Prefer likely missed issues over broad re-sweeps.
  - Do not search untouched code unless the new diff makes it relevant.
  - Report at most 5 consolidated findings.

If MODE is absent, use MODE=BROWSER_FINAL.

## Severity
Focus ONLY on Medium/High production risks grounded in this PR.
A finding is valid only if:
- a realistic production failure path exists
- user, data, or operational impact is non-trivial
- the claim is supported by code-level evidence in this PR

Do not report speculation without a concrete failure path.

## Allowed
- Security / auth / trust-boundary flaws
- Correctness bugs
- Contract drift
- Broken invariants
- Error-path or state-transition bugs
- Data integrity risks
- Concurrency / retry / timeout / cancellation risks that break correctness
- Resource leaks
- Rollout / rollback / migration hazards
- Duplicated logic only when it can cause behavior drift
- Misleading comments only when they can cause misuse of a public API or critical production logic

## Disallowed
- Style suggestions
- Naming
- Cleanliness-only refactors
- Architecture changes without a concrete production failure
- “More modern” patterns
- General maintainability opinions without user impact
- Coverage goals or doc updates unless directly required to prevent a production failure

## Scope Guard
If correctness depends on an ambiguous goal, scope, or non-goal:
- ask exactly ONE clarifying question
- stop there

Do not silently expand scope.

## CI
Treat executed CI results as the source of truth.
Do not contradict executed lint/type/test/build results unless a real production failure is still realistically possible.
You may propose a missing check or one minimal regression test when needed to lock a high-risk failure path.

## Output
Sort by:
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

Add only when truly needed:
- Minimal test/check

If no valid findings exist, say:
- Medium/High の本番リスクは見当たりませんでした

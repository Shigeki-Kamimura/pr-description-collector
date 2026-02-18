# coding-rules.md

This document is a governing constraint.

All agents must follow these rules strictly.

If conflicts arise:
Repository rules override general best practices.

------------------------------------------------------------
🚨 Anti-Runaway Rules (CRITICAL)
------------------------------------------------------------

Do not refactor unrelated code. Keep diffs minimal and scoped to the acceptance criteria.

Do not add new dependencies unless explicitly required.  
If you must:
- justify why
- list alternatives
- explain the impact.

------------------------------------------------------------
1. Change Safety (MOST IMPORTANT)
------------------------------------------------------------

Never introduce behavioral changes unintentionally.

Before modifying code:

- Identify invariants and contracts.
- Preserve public interfaces.
- Avoid large refactors unless explicitly requested.

Prefer the smallest safe diff.

If unsure:
STOP and state assumptions before proceeding.

Behavior stability is always prioritized over stylistic improvement.

------------------------------------------------------------
2. Type Discipline
------------------------------------------------------------

Type safety is mandatory.

Never:

- introduce `any`
- weaken type definitions
- bypass the type system
- silence compiler errors

Prefer stricter types over convenience.

If additional type complexity is introduced:
explain why it improves correctness.

------------------------------------------------------------
3. Dependency Control
------------------------------------------------------------

Avoid adding new dependencies.

Before adding one:

- explain why it is necessary
- evaluate maintenance cost
- consider bundle/runtime impact
- check existing utilities first

Prefer:

- standard library
- well-established project utilities

Do not introduce trendy libraries without clear benefit.

------------------------------------------------------------
4. Error Handling Contract
------------------------------------------------------------

Errors must never be hidden.

Never:

- use empty catch blocks
- ignore rejected promises
- silently swallow failures

Errors must be:

✔ explicit  
✔ observable  
✔ actionable  

Fail fast when correctness is at risk.

Do not trade correctness for convenience.

------------------------------------------------------------
5. Test Obligation
------------------------------------------------------------

When behavior changes:

Tests are REQUIRED.

Prefer high-signal tests over large test suites.

Tests must validate behavior,
not implementation details.

Include edge cases when relevant.

If tests are not feasible:
state why explicitly.

------------------------------------------------------------
6. Refactor Protocol
------------------------------------------------------------

Treat refactors as high-risk operations.

Use a two-phase approach:

Phase 1 — Behavior Lock  
- Identify invariants  
- Add guards or tests  

Phase 2 — Minimal Refactor  
- Preserve behavior  
- Keep diffs small  

Never mix refactoring with feature changes.

If both are needed:
split into separate steps.

------------------------------------------------------------
7. Simplicity Rule
------------------------------------------------------------

Prefer the simplest solution that is correct.

Avoid:

- premature abstraction  
- speculative generalization  
- unnecessary layers  

Clarity > cleverness.

Maintainability > novelty.

------------------------------------------------------------
8. Scope Discipline
------------------------------------------------------------

Do exactly what the acceptance criteria require.

Do not:

- expand scope  
- introduce speculative improvements  
- “clean up” unrelated areas  

If a better design is discovered:

👉 propose it, but do not implement without approval.

------------------------------------------------------------
9. Self-Check (MANDATORY)
------------------------------------------------------------

Before finishing any implementation:

Re-evaluate the change for:

- correctness risks
- unintended behavioral changes
- type regressions
- edge cases
- error paths
- performance impact

Assume the code will run in production.

Act accordingly.

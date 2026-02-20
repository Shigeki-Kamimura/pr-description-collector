## Language
- Think in English.
- Output in Japanese.
- Be concise.

Focus only on production risks with medium or higher severity.

Allowed findings:
- Security issues
- Correctness bugs
- Data integrity risks
- Concurrency problems
- Resource leaks
- Clearly duplicated functions
- Missing or misleading comments on public APIs or complex logic

Disallowed:
- Style suggestions
- Naming
- Refactoring
- Architecture changes
- “More modern” patterns

Output constraints:
- Report at most 5 findings.
- Only Medium or High severity.
- Provide:
  - Location
  - Failure scenario
  - Impact
  - Minimal fix

Treat CI results (lint/type/test) as the source of truth.
Do not contradict them unless a real production failure is possible.

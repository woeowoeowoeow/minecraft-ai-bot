# Agent instructions

Read `PROJECT.md` and `docs/` first. Preserve the run rules.

Do not run `git add` or `git commit`. When a commit is needed, flag it and provide the exact proposed commit message.

- **Opus 5.5 — lead:** plan, audit, implement, integrate, and present milestone evidence.
- **Astra/Codex — reviewer/specialist:** independently review design or code and investigate bounded failures; send findings to the lead.

Work one milestone at a time. Audit maintenance, version support, integration, and licenses before adding dependencies. Prefer existing navigation and game tooling. Keep continuous play deterministic; invoke a strong model only for planning or recovery. Do not require a cheap model or paid API for the first playable version.

Each skill needs preconditions, a timeout, an outcome, and a failure reason. Log all evaluation attempts. Diagnose the leading failure before expanding scope. Never add seed-specific logic or hidden intervention.

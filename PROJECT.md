# Project brief

**Goal:** Autonomously defeat the Ender Dragon on unseen random Minecraft Java survival seeds.

**Priorities:** reliability, reuse, unattended runs, few runtime model calls, observable failures. Build through the gates in `docs/milestones.md` (architecture: `docs/architecture.md`).

**Run rules:** no cheats, commands, operator access, fixed-seed logic, manual coordinates, or seed-based structure lookup. The bot may use client-visible state and its own history. Test infrastructure may retain seeds for replay but must not expose them to the bot.

**Success:** multiple unattended wins on held-out seeds. Report every attempt, including failures, timeouts, and interventions, under `docs/evaluation.md`.

**Current scope:** M0 (harness + walking skeleton) implemented; milestone A not started.

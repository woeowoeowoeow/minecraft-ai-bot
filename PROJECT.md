# Project brief

**Goal:** Autonomously defeat the Ender Dragon on unseen random seeds in vanilla **Minecraft Java Edition 1.16.1**.

**Target version:** 1.16.1 is the sole target (official vanilla server, Java 8 runtime, Mineflayer pinned to `1.16.1`) unless this line is explicitly changed. Evidence gathered on 1.21.4 before 2026-09-28 is historical and does not count toward any gate.

**Priorities:** reliability, reuse, unattended runs, few runtime model calls, observable failures. Build through the gates in `docs/milestones.md` (architecture: `docs/architecture.md`).

**Run rules:** no cheats, commands, operator access, fixed-seed logic, manual coordinates, or seed-based structure lookup. The bot may use client-visible state and its own history. Test infrastructure may retain seeds for replay but must not expose them to the bot.

**Success:** multiple unattended wins on held-out seeds. Report every attempt, including failures, timeouts, and interventions, under `docs/evaluation.md`.

**Current scope:** M0 re-gated on 1.16.1. **Milestone A passed** its gate of 2026-10-01 (`20261001-114138-a-a-gate3`: 17/20 = 85 %, 0.30 deaths/run, 0 interventions). Milestone B has not started.

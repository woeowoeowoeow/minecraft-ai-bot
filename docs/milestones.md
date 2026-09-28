# Milestones

There are seven milestones in total: a harness milestone (M0) and six progression milestones (A–F). Each one is a **runtime milestone**, meaning a state predicate the bot reports in `summary.json`, and also a **development gate**. Gates are measured under [evaluation.md](evaluation.md) on **held-out fresh random seeds, from a fresh spawn, unattended**. Fixture scenarios are for development only and never pass a gate.

Rules:
- Work on one milestone at a time. Advance only with a batch report in `runs/` that meets the gate.
- Before the next milestone starts, the leading failure signature of the current milestone must be diagnosed.
- Record any gate change here before measuring against it.
- Time limits are wall clock from bot spawn. Seeds come from a new held-out set per gate batch.

| # | Milestone | Runtime predicate (first reached) | Gate (held-out batch) |
|---|---|---|---|
| **M0** | Harness + walking skeleton | `crafting_table` in inventory | 10 seeds: 10/10 runs produce complete artifacts, ≥ 8/10 reach the predicate within 10 min, 0 infra errors. Navigation benchmark report exists. |
| **A** | Stable Overworld progression | `nether_ready`: iron pickaxe, iron sword, shield, bucket, ≥ 2 iron armor pieces, flint and steel, ≥ 10 obsidian **or** a water bucket plus a known lava pool, ≥ 10 cooked food | 20 seeds: ≥ 70 % within 45 min; ≤ 0.5 deaths/run; 0 interventions |
| **B** | Reliable Nether entry | `in_nether` through a portal the bot built, `portal_nether` remembered, and a return trip demonstrated (`return_ok`) | 20 seeds: ≥ 60 % within 70 min; ≤ 1 death/run |
| **C** | Fortress, blaze rods, pearls | `rods_7` and `pearls_14`, then back in the Overworld | 20 seeds: ≥ 40 % within 120 min |
| **D** | Stronghold and End entry | `eyes_14`, `stronghold_located`, `in_end` | 20 seeds: ≥ 30 % within 160 min |
| **E** | Dragon kill | `dragon_dead` | 20 seeds: ≥ 3 full-run kills within 180 min. End-fixture sub-check (not a gate): ≥ 70 % kills |
| **F** | Reliable random-seed completion | `dragon_dead` under the final declared limit | ≥ 50 held-out seeds, success rate reported with a 95 % CI. **Target ≥ 50 %**, 0 interventions. Repeated on a second held-out set without code changes between them. |

The percentages are the *minimum to move on*. They are not final quality targets. Milestone F is where reliability gets pushed up. Each gate's percentage counts runs that reach that milestone's predicate, so late milestones' rates include every earlier loss.

## Acceptance evidence per milestone
1. `runs/<batch>/report.md` and `batch.json` for the gate batch, with the seed-set id and the code revision.
2. The top 3 failure signatures at or before the milestone, each with a one-line diagnosis and links to representative bundles.
3. Metrics for the milestone: reach rate, median time to reach it, deaths per run, nav failure rate, and reasoner calls per run.
4. Confirmation that no seed-specific code, coordinates or commands were added (a checklist item in the report).

## What each milestone builds (scope guard)
- **M0:** evaluator, server lifecycle, bot connect, observer and digest, telemetry, runner, `navigate`, `collect`, `craft`, NoneReasoner, `inspect` CLI, navigation benchmark.
- **A:** interrupts P0–P2, `defend` and `flee`, `smelt`, `obtain` and its source table, `explore`, `shelter`, progression policy up to `nether_ready`, recovery ladder L1–L3, and death handling.
- **B:** `buildNetherPortal` (lava cast and obsidian), the `nether` nav profile, portal memory and return, and the gate plus a real `ModelClient` behind `REASONER=model`, measured against `none`.
- **C:** `findFortress`, `collectBlazeRods`, `barterPearls`, `huntEndermen`, and strategy switching.
- **D:** `craft eyes`, `locateStronghold`, `enterStrongholdPortal`, and the `stronghold` profile.
- **E:** bed crafting (wool, sheep), `killDragon` (bed_perch, then melee_perch as the alternate), and the End void and enderman interrupts.
- **F:** no new components. Only fixes to the ranked failure signatures.

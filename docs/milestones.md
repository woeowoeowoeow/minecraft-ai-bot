# Milestones

There are seven milestones in total: a harness milestone (M0) and six progression milestones (A–F). **Every milestone targets vanilla Minecraft Java Edition 1.16.1**, the sole target version (PROJECT.md). Gate evidence from any other version does not count. The M0 gates measured on 1.21.4 on 2026-09-27 are historical, and M0 was re-gated on 1.16.1 (evaluation.md, gate log). Each one is a **runtime milestone**, meaning a state predicate the bot reports in `summary.json`, and also a **development gate**. Gates are measured under [evaluation.md](evaluation.md) on **held-out fresh random seeds, from a fresh spawn, unattended**. Fixture scenarios are for development only and never pass a gate.

Rules:
- Work on one milestone at a time. Advance only with a batch report in `runs/` that meets the gate.
- Before the next milestone starts, the leading failure signature of the current milestone must be diagnosed.
- Record any gate change here before measuring against it.
- Time limits are wall clock from bot spawn. Seeds come from a new held-out set per gate batch.
- A change of target version invalidates every gate that was passed. M0 must be re-gated on the new version before the next milestone starts.

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

## 1.16.1-specific scope notes

These follow from architecture.md §14. They change *how* milestones A–F are built, not their gates (the predicates above are unchanged by the migration).
- **A:** iron and gold ore drop the ore block, so `smelt` is on the critical path for iron. Hostile mobs spawn at light ≤ 7, so excavation needs `defend`/`flee`. Night sleep (phantoms, which appear after 3 days awake) is a maintenance objective. Mining depths come from `src/version.ts`: y 16 for iron, y 11 for diamonds, lava at y ≤ 10.
- **B:** ruined portals are a portal source: complete the frame with a lava cast (this still counts as "a portal the bot built"). Wear one golden armor piece before bartering or entering bastions (piglin neutrality). The gold can come from nether gold ore right after entry.
- **C:** 1.16.1 bartering yields 4–8 pearls at 20/423 per ingot, and there are no piglin brutes. `barterPearls` is therefore the primary pearl strategy, with `huntEndermen` (warped forest) as the alternate. Gold comes from nether gold ore and bastions.
- **E:** beds can come from sheep or from bartered string.

## Milestone A predicate: exact reading (recorded 2026-09-28, before any A gate)

`nether_ready` (`src/planner/milestones.ts` `netherReady`) is true when the bot holds, counting worn armor and the off-hand, all of the following:
- `iron_pickaxe`, `iron_sword` and `shield`;
- an **empty** `bucket`. A water bucket does not count as the bucket; a later lava cast needs one bucket for water and one for lava;
- ≥ 2 iron armor pieces;
- `flint_and_steel`;
- ≥ 10 **cooked food**: the outputs of furnace food recipes, i.e. `cooked_*` and `baked_potato`. Bread and dried kelp do not count;
- and either ≥ 10 `obsidian`, or a `water_bucket` plus a remembered Overworld lava pool with ≥ 10 connected lava source blocks and an open surface (`observer.scanLavaPools`, from loaded chunk data).

The evaluator's ground-truth check (`netherReadyInventory`) verifies every inventory clause on the server. The lava pool is bot memory and cannot be checked from the inventory.

**Information note.** The interest index (architecture §8.1) reads ore and lava positions from loaded chunk data, which includes blocks not exposed to air. The approved architecture specifies this ("ores … updated on chunkColumnLoad"), and it is client-received state. It is still stronger than a human player's view. If the project wants "exposed faces only" mining, that is a rule change, and it would need re-gating.

## Milestone B predicate: exact reading (recorded 2026-10-01, before any B gate)

`B` (`src/planner/milestones.ts` `milestoneB`) is first reached when all of the following hold. Everything comes from the bot's own memory and the client's dimension state. The gate itself is unchanged: 20 held-out seeds, ≥ 60 % within 70 min, ≤ 1 death/run, 0 interventions.
- **A portal the bot built:** a remembered `portal_ow` location with source `built` and `lit`, written by `buildNetherPortal` only after it saw the six `nether_portal` interior blocks appear. A ruined portal counts only if the bot completed and lit it itself. The rule for this is the same: any obsidian already in the frame cells is used.
- **`in_nether` through it:** the client received a dimension change Overworld → Nether (respawn packet, not a death) whose departure position lies within 4 blocks of that portal.
- **`portal_nether` remembered:** the observer records the nether_portal block nearest the arrival point, from loaded chunk data.
- **Controlled movement away:** during that visit the bot was at least 12 blocks (horizontal) from the arrival portal (`config/progression.json` `B.excursionMin`).
- **`return_ok`:** a later Nether → Overworld transition that was not caused by a death, with the client then in the Overworld.

The evaluator verifies a claimed B on the server: the Nether-entry advancement (`We Need to Go Deeper`) appears in the log; `data get entity Bot Dimension` reads `minecraft:overworld` at the end; and `execute if block` finds `nether_portal` at the interior cell the bot reports having built. A run that fails any of these checks is not a success.

**Reasoner for B.** The architecture lists "a real `ModelClient` behind `REASONER=model`, measured against `none`" under B. The provider-neutral boundary is built (`src/planner/model.ts`: `ModelClient`, `ModelReasoner` with §5.3 validation, retry and fallback, and unit tests). No provider adapter is shipped, for two reasons:
- A paid API dependency is excluded by AGENTS.md.
- The subscription CLI agent is not a clean runtime provider. It is a tool-using agent with file access, so it would need sandboxing to keep the isolation rules (no seed, server log or world access), and its usage limits make it unsuitable for unattended batches.

Runtime reasoning therefore stays disabled. `reasoner=none` is the B gate configuration, and the `model` vs `none` comparison is deferred until a provider is approved.

## Milestone C predicate: exact reading (recorded 2026-10-06, before any C gate)

`C` (`src/planner/milestones.ts` `milestoneC`) is first reached when all of the following hold. The gate is unchanged: 20 held-out seeds from a fresh spawn, ≥ 40 % reach C within 120 min, 0 interventions, the existing death limit (5 deaths end a run), `reasoner=none`.
- **B first:** milestone B was reached earlier in the same run (its predicate as above).
- **Items:** ≥ 7 `blaze_rod` and ≥ 14 `ender_pearl` in the inventory (`config/progression.json` `later`).
- **Back in the Overworld:** the client is in the Overworld, and its latest dimension transition is a Nether → Overworld *portal* trip (not a death respawn) that followed a Nether entry made after B.

The evaluator verifies a claimed C on the server: everything B checks (the `We Need to Go Deeper` advancement, `Dimension` = `minecraft:overworld` at the end, `execute if block` finds `nether_portal` at the built-portal cell the bot reports), plus ≥ 7 blaze rods and ≥ 14 ender pearls in `data get entity Bot Inventory`. A run that fails any of these is not a success.

**Rule notes for C (no rule change).**
- *Fortress search uses the 1.16.1 structure-placement grid.* The Nether places one structure attempt per 27 × 27-chunk region, with its start chunk in the region's first 23 × 23 chunks, and that attempt is either a fortress or a bastion. This is a fixed game rule (like "strongholds lie in rings" for D), not a seed lookup: the bot never computes where a start chunk is. It only uses which areas *could* hold one and which it has already seen in loaded chunks. The structure census (evaluation.md, milestone C) confirmed the rule on 20 fresh seeds. Fortresses are detected only from natural nether bricks in client-loaded chunk data.
- *Blaze reach.* Attacks respect vanilla survival reach (3 blocks from the eye to the hitbox). The 1.16.1 server would accept up to 6 blocks; using that would be a reach hack.
- *Bartering* is the vanilla interaction: use a gold ingot on an adult piglin (one ingot per use).
- *Early-fail rules* (evaluation.md §1) were adopted and validated for milestone B batches only. C batches run without them (`earlyStop` defaults on for B only). Runs end on the existing terminal conditions or the 120-minute limit.

## Open items carried into A (resolved 2026-09-28)

From the 1.16.1 migration. All are fixed as general causes (architecture §10.2, §10A):
- hazard-blind unstick → hazard-aware directions (`nav/hazards.ts`);
- `exitWater` without an air reflex → surfaces or abandons the exit;
- no lava escape or drowning interrupt → P0 `escapeLava`, `surfaceForAir`, `escapeSuffocation`;
- no combat → P1 `defend` and `flee` with a deterministic threat score;
- excavation planner dead ends → not observed as a leading signature in the A dev batches; no change;
- benchmark underground trials inheriting an ocean position → dry setup, or `SETUP_FAILED`, excluded from the rate;
- outward log search → still unit-test evidence only; the A runs use it on every wood trip.

## What each milestone builds (scope guard)
- **M0:** evaluator, server lifecycle, bot connect, observer and digest, telemetry, runner, `navigate`, `collect`, `craft`, NoneReasoner, `inspect` CLI, navigation benchmark.
- **A:** interrupts P0–P2, `defend` and `flee`, `smelt`, `obtain` and its source table, `explore`, `shelter`, progression policy up to `nether_ready`, recovery ladder L1–L3, and death handling.
- **B:** `buildNetherPortal` (lava cast and obsidian), the `nether` nav profile, portal memory and return, and the gate plus a real `ModelClient` behind `REASONER=model`, measured against `none`.
- **C:** `collectGold`, `barterPearls`, `huntEndermen`, `findFortress`, `collectBlazeRods`, and strategy switching.
- **D:** `craft eyes`, `locateStronghold`, `enterStrongholdPortal`, and the `stronghold` profile.
- **E:** bed crafting (wool, sheep), `killDragon` (bed_perch, then melee_perch as the alternate), and the End void and enderman interrupts.
- **F:** no new components. Only fixes to the ranked failure signatures.

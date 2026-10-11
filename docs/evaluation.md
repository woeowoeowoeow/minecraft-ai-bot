# Evaluation

This is how every attempt is run, recorded and aggregated. The gates themselves are defined in [milestones.md](milestones.md). The runtime artifacts come from [architecture.md](architecture.md) §9.

## 1. Definitions
- **Attempt:** one bot life-cycle on one new world. It starts at bot spawn and ends in one of the outcomes below. Every attempt is recorded, including crashes.
- **Outcomes:**
  - `win`: `dragon_dead`
  - `goal_reached`: the batch's target milestone was reached (for gate batches that stop early)
  - `timeout`: the wall clock ran out
  - `death_limit`: 5 deaths
  - `unrecoverable`: recovery reached L5
  - `infra_error`: server or bot crash, or disconnect not recovered
  - `intervened`: any pause, command or manual action
  - `early_fail`: the evaluator stopped the run under a predeclared early-fail rule (below)
- **Scored:** every outcome except `intervened` counts in the denominator. **`infra_error` counts as a failure** and is also reported separately. An infra rate above 5 % blocks the gate until it is fixed. **`early_fail` counts as a failure**, keeps all of its deaths, and records the rule and its evidence.
- **Early-fail rules (milestone B batches, adopted 2026-10-05).** These save wall-clock time on runs that cannot recover. Scoring does not change: the B criteria stay ≥ 60 % reach B, ≤ 70 min/run, ≤ 1.0 deaths/run and 0 interventions, and 70 min remains the absolute limit. A scored run may end before 70 min only on:
  1. *Existing terminal conditions:* 5 deaths, recovery L5 (`unrecoverable`), or an unrecoverable bot or server crash. These are the bot's or evaluator's own handling and are only labelled in the report.
  2. *`objective_exhausted`:* the same required objective runs its whole recovery ladder (every strategy, ending in "strategies exhausted"). The controller then finds no alternate objective (`suspend_skipped`), so it would only relocate and start again. Firing needs **2** such exhaustions with no milestone or requirement progress in between. Upkeep objectives (bounded + persistent food reserves) never trigger it.
  3. *`controller_stall`:* **all** of the following hold. (a) No milestone or requirement progress for **15 continuous minutes**. Progress means any `milestone` event (milestone or funnel flag), or an objective success that meets its requirement; upkeep successes and successes followed by `OBJECTIVE_NOT_SATISFIED` do not count. (b) The active requirement completed **≥ 3** failed-attempt + recovery-ladder cycles in that window. (c) Nothing new was discovered in that window: no `location_discovered` the bot observed, and no item type held for the first time in the run.
  4. *`impossible_remainder`:* remaining wall time is below a deterministic lower bound on the still-unmet mandatory steps. The only strategy-independent minima are the portal transits (80 ticks each) and a sprint over the excursion distance and back, which gives at most 12.3 s. The A phase and the portal build have no defensible minimum. The rule could therefore only relabel natural timeouts in their last seconds, so it is **off** (`EARLY_STOP.remainderRule = false`). It is implemented and unit-tested.
  
  No run is stopped because it looks bad, is slow, has few resources, or seems unlikely to succeed. The evaluator reads the bot's own `events.jsonl` live (`src/evaluation/early-stop.ts`) on the bot's clock, so a replay of a finished run reproduces the live decision: `npm run inspect -- early-stop <batchId|runId>`. On a trigger it writes `early_stop.json` and an `early_stop` ground-truth record, stops the bot (which writes its result and deaths), and scores `early_fail`. The B report's "Early-fail rules" section lists the gate criteria, then each stopped run's rule, time, wall time saved, stage, margin over the thresholds and evidence, then the rule-1 terminal runs. `--no-early-stop` disables the rules (dev only).
- **Fixture run:** the evaluator uses server console commands to set up a state (for example, starting in the End with gear). Fixture runs are labeled `fixture: true`, use their own seed pool, and never count toward a gate.

## 2. Seeds and isolation (anti-overfitting rules)
1. Seeds come from `crypto.randomInt` in the evaluator. They are stored only in `runs/<batch>/<run>/private/seed.txt`, and they are never passed to the bot through env vars, arguments, files or chat.
2. **Seed sets:**
   - `dev`: a fixed list, free to replay and debug.
   - `heldout-<n>`: generated fresh for each gate batch and never debugged individually before the gate report is written.
   - `fixture`: used for fixture runs only.
3. Once a held-out set has been reported, it may be used to *compare* versions: the same set, before and after a change. Its seeds join `dev` after that, and the next gate uses a new held-out set.
4. **Code rules:** no seed values, coordinates, structure offsets, or per-seed branches anywhere in `src/` or `config/`. Tuning happens per *failure signature*, never per run. The report checklist states this, and the reviewer checks every diff to `src/` and `config/` for it.
5. **Bot isolation:** the bot never has operator status. The server has `enable-command-block=false`, and the evaluator checks `ops.json` is empty. The bot has no access to the server log or the world directory. The server log is only used for ground truth.
6. **Server settings** are fixed per batch and recorded in `batch.json`: vanilla **1.16.1** on **Java 8** (the Java version is recorded too), `difficulty=normal`, `level-type=default`, default gamerules, `view-distance=10`, `online-mode=false`. 1.16.1 has no `simulation-distance` property; entities tick within the view distance.
7. **Time limit:** declared in the batch config before the batch starts. The provisional full-game limit is **180 min** wall clock. It must be finalised here before the first F gate.

## 3. Batch execution
`npm run eval -- --set heldout --n 20 --target C --parallel 2 --limit 120m [--reasoner none|model] [--fixture <name>]`

For each run, the evaluator:
1. creates the world dir
2. writes `server.properties`
3. starts the server with minecraft-wrap
4. waits for "Done"
5. spawns the bot with `RUN_DIR`
6. tails the server log into `ground_truth.jsonl`
7. stops at the target milestone, the limit, or the bot's exit
8. kills the server
9. deletes the world (or keeps it with `--keep-world`)
10. merges ground truth into `summary.json`

Runs in parallel use separate ports and directories.

## 4. Run artifact format

```text
runs/<batchId>/<runId>/
  summary.json          # below
  events.jsonl  trace.jsonl  state.jsonl  reasoner.jsonl  proposals.jsonl
  ground_truth.jsonl    # evaluator only: deaths (vanilla message), advancements, dimension changes
  snapshots/<milestone>.json[.png]
  failures/<n>-<class>/ # bundle: state.json digest.json events_tail.jsonl trace_tail.jsonl
                        #         skill_stack.json nav.json voxels.json shot_fp.png shot_tp.png
  bot.log  server.log   # raw logs (gitignored like all of runs/)
  private/seed.txt
```

`summary.json`:

```json
{
  "runId": "20260930-1412-07", "batchId": "20260930-heldout-3", "seedSet": "heldout-3", "fixture": false,
  "codeRev": "abc1234", "dirty": false, "mcVersion": "1.16.1", "config": {"reasoner": "none", "limitMin": 120, "target": "C"},
  "outcome": "death_limit", "elapsedS": 5231, "gameTicks": 104620,
  "milestones": {"M0": 41, "A": 1610, "B": 2380, "C": null, "D": null, "E": null},
  "flags": {"has_iron_pick": 640, "nether_ready": 1610, "in_nether": 2290, "fortress_found": 3900},
  "deaths": [{"t": 4012, "cause": "fell from a high place", "dim": "the_nether", "signature": "DEATH|collectBlazeRods|..."}],
  "terminalFailure": {"class": "DEATH", "signature": "...", "bundle": "failures/7-DEATH"},
  "failures": {"total": 23, "byClass": {"NAV_STUCK": 6, "COMBAT_DANGER": 4}, "bySignature": {"NAV_STUCK|collect|...": 5}},
  "recovery": {"L1": 14, "L2": 7, "L3": 2, "L4": 0, "L5": 0},
  "skills": {"collect": {"runs": 41, "ok": 37, "p50s": 22}},
  "nav": {"calls": 412, "ok": 381, "stuck": 9, "unreachable": 17, "hazard": 5, "blocksTravelled": 18400},
  "reasoner": {"calls": 0, "byKind": {}, "byTrigger": {}, "accepted": 0, "fallbacks": 0, "tokensIn": 0, "tokensOut": 0, "latencyP50ms": null},
  "interventions": 0, "physicsCorrections": 3
}
```

## 5. Batch report (for developer agents)
`runs/<batchId>/batch.json` holds the aggregates. `runs/<batchId>/failures.jsonl` has one line per failure across all runs: `{runId, t, class, signature, milestone, ladderLevel, bundle}`. `runs/<batchId>/report.md` is generated by `inspect batch <batchId>` and contains:

1. **Header:** seed set, n, code revision, config, limit, and date. Includes the anti-overfitting checklist.
2. **Outcomes:** counts per outcome. Win or goal rate with a Wilson 95 % CI.
3. **Milestone funnel:** reached n/N, p50 and p90 time to reach, and drop-off at each step.
4. **Top failure signatures**, ranked by the number of runs *terminated* by that signature, then by total occurrences. Each row gives the class, milestone, count, affected runs, and 2 example bundle paths.
5. **Deaths:** count per run, a cause histogram (ground-truth message plus signature), and the milestone where each death happened.
6. **Skills:** success rate, p50 duration, and top failure class per skill.
7. **Navigation:** calls, success rate, stuck, unreachable and hazard rates per profile/dimension.
8. **Reasoner:** calls per run, broken down by kind and trigger, with acceptance rate, fallbacks, tokens and latency. Compared against the budget.
9. **Delta vs the baseline batch on the same seed set**, when one is given (`--baseline`).

Developer agents start from `report.md`, then work from the top signature to its example bundles, and only then open individual runs.

## 6. Navigation benchmark (M0 and any nav, dependency or version change)
The evaluator places the bot at spawn on fresh `dev` or held-out seeds. The bot picks targets with its own RNG in the Overworld. Each run has 9 trials:
- 6 surface trials: 2 each at 30, 100 and 300 blocks.
- 2 `cave` trials: a standable cave cell covered by ≥ 2 solid blocks, at feet y **12–40**, within 50 blocks horizontally.
- 1 `depth` trial: excavate to feet y **16**.

The bands are 1.16.1 terrain (architecture §14.1, `src/version.ts` `UNDERGROUND`). The lava level is y ≤ 10 and the Overworld floor is y 0, so the 1.21.4 band (y −20..20) does not exist. y 16 is the iron-mining depth that milestone A will use.

Underground trials run last, because a failed one leaves the bot underground. Nether targets use fixture runs. The benchmark reports success rate, time per block, stuck count per km, and failure classes per trial kind and profile. Targets are picked by the bot at run time, so they depend on no seed.

Conditions:
- **Bare-handed** (scored).
- **`kit`** (fixture): stone pickaxe and 32 dirt; milestone-A-like.
- **`excavation`** (fixture): 2 iron pickaxes, an iron shovel, 64 dirt and `difficulty=peaceful`. It isolates navigation and excavation reliability from tool depletion and mob combat. Falls, lava, water and suffocation still apply.

## 7. Reporting rules
- Report every attempt, including infra errors and intervened runs, which are shown but not scored.
- A claim of reliability needs the n, the CI and the seed-set id. Claim final success only after the F gate passes on two held-out sets.
- Keep `runs/` out of Git. Paste each gate's `report.md` summary into a gate log section at the end of this file.

## Implementation notes (M0)
- Server settings as in §2.6, plus `spawn-protection=0` (vanilla already disables spawn protection with an empty op list; set explicitly so a non-op bot can dig near spawn) and `sync-chunk-writes=false` (performance only). All recorded in each `batch.json`.
- **Ground-truth queries:** at the end of each run, while the bot is still connected, the evaluator runs read-only console queries `data get entity <bot> Inventory` and `… Pos`. They go into `ground_truth.jsonl`. `summary.json.groundTruth.verified` is false when the server inventory disagrees with the bot's claimed outcome, and such a run never counts as a success.
- **Fixtures** (`--fixture kit|kit2|excavation`): on join the evaluator gives items with console commands. `excavation` also overrides server properties (`difficulty=peaceful`), and the override is recorded in `batch.json` and in ground truth. Fixtures are used only for the navigation benchmark's variants (§6). Fixture batches are labeled and never scored.
- **Server runtime:** the evaluator starts the 1.16.1 jar with an explicit Java 8 executable (`MC_JAVA` or the JRE from `npm run setup`) and refuses any other Java major. It passes `-Dlog4j.configurationFile=config/log4j2-server.xml`, the jar's own log format plus `%msg{nolookups}`. The bundled log4j 2.8.1 is vulnerable to Log4Shell; a probe confirmed that `say ${java:version}` is logged literally with the config and expanded without it.
- **Ghost blocks on 1.16.1:** Mineflayer ignores the server's block-break acknowledgements, so a dig the server refused left an air cell on the client only. `src/bot/protocol-fixes.ts` applies the acknowledged block state, and every correction is logged as `dig_ack_correction`. Verified by `tests/scenario/protocol.scenario.test.ts`, which fails without the fix.
- **Inventory resync on 1.16.1:** Mineflayer's `_syncWindow`, which the old M0 craft fix relied on, only works with the 1.17.1+ `stateId` protocol. On 1.16.1 it silently does nothing. `resyncInventory` (`src/skills/generic/craft.ts`) therefore uses the vanilla mechanism: a click outside the window with an empty cursor, claiming an item, which the server rejects and answers by resending the whole inventory. Verified by `tests/scenario/inventory.scenario.test.ts`: a drifted client model is restored, nothing is dropped, and crafting still works.
- **Ground-truth inventory format:** 1.16.1 prints `{Slot: 0b, id: "minecraft:oak_log", Count: 4b, tag: {…}}`. The parser reads top-level items, so damaged tools and enchanted items are counted too.
- The seed exists only in the evaluator and in `runs/<batch>/<run>/private/seed.txt`. The bot gets a whitelisted environment (`BOT_CONFIG`, strict schema, no seed field). `tests/unit/isolation.test.ts` checks that bot-side code never references seeds, the server log, world dirs or ground truth.

- **Host suspension (added 2026-09-29, before the A gate):** the evaluator polls every 500 ms while a run is in progress. A gap over 20 s means the host itself was suspended (laptop sleep), which freezes the server and the bot alike. Such a run is `infra_error` with reason `host suspended Ns …` unless it had already reached its goal, and it counts as a failure (§1) and toward the infra rate. Gate batches run under `caffeinate -dimsu`, which prevents idle sleep. Lid-close sleep cannot be prevented from software without admin rights.

## Gate log

> **Target version changed to 1.16.1 on 2026-09-28** (PROJECT.md). The 1.21.4 sections below are historical: they are superseded, do not count toward any gate, and are kept only for diagnostic comparison. The 1.16.1 sections follow them.

### [Historical, 1.21.4] M0: 2026-09-27 (code uncommitted, dirty working tree; Node 22.23.3, mineflayer 4.39.0, pathfinder @6f5c26b)

| batch | seed set | n | reached M0 ≤ 10 min | p50 / p90 s | infra | complete artifacts | GT mismatches |
|---|---|---|---|---|---|---|---|
| `20260927-204751-m0-gate1` | heldout (fresh) | 10 | 9/10 | 24.4 / 57.4 | 0 | 10/10 | 0 |
| `20260927-211031-m0-gate2` (after fixes) | heldout (fresh) | 10 | **10/10** (CI 72–100 %) | 24.3 / 45.1 | 0 | 10/10 | 0 |
| `20260927-223452-m0-gate3` (final code) | heldout (fresh) | 10 | **10/10** (CI 72–100 %) | 27.6 / 166.3 | 0 | 10/10 | 0 |

Diagnosed failure signatures, all fixed as general causes and never per seed:
1. `MISSING_RESOURCE|craft|craft_planks|…` (gate1 r02). The client inventory desynced from the server: 16 logs were consumed and 3 planks produced. Mineflayer's 2×2 `craft()` never confirms its last click (only table windows are synced). Fix: resync the inventory window with the server before and after each craft, check ingredients only after the resync, and emit `inventory_desync`.
2. Objective menu offered crafting after a death wiped the logs (gate1 r06). Fix: requirements declare `requires`, so the policy offers only objectives whose prerequisites are met (architecture §5.1).
3. `DEATH` (drowned) during a search step (gate1 r06). Mitigation: a navigator low-air reflex and a higher water cost. This is only partly effective (see below).

Remaining leading signature (gate3 r06, r08: slow but successful): **water**. Trees across water cause repeated `NAV_UNREACHABLE`/nav timeouts in `collect`, plus one drowning.

### [Historical, 1.21.4] Navigation benchmark: 2026-09-27

8 trials per run (surface 30/30/100/100/300/300, then 2 cave targets at Y −20..20 within 50 blocks horizontally; caves run last), profile `overworld`.

| batch | condition | surface30 | surface100 | surface300 | cave | all | deaths |
|---|---|---|---|---|---|---|---|
| `20260927-214528-navbench-bare2` (6 fresh seeds) | bare-handed (scored) | 11/12 | 10/12 | 9/12 | 0/12 | 30/48 = 62.5 % | 3 |
| `20260927-221204-navbench-kit` (6 fresh seeds) | fixture `kit` (not scored) | 11/12 | 10/12 | 7/12 | 4/12 | 32/48 = 66.7 % | 0 |

Speed on successful trials is 0.26–0.37 s/block on the surface. Stuck events are 3.4/km (bare) and 6.4/km (kit).

Failure classes: the bot was in water or next to it in 11 of 18 bare failures and 8 of 16 kit failures. It cannot climb out of water onto a 1-block ledge, and it swims with its eyes submerged, so air drains. Dry cave failures come from A* returning only `partial` results for 3D targets with digging, plus oscillation on partial paths. No stuck event happened while digging.

`20260927-211743-navbench-bare` is superseded: its trial order put caves mid-run, and a failed cave trial left the bot underground, contaminating later surface trials. `20260927-214238-navbench-kit` was aborted for the same reason.

### [Historical, 1.21.4] Navigation hardening benchmark: 2026-09-28 (code uncommitted)

This batch follows the same methodology as M0: 8 trials per run, n = 6, fresh seeds, a 25-minute limit and profile `overworld`. The design of the changes is in architecture.md §10.1. "Final code" means everything in §10.1. The `nav2` batches ran an intermediate revision that did not yet have `dryStart`, ceiling-aware surfacing or the `kit2` fixture. The kit batches for the final code ran at `--parallel 1` (see "Void batches" below).

| batch | condition | code | surface30 | surface100 | surface300 | cave | deaths | stuck events/km | server corrections |
|---|---|---|---|---|---|---|---|---|---|
| `20260927-214528-navbench-bare2` (M0) | bare, scored | M0 | 11/12 | 10/12 | 9/12 | 0/12 | 3 (drowned, drowned-mob, lava) | 3.6 | 120 |
| `20260928-002144-navbench-nav2-bare` | bare, scored | intermediate | 11/12 | 10/12 | 11/12 | 0/12 | 2 (creeper, polar bear) | 1.6 | 3 |
| `20260928-010641-navbench-nav3-bare` | bare, scored | final | **12/12** | **11/12** | **12/12** | 0/12 | 1 (zombie) | **0.3** | 1 |
| `20260927-221204-navbench-kit` (M0) | fixture `kit` | M0 | 11/12 | 10/12 | 7/12 | 4/12 | 0 | 6.4 | 1797 |
| `20260928-003844-navbench-nav2-kit` | fixture `kit` | intermediate | 12/12 | 12/12 | 8/12 | 1/12 | 3 (zombies) | 0.3 | 18 |
| `20260928-060750-navbench-nav5-kit` | fixture `kit` | final | 12/12 | 10/12 | 9/11 | 1/10 | 1 (fall) | 1.6 | 136 |
| `20260928-070033-navbench-nav5-kit2` | fixture `kit2` (spare pickaxe) | final | 12/12 | 10/12 | 9/12 | 1/12 | 2 (skeleton, creeper) | 1.3 | 19 |

In the `nav5-kit` batch, 1 of 6 runs was an infra error (keepAlive), which leaves 45 trials. The bare cave trials now fail instantly with `MISSING_RESOURCE` (`no_pickaxe`), which is the intended structured outcome. In M0 the same trials drowned or burned after minutes of searching.

**Water.**
- On the final code, bare surface trials had 0 water-caused failures, against 6 in M0.
- In the kit batches, the remaining surface water failures are:
  - `water exit failed repeatedly` ×3, all in one run on an ocean target (kit2 r05);
  - `cannot surface` ×1;
  - a correction loop in water ×1.

**Underground.** Controlled excavation passes all fixture scenarios. On random seeds it reached 3 of 34 cave trials across the clean kit batches. The failures are:
1. **No pickaxe at trial start** (≈10): the pickaxe was lost in a death, broke in the previous trial, or wore out during earlier travel. That last cause is unverified.
2. **Excavation started in open water**, giving `flooded` or "hazards on every side" (≈6). This is a known bug in `dryStart`: it returns `null` both for "already dry" and for "nothing dry within 12 blocks". Not yet fixed.
3. **Death underground** from mobs (≈3).
4. **`excavation steps keep failing`** (2). Not yet diagnosed.
5. **Pickaxe broke mid-descent** (2). One stone pickaxe (131 uses) does not cover a descent of about 90 blocks plus about 40 horizontal.

**Void batches.** `nav3-kit`, `nav3-kit2`, `nav4-kit` and `nav4-kit2` are void. Under host memory pressure and suspension, most of their runs ended in infra errors (keepAlive timeouts, server not ready after 240 s). They are kept in `runs/` and are not counted above.

### M0 on 1.16.1: 2026-09-28 (code uncommitted, dirty working tree on 56f5769; Node 22.23.3, Java 1.8.0_504, mineflayer 4.39.0, pathfinder @6f5c26b)

This is the M0 gate on the sole target version. Every batch drew 10 fresh held-out seeds from the evaluator CSPRNG, with a 10-minute limit, the scripted reasoner and `--parallel 1`. All four batches are reported. Only the last ran the final code; the earlier three ran intermediate code, as noted.

| batch | code | reached M0 ≤ 10 min | p50 / p90 s | infra | complete artifacts | GT mismatches | failure signatures |
|---|---|---|---|---|---|---|---|
| `20260928-102801-m0-v116-gate` | migration only | 10/10 | 28.6 / 54.0 | 0 | 10/10 | 0 | 1 non-terminal (inventory desync) |
| `20260928-105108-m0-v116-gate-final` | + 1.16.1 inventory resync | 10/10 | 28.9 / 109.5 | 0 | 10/10 | 0 | none |
| `20260928-123823-m0-v116-gate-v2` | + dig acknowledgements (with an install-order bug, see below) | 8/10 | 25.3 / 61.7 | 0 | 10/10 | 0 | `SEARCH_EXHAUSTED|collect|collect_logs|…|target=log` ×2 (terminal) |
| **`20260928-133638-m0-v116-gate-v3` (gate of record, final code)** | final | **10/10** (Wilson 95 % CI 72–100 %) | 23.7 / 28.8 | 0 | 10/10 | 0 | none |

**Gate: M0 passes on 1.16.1.** It needed ≥ 8/10, 0 infra errors and complete artifacts; the gate-of-record batch reached 10/10, and so did batches 1 and 2. Across all 40 attempts, 38 reached M0 and none had an infra error.

Diagnosed signatures:
1. **`MISSING_RESOURCE|craft|craft_planks|…` (batch 1, r08, non-terminal).**
   - The client inventory disagreed with the server. The craft saw no logs, although the client had counted 4 and the server later held 9.
   - The M0 fix for this signature was a resync before and after each craft. On 1.16.1 it was a **silent no-op**, because Mineflayer's `_syncWindow` needs the 1.17.1+ `stateId` protocol.
   - Fixed with a 1.16-protocol resync (implementation notes above), verified by a real-server fixture.
2. **`SEARCH_EXHAUSTED|collect|collect_logs|…` (batch v2, r01 and r03, terminal).**
   - Both runs spawned in treeless terrain near sea level (y 59–73) with no log in loaded chunks. The log search then random-walked around spawn: each 48-block step turned 90–120°, so 3 × 6 steps stayed inside roughly 120 × 80 and 90 × 140 blocks.
   - This happened in 2 of 40 runs on 1.16.1 and never in 30 runs on 1.21.4. The difference is plausibly spawn-biome distribution; it is unconfirmed, and no seed data was examined.
   - Fixed generically: search steps now lead away from the remembered spawn point (±45°) and turn ≥ 90° after a failed step (`nextSearchHeading`, unit-tested).
   - The v3 batch needed no search steps, so **the fix has unit-test evidence only, not gate evidence yet.**
3. **Evaluator note.** The v2 code installed the dig-acknowledgement hook before Mineflayer attached `_updateBlockState`. M0 batch v2 never hit it, but navbench `bare-v2` r02 crashed with an `infra_error`, so that batch was aborted (`runs/…-bare-v2/ABORTED.txt`). A unit test now covers the install order.

### Navigation benchmark on 1.16.1: 2026-09-28 (code uncommitted; same toolchain as above)

Every batch used fresh seeds, `--parallel 1`, a 25-minute limit and profile `overworld`. The plan is 1.16.1's 9 trials per run (§6): surface 30/30/100/100/300/300, 2 caves at feet y 12–40, then depth to y 16.
- The final code is the M0-v3 code plus the excavator lip fix. That fix only runs inside excavation after the pickaxe check, so the bare-handed batch and the M0 gate ran code identical to final in every reachable path.
- Kit and excavation were rerun after the lip fix (v4). The v3 runs of both are shown for diagnosis.

| batch | condition | runs | surface30 | surface100 | surface300 | cave | depth | deaths (ground truth) | stuck events/km | server corrections | dig-ack corrections | infra |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `20260928-134657-navbench-v116-bare-v3` | bare, scored | 6 | 12/12 | 12/12 | 11/12 | 0/12 | 0/6 | 1 (Bot was impaled by Drowned) | 0 | 1 | 0 | 0 |
| `20260928-163234-navbench-v116-kit-v4` | fixture `kit` | 6 | 12/12 | 12/12 | 12/12 | 2/12 | 1/6 | 1 (Bot was slain by Zombie) | 0.6 | 3 | 4 | 0 |
| `20260928-155543-navbench-v116-excavation-v4` | fixture `excavation` | 6 | 12/12 | 12/12 | 10/12 | 5/12 | 3/6 | 1 (Bot tried to swim in lava) | 0.3 | 2 | 18 | 0 |
| `20260928-141701-navbench-v116-kit-v3` | fixture `kit`, pre-lip-fix code | 6 | 12/12 | 12/12 | 11/12 | 2/12 | 0/6 | 3 (Bot was shot by Skeleton; Bot was blown up by Creeper; Bot was burnt to a crisp whilst fighting Skeleton) | 0.6 | 4 | 10 | 0 |
| `20260928-145354-navbench-v116-excavation-v3` | fixture `excavation`, pre-lip-fix code | 6 | 12/12 | 12/12 | 12/12 | 8/12 | 4/6 | 0 (–) | 0.3 | 2 | 9 | 0 |

**Surface (final code): 35/36 bare, 36/36 kit, 34/36 excavation.**
- Speed is 0.25–0.38 s/block and 0–0.6 stuck events/km.
- There were 1–4 server position corrections per 6-run batch; the 1.21.4 M0 kit batch had 1797. The collision-epsilon patch holds on 1.16.1.
- The three surface losses:
  - Bare: `impaled by Drowned` during a 43-node swim, a trident kill and a combat gap (milestone A's P1 interrupt).
  - Excavation v4 r03, two trials: stuck on a slope, then the built-in unstick move (jump and walk forward, hazard-blind) jumped into a lava pit. With no lava escape (A's P0) the bot died, and the next surface300 trial started in lava.

**Underground, excavation fixture (tools, peaceful: navigation isolated), final code: cave 5/12, depth 3/6.**
- Of the trials that started excavating from dry land with a pickaxe, **8/9 reached the target**. The ninth was a correct refusal: water pockets on every side.
- The other 9 were:
  - 6 runs whose surface legs ended in open ocean (`no dry excavation start`, the new distinct outcome);
  - 3 lost to the r03 lava death (no pickaxe left, or the dry-start walk interrupted by death).
- The pre-lip-fix v3 batch reached 12 of 15 dry-land attempts. Its failures:
  - the lip deadlock, fixed and reproduced in a fixture;
  - one planner dead end, boxed in by visited cells and hazards;
  - one planner timeout, from wandering.

**Underground, `kit` (1 stone pickaxe, normal difficulty): cave 2/12, depth 1/6.** The losses are tool depletion and mobs, not stepping:
- open-ocean starts ×9;
- a stone pickaxe (131 uses) broke after 9–145 blocks ×2;
- no pickaxe left after a break or death ×3;
- a zombie death ×1.

No excavation stepping failure occurred in either kit batch. Across the v3/v4 batches, the dig-ack fix applied 40 server block-state corrections: 22 ghost solids the client had dug but the server had not broken (air→stone ×18, grass_block ×3, sand ×1), 8 air→water (the server's cell had already flooded), 9 plants or snow the client still showed after the server removed them, and 1 property-only update.

**Bare-handed (scored): underground 0/18 by design.** There were 12 immediate `MISSING_RESOURCE (no_pickaxe)` results and 6 `no dry excavation start` refusals.

**Diagnostic comparison with 1.21.4** (historical; different terrain distributions, so these are not equivalent measures):
- Surface is on par: the 1.21.4 final code reached 35/36 bare.
- Underground excavation went from 3 of 34 cave trials in the 1.21.4 kit batches to 8 of 9 dry-land attempts in the 1.16.1 excavation fixture. The main differences are:
  - shallower 1.16.1 targets (y 12–40 against −20..20);
  - isolation of tool depletion and mobs;
  - the dig-ack, falling-block and lip fixes.

**Benchmark-design finding.** In 1.16.1 terrain, 8 of the 30 runs in these five batches ended their surface legs in ocean. Their underground trials then measure "refuses to dig from open water", not excavation. Before A, underground trials should start from the run's spawn or another dry point.

**Superseded or aborted 1.16.1 batches** (kept in `runs/`, not counted):
- `20260928-110542-navbench-v116-bare`, `…-113838-navbench-v116-kit`: pre-dig-ack code. Their kit r04 ghost-block stall led to the dig-ack fix.
- `20260928-121823-navbench-v116-excavation`: aborted for the dig-ack fix.
- `20260928-130158-navbench-v116-bare-v2`: aborted after the dig-ack install-order infra error.
- `20260928-102031-navbench-v116-smoke`, `20260928-101930-m0-v116-smoke`: smoke tests, n = 1.

### Milestone A development batches on 1.16.1: 2026-09-28/29 (code uncommitted; dev seed sets, never a gate)

**Development batches.** These are development evidence, not gate batches.
- Each draws fresh seeds from the evaluator CSPRNG into a `dev-<batch>` set (`--set dev`): 45-minute limit, `reasoner=none`, `--parallel 1`.
- Every attempt is listed. The batch named in each row ran the code as it stood at that point.
- Signatures were diagnosed from `report.md` and representative bundles, then fixed generically before the next batch.

| batch | runs | nether_ready | deaths/run | infra | leading signatures → general fix |
|---|---|---|---|---|---|
| `20260928-185530-a-a-dev1` | 3 | 1/3 (16.9 min) | 3.0 | 1 | (1) Combat deaths, and a 412 k-call nav spin ending in a keepAlive kick: GoalFollow's floored `isEnd` returned "arrived" out of reach, and callers spun without yielding. Fix: the navigator always yields; entity goals end on the true distance; chase loops pause. (2) Night death spiral after respawning bare-handed. Fix: capacity scales with weapon dps^1.5; P2 `shelter`. (3) Fruitless hunt blocking iron. Fix: food is first in the list but not a hard prerequisite. |
| `20260928-195912-a-a-dev2` | 4 (+1 stopped) | 2/4 (15.3, 20.4 min) | 1.75 | 0 | (1) A preempted smelt abandoned the meat in its furnace, and the bot re-hunted it. Fix: furnace contents are remembered, and `obtain` collects them first. (2) Eating raw meat at low health drained the hunt. Fix: raw meat only at food ≤ 10; P2 `rest` when fed and hurt. (3) Weak hits: the pathfinder dug while chasing and swapped the sword out, and every swap resets the server's attack strength. Fix: re-arm plus a full cooldown before each attack; no-dig `walk` mode for chases. |
| `20260928-221634-a-a-dev3` | 5 | 2/5 (41.8, 17.9 min) | 0.4 | 3 | (1) Three keepAlive disconnects after multi-minute freezes. At first they were read as bot-side stalls, one inside a `reach` (GoalLookAtBlock) navigation, which led to a raycast guard (prismarine-world's raycast never ends on a non-finite direction) and a stall watchdog. **Corrected after dev5:** the macOS power log shows the host asleep over each freeze window (idle sleep 23:11–23:20, 23:21–23:25 and 23:26–23:29 local). These were infrastructure failures, and the guard is only a safety net. (2) Mixed planks match no minecraft-data shield variant (vanilla accepts any planks). Fix: synthesise the recipe per slot. (3) A retry storm crafting at an unreachable remembered table. Fix: `obtain` drops the hint after a child reports it missing. |

| `20260929-000642-a-a-dev4` | 5 | **4/5** (12.3–15.9 min) | 1.0 | 0 | No stalls, and no raycast-guard trips. The one loss (r01) was an ocean spawn: an unarmed bot engaged a drowned (the scaled threat briefly under capacity), then sat at 0.7 HP for 7 min (food < 18, so no regeneration, and the new rule kept its raw meat uneaten); after respawning at night on hard ground it died 4 times in 60 s. Fix: unarmed never starts a fight; at health ≤ 8 any safe food is eaten; top requirement `emergency_food`; shelter walks to diggable ground. |

| `20260929-012349-a-a-dev5` | 5 | **4/5** (12.3–16.6 min) | **0** | 1 | No deaths. The one loss is infrastructure: the laptop lid-close sleep (01:39:44–01:56:01 local) froze the run in `smelt`, and the stall watchdog stayed silent because the whole host was suspended. Fix (evaluator): detect host suspension from gaps in the evaluator's own poll loop and label the run `infra_error: host suspended`. Gate batches run under `caffeinate`. |

Run 5 of dev2 was stopped at its start: the developer stopped the batch to apply fixes, and it is recorded in `runs/…-dev2/ABORTED.txt`.

### Milestone A gate on 1.16.1: 2026-09-29 (code uncommitted on 56f5769, content hash `4884f87b6e99cd98`; Node 22.23.3, Java 1.8.0_504, mineflayer 4.39.0)

`20260929-090842-a-a-gate`: 20 fresh held-out seeds, 45-minute limit, `reasoner=none`, `--parallel 1`, under `caffeinate`. Every attempt is counted.

| metric | result | gate |
|---|---|---|
| reached `nether_ready` ≤ 45 min | **8/20 = 40 %** (Wilson 95 % CI 21.9–61.3 %) | ≥ 70 % ✗ |
| time to `nether_ready` | p50 1067 s (17.8 min), p90 2127 s (35.5 min) | – |
| deaths | 36, **1.8/run** | ≤ 0.5 ✗ |
| interventions | 0 | 0 ✓ |
| infra errors | 4/20 = 20 % (3 host lid-close sleeps, 1 server start during the same sleep window) | > 5 % blocks the gate |
| reasoner calls | 0 | – |
| navigation | 2578 calls, 290 cancelled by preemption; 87.5 % of the rest ok (12.5 % failure), 0.7 stuck events/km | – |
| ground truth | server inventory agrees with every run that claimed `nether_ready` | – |

**Outcomes:** 8 goal_reached, 4 death_limit, 4 timeout, 4 infra_error.

**Funnel** (runs that reached each flag):
- stone pickaxe 17/20;
- 10 cooked food 13/20, the largest drop;
- iron ingots and iron tools 13/20;
- shield, bucket and armor 9/20;
- flint and steel 8/20;
- lava pool known 19/20.

**Skills:**
- hunt 12 % success (`SEARCH_EXHAUSTED`);
- collect 31 % (`STALLED`);
- smelt 54 %;
- defend 59 %;
- flee 83 %;
- mine 74 %;
- craft 96 %.

**Evaluator defect found while reporting:** report generation overflowed the stack. Run r09 recorded 2 million `obtain` durations, and they were spread into `push(...)`. It was fixed with a loop, and the report was regenerated from the unchanged run artifacts. No measurement changed.

**Top failure signatures and diagnoses:**
1. **Combat deaths on the surface, 36 deaths in 11 runs (4 runs terminated by the death limit).**
   - Killers: skeletons 11, creepers 7, drowned 5, pillagers 4, zombies 4.
   - 21 of 36 deaths had a sword but only 1 had iron armor. 11 happened mid-`flee` from ranged mobs.
   - Deaths clustered in the food objectives (`food` 10, `emergency_food` 9) and in the post-iron shield/crafting phase, while the bot was on the surface.
   - Flee cannot outrun arrows, and shelter often fails on hard ground (20 % success).
2. **Food acquisition.** Hunt success was 12 % and `SEARCH_EXHAUSTED|obtain|food|…|step=hunt` hit 7 runs. Long surface searches cost time (timeouts) and exposure (deaths). 7/20 runs never reached 10 cooked food.
3. **Run r09 (timeout): a no-op loop.**
   - `emergency_food` asks `obtain` for 2 raw meat, and the raw-meat group includes raw chicken.
   - The planner's "edible" test excludes raw chicken, so `obtain` succeeded instantly while the requirement stayed unmet: 2 million iterations.
   - Fix (not applied before the report): make the requirement and its objective use the same food definition, and treat an instant success that leaves the requirement unmet as a failure.
4. **Infrastructure:** the host slept with the lid closed, 15:21–15:54 local (runs r14–r17).

**Gate: milestone A does not pass.** B does not start.

### Milestone A improvement round on 1.16.1: 2026-09-29/30 (code uncommitted; dev seed sets, never a gate)

This round follows the failed A gate. The design is in architecture.md §10B, and the gate itself is unchanged. The baseline is the gate batch. Its survival section was re-derived from the gate's own event streams with the new report code, with no rerun:
- 36 deaths in 11 runs;
- 35 of them with 0 armor points;
- 23 during `flee` and 8 during `defend`;
- 23 in food objectives;
- 21 at night;
- 25 were follow-on deaths after a first death.

Every dev batch draws fresh `dev` seeds: 45-minute limit, `reasoner=none`, `--parallel 1`, under `caffeinate`.

| batch | runs | nether_ready | deaths/run | p50 / p90 s | infra | leading signatures → general fix |
|---|---|---|---|---|---|---|
| `20260929-184134-a-a-dev6` | 4 (+1 stopped) | **4/4** (938–2658 s) | 0.5 (2 in r02) | 1507 / 2328 | 0 | (1) Time, not deaths. r01 spent 8 min re-trying one unreachable dry excavation start at a shoreline (16 × 30 s, `STALLED\|obtain\|kit_pickaxe\|…\|step=mine`). Fix: the navigator skips dry starts it failed to reach for 5 min. Night shelter cost 467–692 s in r01 and r04 with only the cooked-food hunt left, while fully equipped. Fix: when equipped and the only alternative is idle shelter, hunt at night. (2) r02 death 1: cover dug in and sealed twice, then the objective resumed and dug out beside the skeleton at 7.5 HP. Fix: P2 `hold` keeps the bot in a sealed pocket while any hostile is within 16. r02 death 2: four cave skeletons, no hidden cell within 6, no diggable column (cave air beside the shaft), then fled and died; not addressed (single occurrence). (3) `INFRA\|obtain\|iron_ingots\|…\|step=smelt` ×5: "no place to put furnace" inside the 1×2 pocket. Fix: `placeNear` digs a closed head-level niche. |
| `20260929-210022-a-a-dev7` | 6 | **6/6** (764–1545 s) | 0.67 (3 in r01, 1 in r05) | 1128 / 1495 | 0 | (1) Charging lone skeletons. Two fully equipped bots (iron sword, shield, 4 armor) charged skeletons from 13–15 blocks and went 18 → 0 HP in about 11 s; `defend` never blocks while closing in. Fix: the shielded-charge exception is removed, so a shooter beyond 4 blocks always means `cover`. At ≤ 6 HP any shooter in sight means `cover`. (2) r01: a `defend` chase of a zombie 8 blocks off walked over a ravine edge into lava. Fix: `defend` closes in only within 6 blocks and otherwise waits for melee mobs to come; a retreating shooter is left to `cover`. The respawned bot then walked back into the same lava lake to recover items, because the death record had no cause (the chat message precedes Mineflayer's death event). Fix: the observer attaches a death message from the last 3 s. (3) The invariant caught a real gap: `kit_pickaxe` durability 248 < 250 right after success, because mining the cobblestone wore the old pickaxe. Fix: a 16-point wear margin in the requested count. (4) `INFRA\|…\|step=craft` "no place to put crafting_table": `makeRoom` falls back to any liquid-free wall, and no room is a structured `PRECONDITION_FAILED`. |
| `20260929-230537-a-a-dev8` | 6 | 3/6 (750–967 s) | **0** | – | 0 | No deaths; all three losses were control problems introduced in this round. (1) r02 and r03 timed out with everything but the cooked food done by about 600 s. The `hold` rule (sealed in, hostile within 16) re-fired 67 and 30 times on mobs in nearby caves, each time cancelling the objective. Fix: hold only for hostiles within 8 blocks, with a 30 s gap after each hold. `manageInventory` "succeeded" 26× without freeing a slot, each time cancelling the running hunt (38 walks back to the surface). Fix: it fails when no slot was freed, and there is a 20 s cooldown after success. (2) r04 `unrecoverable: food_buffer failed 14×`. The hunt budget, which persists for 10 min, made each retry fail at once, and the 14-failure terminate rule fired on an optional objective. Fix: food objectives are `persistent` (suspended or relocated, never terminating the run), and the hunt budget resets once the bot is > 96 blocks from where it started. (3) `kit_wood` was re-requested after the shield existed; wood is now needed only until the shield is made. |
| `20260930-013942-a-a-dev9` | 8 | 4/8 (765–1619 s) | 0.88 (7 in r02, r03, r06, r07) | 1176 / 1595 | 0 | A regression, with two causes. (1) Night hunting while equipped (the dev6 relaxation) cost 3 deaths: skeleton at 2.2 HP, and creepers during night food and emergency food. Reverted: hunting always waits for day. (2) Creepers vs equipped bots, 3 deaths. One followed the bot through 5 flee/resume cycles and exploded; another, out of sight 2–3 blocks away, swelled during a zombie fight. Fix: with a shield the bot no longer runs from a creeper within 8; it faces it with the shield raised until it explodes or leaves (1.16.1 shields block explosions from the front). A creeper within 3 blocks counts even out of sight. (3) Environmental: r07 drowned mining gravel in a flooded pocket (surfacing failed, no air above), so `collect` never targets a block with water above it. A hunt chase fell 14 blocks, the same shape as dev7's ravine fall, so walk-mode (chase) movements take no parkour jumps and drop at most 3. (4) Food in animal-poor worlds (r03, r08: `food_buffer` up to 811 s before iron, then no cooked food by 45 min). The bounded `food_buffer` now suspends on its first search failure. Evidence for another source: in 4 of the 6 food-failure runs of dev8–dev9, land animals were seen 0–66 times and cod or salmon 200–990 times. Cod and salmon near the water surface are now hunt targets, after land animals and never foraged; cooked cod and salmon count as cooked food. |
| `20260930-062006-a-a-dev10` | 8 | **6/8** (752–1763 s) | **0.125** (1: zombie during a night flee) | 1454 / 1684 | 0 | Cover and creeper responses held: 5/5 cover attempts ok, including the shield creeper standoff 4/4. No ranged or creeper death. Two timeouts. (1) r01, food: after the armor phase, eating the early buffer re-opened `food_buffer` ahead of the cooked-food stock, and the two hunts alternated for a day. Fix: the buffer counts as met once sword, shield and armor are held. That hunt also spent the day on 12 failed salmon chases while rabbits and pigs were around. Fix: fish are approached to reach range (2.5), and after 3 failed fish chases a hunt sticks to land animals. (2) r07, an island or ocean spawn: wooden pickaxe at 556 s, 87 unreachable surface search steps, 54 "no dry excavation start". This is the pre-existing M0-era terrain gap (1/8), not addressed in this round. |
| `20260930-101020-a-a-dev11` | 8 | 5/8 (762–1564 s) | 1.0 (8: 5 in r04, 2 in r01, 1 in r07) | 1427 / 1513 | 0 | Cover 11/12 ok (terrain 6/6, dig-in 3/4, shield standoff 2/2). (1) r04 hit the death limit. Everything but flint and cooked food was done by 601 s. Six bucket crafts failed "no place to put crafting_table" at a water edge (`placementSpots` rejected any water-adjacent cell; now only lava-adjacent). Gravel targets failed on hazards, a drowned killed the bot at night while it ate, and 4 follow-on deaths came after respawns at night. (2) r01: a log reachable only with the head under water gave 68 dig/surface cycles in 10 min, so the wooden pickaxe came at 1178 s. Fix: `collect` never digs with the head in water (target blacklisted). Two night deaths followed. (3) r07 `unrecoverable: wooden_pickaxe failed 14× (SEARCH_EXHAUSTED)` in a treeless area with 15 min left. Fix: search failures (`SEARCH_EXHAUSTED`, `NOT_FOUND`) never terminate a run; they keep relocating. |

dev6 r05 was stopped about 8 min in by the developer tooling's 2-hour background-command limit, which sent SIGTERM to the evaluator. It is recorded in `runs/…-dev6/ABORTED.txt` and not counted. Later batches run detached.

Cover in dev6: 3 attempts, 2 successful (dig-in 2/2) and 1 failure ("no cover"). The schedule logged 17 night deferrals, 4 night shelters and 2 nightfall stops. `OBJECTIVE_NOT_SATISFIED` did not occur.

### Milestone A re-gate on 1.16.1: 2026-09-30/10-01 (code uncommitted on 56f5769, content hash `f8cf5578b57d2290`; Node 22.23.3, Java 1.8.0_504, mineflayer 4.39.0)

`20260930-141405-a-a-gate2`: 20 fresh held-out seeds, the unchanged A gate (45-minute limit), `reasoner=none`, `--parallel 1`, under `caffeinate`. Before the gate, the M0 regression `20260930-141001-m0-m0-regress2` reached M0 in 5/5 runs (p50 27 s, 0 infra). The unit suite (170) and the real-server scenario suite (43) passed on the gate code.

| metric | gate 20260929 (baseline) | **re-gate 20260930** | gate |
|---|---|---|---|
| reached `nether_ready` ≤ 45 min | 8/20 = 40 % (CI 21.9–61.3 %) | **16/20 = 80 %** (Wilson 95 % CI 58.4–91.9 %) | ≥ 70 % ✓ |
| deaths/run | 36 → 1.8 | **11 → 0.55** | ≤ 0.5 ✗ |
| interventions | 0 | 0 | 0 ✓ |
| infra errors | 4/20 (host sleep) | **0/20** | – |
| time to `nether_ready` p50 / p90 | 1067 / 2127 s | 1410 / 1715 s | – |
| outcomes | 8 goal, 4 death_limit, 4 timeout, 4 infra | 16 goal, 3 timeout, 1 unrecoverable | – |
| deaths at night / during flee / in food objectives | 21 / 23 / 23 | 4 / 7 / 8 | – |
| deaths with 0 armor | 35 of 36 | 5 of 11 | – |
| reasoner calls | 0 | 0 | – |
| navigation failure rate | 12.5 % | 20.2 % (164 unreachable, 280 timeouts; mostly hunt chases and search steps) | – |

**Funnel:**
- wooden and stone pickaxe 20/20;
- iron ingots, iron tools, shield, bucket, 2 iron armor, water bucket, flint and steel 19/20 (p50 about 510–730 s);
- 10 cooked food 16/20, the last and largest drop;
- `nether_ready` 16/20.

**Skills** (baseline in parentheses):
- hunt 32.9 % (12.2 %);
- collect 61.1 % (30.9 %);
- defend 73.7 % (58.6 %);
- flee 83.6 % (83.1 %);
- cover 22 of 34 attempts ok, by event (dig-in 11/11, shield 4/4, shield creeper standoff 1/1, terrain 6/9, no cover 0/9);
- shelter 49.4 % (20.3 %);
- smelt 32.7 % (54.1 %; top failure `PRECONDITION_FAILED … place=furnace`, 4×, non-terminal);
- craft 98.6 %;
- mine 81.4 %.

**Deaths (11 in 7 runs):**
- by killer: drowned 6 (impaled 4, slain 2), skeleton 3, creeper 1, fall 1;
- during: flee 7, cover 2, defend 1, surfacing 1;
- by objective: cooked-food stock 6, iron ingots 3, food buffer 1, emergency food 1.

**Top failure signatures:**
1. **Drowned at the shoreline: 6 of 11 deaths, 4 runs (r03, r04, r14, r15).** These include all three timeouts.
   - Every one was at sea level (y 58–63), with 1–6 drowned within 13 blocks, in or right after a food objective (land and fish hunting at water edges).
   - The flee moves inland, but drowned follow onto land and throw tridents.
2. **Cooked food is the last missing item** in all 4 failed runs: hunt 33 %, `SEARCH_EXHAUSTED` in `emergency_food` and `food_buffer`.
3. **r03 `unrecoverable: wooden_pickaxe failed 14× (last NAV_UNREACHABLE)`.** Tree search over unreachable terrain. The dev11 change exempted only `SEARCH_EXHAUSTED`/`NOT_FOUND` from termination, not `NAV_UNREACHABLE`.

**Gate: milestone A does not pass.** It reaches 80 % (≥ 70 % ✓), but has 0.55 deaths/run against ≤ 0.5. Milestone B does not start.

**Single highest-leverage remaining cause:** drowned at water edges during food acquisition. They caused 6 of 11 deaths and were in all three timeout runs. One fewer death would have met the gate's death limit. The fix to try first: treat nearby drowned as a zone hazard for food work. While drowned are within about 16 blocks, skip animal and fish targets within a few blocks of water, and leave the shoreline instead of fleeing along it. (Implemented in round 3 below.)

### Milestone A round 3 (shoreline food risk, food search, unreachable search) on 1.16.1: 2026-10-01 (code uncommitted; dev seed sets, never a gate)

This round targets the three measured failure classes of the re-gate `20260930-141405-a-a-gate2`. The A gate is unchanged. Re-reading the six drowned deaths in that gate's event streams showed four mechanics:
- hunts walked back to remembered "animal spots" that were fish sightings at y 41–57 and swam down among drowned;
- flights from drowned ran along the beach (every flee goal at y 61) or into the sea;
- `defend` engaged drowned while in water: 17 → 2 HP in two trident hits;
- the beach dig-in failed ("no diggable column").

Fixes:
- **aquatic zone** (`src/skills/survival/aquatic.ts`): drowned or guardians within 24 make water unsafe for food work. While the zone is active, `hunt` rejects fish and land targets within 4 blocks of water, and animal spots at the shore. If the bot is at the water it first relocates inland (planned dry, at most 2 per hunt, then `SEARCH_EXHAUSTED … risk=aquatic`). A chase that leads into water is abandoned. Forage skips shoreline prey. Safe water is unchanged: with no aquatic hostile about, fish are still hunted.
- **in water with an aquatic hostile** the threat response is always `flee`, never defend or cover. Flee near water pushes away from nearby water cells too and plans with the dry-land preference (`NavGoal.dry`).
- **observer:** fish are no longer remembered as animal spots.
- **walk-mode moves** (chases) place no scaffolding, and `surface()` digs the block overhead when it makes no progress along its water route. dev12 r03 drowned under a block that a salmon chase had placed at the sea surface.
- **hunt search steps stay on the surface:** dev13 spent about 800 s of daylight in 3 food-timeout runs tunnelling for animals.
- **dig-in shelter** never uses a column with sand or gravel in the shaft or its walls. In dev14 r03 the bot was entombed in a desert pocket for 35 min, because the pathfinder never breaks a block under a falling one.
- **recovery:** `NAV_UNREACHABLE` on a search target (`collect` or `hunt` set `detail.searchTarget`) counts as search exhaustion and never terminates the run. Plain navigation failures still do.
- **telemetry:** a `food_risk` event (rejected, abandoned, inland_relocation), and a report line "Shoreline / drowned": encounters, drowned deaths, food-target decisions. Re-derived for gate2: 17 drowned encounters in 5 runs, 6 drowned deaths.

Tests:
- `tests/unit/shoreline.test.ts`: 9 tests;
- 2 `planDigIn` sand cases;
- real-server fixtures in `tests/scenario/shoreline.scenario.test.ts` (2), which need `spawn-animals=true`, because vanilla removes animals and fish every tick otherwise;
- the existing cod-pond scenario as the safe-water check.

| batch | runs | nether_ready | deaths/run | notes |
|---|---|---|---|---|
| `20261001-005034-a-a-dev12` | 3 | 2/3 | 2.0 | No drowned seen. r02: 4 cave-skeleton deaths with 0 armor, the old class. r03: drowned under its own scaffolding during a salmon chase (fixed). |
| `20261001-032325-a-a-dev13` | 6 | 2/6 | 0.67 | No drowned seen. Losses: 2 food timeouts in animal-poor worlds (badlands, desert), 1 food timeout after a death that lost the meat stock, 1 island spawn (`PRECONDITION_FAILED` table placement 14× in 150 s, the pre-existing terrain gap). Hunt searches tunnelled (fixed). Two "pricked to death" (cactus) deaths came at 0.1–0.8 HP while starving. |
| `20261001-064729-a-a-dev14` | 6 | **5/6** | **0.33** | Only loss: r03 entombed in sand after a night dig-in (fixed after this batch). Met the bar for the gate (≥ 4/6, ≤ 0.5 deaths/run, no drowned cluster). |

Before the gate:
- the unit suite: 178/179. The evaluator's force-kill test is a timing test with about 55 s of fixed grace periods against a 60 s assertion, and it timed out under host load; its code is unchanged since gate2.
- the scenario suite: 38/45. All 5 nav failures ended at one identical bot position after a single "client timed out" disconnect, and the shoreline fixture's server did not become ready.
- During that window, another agent's test runs pushed the host load to 30, and swap was about 8 of 9 GB.

### Milestone A gate on 1.16.1: 2026-10-01/02 (code uncommitted on 56f5769, content hash `b9e970245049dc67`; Node 22.23.3, Java 1.8.0_504, mineflayer 4.39.0)

`20261001-114138-a-a-gate3`: 20 fresh held-out seeds, the unchanged A gate (45 min), `reasoner=none`, `--parallel 1`, under `caffeinate`.

| metric | re-gate 20260930 (baseline) | **gate 20261001** | gate |
|---|---|---|---|
| reached `nether_ready` ≤ 45 min | 16/20 = 80 % (CI 58.4–91.9 %) | **17/20 = 85 %** (Wilson 95 % CI 64.0–94.8 %) | ≥ 70 % ✓ |
| deaths/run | 11 → 0.55 | **6 → 0.30** | ≤ 0.5 ✓ |
| interventions | 0 | 0 | 0 ✓ |
| infra errors | 0/20 | **0/20** | – |
| time to `nether_ready` p50 / p90 | 1410 / 1715 s | 1428 / 1649 s | – |
| outcomes | 16 goal, 3 timeout, 1 unrecoverable | 17 goal, 2 timeout, 1 unrecoverable | – |
| cooked food (10) | 16/20 | 17/20 | – |
| hunt success | 32.9 % | 34.2 % | – |
| drowned encounters / drowned deaths | 17 in 5 runs / 6 | 1 in 1 run (fled to land, then 4 inland relocations) / **0** | – |
| navigation failure rate | 20.2 % | 22.8 % (223 unreachable, 301 timeouts) | – |
| reasoner calls | 0 | 0 | – |

**Deaths:** 6 in 5 runs: creeper 3, zombie 2, cave spider 1. Five of the six came before iron (0 armor, stone sword or hand, t 109–325 s), and none at night. No drowned deaths and no deaths in water.

**Failures (3):**
1. **r04 unrecoverable:** `kit_sticks` failed 14× with `STATE_INCONSISTENT` ("crafting made no progress" 88× on planks). This is a client/server inventory desync in crafting after an early death.
2. **r13 timeout:** the cooked-food stock was not reached. Iron pick at 490 s; food `SEARCH_EXHAUSTED`.
3. **r19 timeout:** "no place to put crafting_table" 8× on the iron tools (iron pick only at 886 s), then food search.

**Gate: milestone A passes** (≥ 70 % ✓, ≤ 0.5 deaths/run ✓, 0 interventions ✓). Milestone B has not started.

### Milestone B development on 1.16.1: 2026-10-01/02 (code uncommitted on 5a0981c; dev seed sets and fixtures, never a gate)

B was built as recorded in architecture §10C. The predicate reading was recorded in milestones.md before any measurement. The gate is unchanged: 20 held-out seeds, ≥ 60 % within 70 min, ≤ 1 death/run, 0 interventions. Every B run uses `reasoner=none`.

**Real-server fixtures** (`tests/scenario/portal.scenario.test.ts`, flat peaceful world, console setup):
- lava cast from a surface pool;
- Nether entry with portal memory, a 12-block excursion and a verified return;
- relighting an extinguished portal;
- an obsidian portal;
- a pool at the bottom of a 6-deep pit, which must be rejected (`NOT_FOUND`, pool marked unusable);
- a lava-lake arrival platform with one causeway to land.

All 6 pass. The final cast takes 106 s for 10 casts and 10 fetches, with no failed fetch.

**Fixture batches (`bkit`: the nether_ready inventory, but the bot must find its own lava pool):**

| batch | runs | result | leading signature → fix |
|---|---|---|---|
| `20261001-213903-b-bkit1` | 2 | 0/2 (both L5 at `nether_portal`) | r01: `NAV_HAZARD … step=reach_site`. The site lay 4 blocks away in a cave, the `near` goal chose controlled excavation, and excavation refused the liquid-adjacent floor. **Fix:** nav mode `path` (pathfinder with digging, never excavation) for site moves; `nether_portal` is `noRelocate`; failed sites blacklist a 2-block radius; a pool is rejected after 3 failed sites. r02: `STATE_INCONSISTENT … step=cast` "no free cell for the cast water". The top corners hold the cast water for the top row but were not cleared, so in rock they stayed stone. **Fix:** top corners are part of the cleared site, and a rock-terrain cast simulation was added to the unit tests. Lava access then ran out of reachable sources. **Fix:** a second tier of shore stands, with no lava beside the feet or head. |
| `20261001-215542-b-bkit2` (same seeds, replay) | 2 | 1/2 | r02: **B in 270 s**, ground truth verified. Four excursion legs ended at 11.x blocks (goal range against a target at exactly 12). **Fix:** targets at 12 + 2. r01: 4 deaths to cave mobs at an open cave pool (zombies, skeletons, creeper), the first while carrying iron gear. **Fix:** site cost now includes *exposure*: horizontal open cells bordering the site. A site cut into rock beats open cave floor. |

A trace of the lava-cast fixture then showed each return move into a dug-down stand failing after 25 s (walk-only). **Fix:** short-move budgets of 8 s walking, then 15 s with the digging pathfinder. The build went from 287 s to 78 s.

**Smoke (fresh dev seeds, full B scenario from spawn), `20261001-225426-b-b-smoke1`: 3/3 reached B** (Wilson 95 % CI 44–100 %). Ground truth verified 3/3: advancement, final dimension and lit built portal. Deaths: 1 (0.33/run). Infra: 0.

| run | nether_ready | portal_built | in_nether | excursion | return_ok (= B) | deaths |
|---|---|---|---|---|---|---|
| r01 | 795 | 1045 | 1050 | 1072 | 1084 | 0 |
| r02 | 774 | 1027 | 1033 | 1059 | 1770 | 1 (piglin, in the Nether) |
| r03 | 1451 | 1663 | 1669 | 1705 | 1717 | 0 |

- **Portal:** lava cast every time. 34 cells cast with 0 failed casts. 34 lava fetches, 11 failed fetch attempts (6 "no ray from here", 4 no block change, 1 drift). The nether_ready → portal leg p50 was 249 s, mostly travel to a deep site.
- **r02 death:** a gold-sword piglin took the bot from 20 to 0 HP in three hits while `defend` rated it 0.47 against capacity 4.8. **Fixes:**
  - A bounded `b_gold_armor` requirement: obtain a golden helmet before the portal (architecture §14.4). Golden armor scores +0.5, so a golden helmet replaces the iron one at equal points.
  - Piglin and hoglin threat weight 1.5/2.5 → 4.0.
  - A piglin holding a crossbow counts as ranged.
- **Other fixes after the smoke:**
  - A distant site is approached with the navigator's own strategy (controlled excavation for deep targets) before the short work-area moves.
  - The bot centres in a stand cell before any bucket use, since rays are planned from the cell centre.

**Dev batch 1 (6 fresh dev seeds, full B scenario), `20261002-001748-b-b-dev1`: 2/6 reached B.** Two runs were lost to host sleep: lid closed on battery, `pmset` log `Using Batt`.

| run | outcome | B s | deaths | diagnosis |
|---|---|---|---|---|
| r01 | timeout (A phase) | – | 3 | 2 cave-skeleton deaths before iron, then food searches out to x ≈ 2400 and a drowned death. A behaviour; not changed in B. |
| r02 | infra_error | – | 0 | host suspended 741 s |
| r03 | infra_error | – | 0 | host suspended 202 s |
| r04 | goal_reached | 1784 | 0 | golden helmet in about 2 min (5 gold ore), then portal, trip and return |
| r05 | unrecoverable | – | 2 | Three causes: (1) A large magma cube killed the bot in the Nether: 6 damage a hit, while `defend` rated it 0.41 against capacity 4.8. (2) The excursion's walking legs chose controlled excavation, because the Nether's bedrock roof makes every target "covered", and failed to find a start. (3) After a second death, both pickaxes broke on an excavated approach to the portal. At night the wooden pickaxe was deferred as surface work, and `enter_nether` failed 14× for lack of a pickaxe. |
| r06 | goal_reached | 1339 | 0 | – |

**Fixes:**
- Nether brutes (piglin, hoglin, zoglin, magma cube) get weight 5, so the bot flees them unless it is very strong.
- Excursion legs use the pathfinder (`path`) with the nether profile; the tunnel stays the fallback.
- The portal approach falls back to `path`, and a missing pickaxe there is `MISSING_RESOURCE`.
- `nether_portal` and `enter_nether` require a pickaxe, so at night the bot shelters and crafts one at dawn.

The fixtures still pass 6/6. The two infra seeds and r05's seed are replayed as `b-dev2`, using dev seeds only.

**Dev replay (`20261002-035155-b-b-dev2`, the dev1 seeds r02, r03 and r05, with the dev1 fixes): 2/3 reached B.**

| run (seed) | outcome | B s | deaths | diagnosis → fix |
|---|---|---|---|---|
| r01 (dev1 r02) | goal_reached | 2005 | 1 (A phase, lava) | An A-phase death respawned in the same dimension, which left the observer's "died since the last transition" flag set, so the first Nether entry was recorded as cause `death`. The controller's invariant caught it (`OBJECTIVE_NOT_SATISFIED` on `return_overworld`) and the bot made a second trip, costing about 20 s. **Fix:** a same-dimension respawn clears the flag. |
| r02 (dev1 r03) | goal_reached | 2096 | 0 | Four pools were rejected at once from 50–100 blocks away ("no safe stand"), and a deep-mine → surface-site approach got stuck for 250 s. **Fixes:** pool geometry is judged only within 16 blocks (approach first); a covered bot climbs out by its dug staircase (`toSurface`) before travelling to a site, pool or portal well above it. |
| r03 (dev1 r05) | timeout | – | 2 (lava, same site) | The site was at the lava level of a huge sheet. The capped flood fill (600 cells) missed the lava near the site, and the walk back from the pool stepped into lava twice. **Fixes:** flood cap 4000; sites with lava within 2 blocks of the floor, work area or frame are rejected; portal moves use `overworld_cautious` (lava step cost, no parkour, drops ≤ 3; plain `overworld` unchanged for A); a site or pool where the bot died is abandoned. |

**Dev evidence across the six dev1 seeds, with each seed's latest run:**
- **Reached B: 4/6** (dev1 r04 and r06; replay r01 and r02).
- **Deaths:** 6 in 6 runs = 1.0/run. 4 were A-phase (cave skeletons, drowned, lava swim) and 2 were B-phase lava deaths at one site (fixed).
- **Infra:** 2 host-sleep runs, both replayed.
- **Portal:** no unresolved portal-construction failure remains. Every built portal was a lava cast, and the casts themselves never failed.

This meets the brief's bar of ≥ 4/6. The full test suite runs next, then the formal gate.

### Milestone B gate on 1.16.1: 2026-10-02/03 (code uncommitted on 5a0981c, content hash `1120019679d44041`; Node 22.23.3, Java 1.8.0_504, mineflayer 4.39.0)

The B gate: 20 held-out seeds, ≥ 60 % within 70 min, ≤ 1 death/run, 0 interventions. `reasoner=none`, `--parallel 1`, under `caffeinate`.

**Execution note.** The host crashed during run 13 of `20261002-063440-b-b-gate`. The evaluator generated its seeds in memory, so seeds 14–20 were lost. Run 13 is scored as **infra_error**, a failure in the denominator. Its `summary.json` was reconstructed from its events, including its 2 deaths. The gate was completed with **`20261002-155811-b-b-gate-part2`**: 7 fresh held-out seeds on the same code (content hash re-verified before launch). Both parts are aggregated below; the combined output is in `runs/20261002-155811-b-b-gate-part2/combined-gate.txt`. No held-out run was examined before all 20 had finished.

| metric | value | gate |
|---|---|---|
| reached B (`in_nether` via built portal + `portal_nether` + `return_ok`) ≤ 70 min | **15/20 = 75 %** (Wilson 95 % CI 53.1–88.8 %) | ≥ 60 % ✓ |
| deaths/run | **22 → 1.10** | ≤ 1 ✗ |
| interventions | 0 | 0 ✓ |
| infra errors | 1/20 (host crash) = 5 % | – |
| ground truth on B claims | 15/15 verified: advancement, final dimension, lit built portal | – |
| time to B p50 / p90 | 1780 / 2823 s | – |
| outcomes | 15 goal, 2 timeout, 1 death_limit, 1 unrecoverable, 1 infra | – |
| reasoner calls | 0 | – |
| navigation | 85.7 % ok of 3491 calls (overworld 76 %, overworld_cautious 89 %, nether 89 %); 176 unreachable, 259 timeouts | – |

**B legs** (n = 15): nether_ready → portal p50 404 / p90 634 s (this includes the golden helmet); portal → Nether 5.6 / 6.1 s; Nether → excursion 14.3 / 18.1 s; excursion → return 14.6 / 30.1 s; nether_ready → return_ok 451 / 666 s.
- Of the 17 runs that reached `nether_ready`, 16 built a portal (r13 then crashed), and 15 completed the round trip.
- **Portal strategy:** lava cast every time, 16 of 16 built. 178 cells cast with **0 failed casts**. 178 lava fetches, 6 failed attempts. Site failures: 8 (aim ×2, pool access ×5, water cell ×1), all recovered.
- **Lava search:** `lava_pool_known` in 19/20 runs at p50 6 s, since pools are remembered from loaded chunks while mining. 10 pools were rejected for "no safe stand", always recovered by another pool.
- **Golden helmet:** the objective ran in every B run, and 17 runs hold one.
- **Nether:** 15 controlled excursions, all on foot. 0 arrivals without a safe cell. 1 Nether death (r13, "tried to swim in lava to escape Piglin"). 0 retreats were needed.

**Deaths by phase:** 17 before `nether_ready` and 5 after (r02 ×3 near its site and after losing its gear; r13 ×2).
- Killers: zombie 10, drowned 4, skeleton 3, creeper 1, spider 1, guardian 1, zombie villager 1, lava 1.
- 15 of the 22 deaths were at 0 armor, 11 while fleeing, 11 bare-handed. Deaths cascade in struggling runs: r09 had 5, r02, r04 and part2-r01 had 2–3 each.

**Top failure signatures:**
1. **Early-game death cascades** (r04, r09, part2-r01; r02 after its first death). A first death costs the stone tools, and later deaths follow while bare-handed during flee or cover, at the shore (drowned, guardian) and at night. This is A-phase survival behaviour, and the 70-minute B limit exposes more of it than A's 45 minutes did.
2. **`STALLED|obtain|wooden_pickaxe|…|step=collect`**: 13 occurrences in 2 runs, terminal in part2-r01. Re-collecting wood after deaths stalls.
3. **B-phase:**
   - `INFRA|buildNetherPortal`: 20 non-terminal occurrences in 7 runs. The server rejected mineflayer `equip` clicks while buckets were being swapped, which costs time.
   - Pool rejections from "no safe stand".
   - r02: deaths near the portal site at an open area cascaded into a timeout.

**Gate: milestone B FAILS on deaths/run (1.10 > 1.0).** The reach rate and every portal and Nether metric pass. The leading cause is diagnosed (early-game death cascades), so C should not start: the next round should fix the death classes and re-gate B on a new held-out set.

### Milestone B round 2 (death cascades, wood stalls, inventory rejections) on 1.16.1: 2026-10-02/03 (code uncommitted on 9190887; dev seed sets and fixtures, never a gate)

Brief: pass the unchanged B gate by fixing only the measured causes of gate 20261002. No C work, `reasoner=none`. Design in architecture §10D.

**Diagnosis of the B gate (bundles of r02, r04, r06, r07, r09, r11, r13, part2-r01):**
- **Wood stalls (13 occurrences, 2 runs) were Mining Fatigue.** Both runs met an elder guardian, and state samples show `MiningFatigue` from then on: 293 and 725 samples, across 2–3 deaths. Mineflayer keeps entity effects across a respawn. Each bare-handed log dig then waited about 1000 s for the client-predicted break time, the 60 s stall watchdog fired, and the retry went back to the same log. These two runs also account for 7 of the 22 deaths: the bot stayed bare-handed, and its night dig-in found "no diggable column".
- **Item recovery walked into the killers.** 9 recovery walks: 8 were cancelled by threats, and 1 recovered a single item. 4 of the 5 repeat deaths within 5 minutes followed one (r04, r06, r07, r11). Example: r11 walked 131 blocks bare-handed back into the skeleton cave and died 58 s after respawning.
- **Weak flight and rest.** r11 rested at 4 HP with the zombie at 9.7 blocks. r02 fled at 5.8 HP; its `eat` then failed on a rejected click, and it died at 0.4 HP. After A, a death left the bot without a sword for the rest of B work (r02 ×2, r13): `stone_sword` was not kept after nether_ready.
- **Inventory rejections (26: portal 20, eat 2, smelt 2, fillBucket 2).** The rejections came during portal-site digging, with drops flowing in, while equips moved stacks into a full hotbar. The client's cursor model was stale: Mineflayer ignores 1.16.1's cursor `set_slot` (window −1). On rejection Mineflayer throws, and the skills reported that as INFRA.
- **Not addressed (residual):** a water trap at a frozen-ocean iceberg (r04: the bot's x/z unchanged for about 500 s while every water exit failed). No server-side cause was found.

**Fixes, tests and fixtures:**
- Unit tests: `tests/unit/b-round2.test.ts`, 13 tests: effects reset, cursor sync, bounded dig, stalled-target blacklist, `safeEquip` retry, serialization and the limit, weak-state threat, rest and hold, respawn wait, dry search. Recovery and milestone-B tests were updated for the new rules. 230/230 unit tests pass.
- Real-server fixtures: `tests/scenario/b-round2.scenario.test.ts`, 7 tests, all passing:
  - portal-site swaps: Mineflayer's plain equip was rejected in 3 of 5 fixture runs (4, 6 and 5 rejections; the race is probabilistic and only recorded). The new path never failed: 0 failures, up to 4 retries absorbed;
  - concurrent swaps;
  - a stale container window: a plain equip gets "Server didn't respond … window with id 1", while the new equip resets the windows and lands;
  - fatigue before a death is cleared after the respawn, and 2 logs are collected in under 30 s;
  - real fatigue fails fast (`effect=mining_fatigue`, under 20 s);
  - an unreachable log is blacklisted and a reachable one collected;
  - bare-handed against a zombie 7 blocks away: a sealed pocket, no damage, and a hold.
- Existing fixtures: the survival crowd-flee test now accepts "clear, or sealed in after the flight". Full scenario suite: 57/58. The night-shelter cap check failed once and passed 2/2 on re-run; that code was not changed.

**Dev batches (fresh dev seeds, full B scenario):**

| batch | runs | B | deaths/run | notes → fix |
|---|---|---|---|---|
| `20261002-211157-b-b2-dev1` | 3 | 3/3 | 0 | 1 smelt furnace-window rejection (STATE_INCONSISTENT, recovered) |
| `20261002-225340-b-b2-dev2` | 6 | 3/6 | 1.83 (11) | **Fixes:** (1) a 15 s blind window after every death: `once('spawn')` started after the automatic respawn (r06: shot from 20 to 4 HP at the respawn point) → `respawnWaiter`; (2) a weak bot dug out of its pocket next to a skeleton → weak hold chain; (3) hunt and wood search steps led back into drowned water (r05) → dry search; (4) the shelter night window differed from the schedule's, so shelter was reissued several times a second. Also seen, not fixed: an open-ocean night stint ending L5 (r03, "no place to put crafting_table" ×14), 1 Nether lava death. |
| `20261003-041048-b-b2-dev3` | 6 | 3/6 | 0.83 (5) | 0 repeat deaths, 0 rejection failures (1 absorbed). **r05:** an unanswered crafting-table click left a window the server had closed; every later equip timed out for 41 min (L5 `stone_pickaxe` ×14) → `resetWindows`. r03: a ghast killed it in the Nether while resting, then timeout. r06: food search in an animal-poor world (food_10 at 3854 s), timeout. |
| `20261003-092337-b-b2-dev3-r05replay` | 1 (dev3 r05 seed) | 1/1 | 1 | B at 2523 s; the wedge did not recur |

Dev evidence, each dev3 seed's latest run: **4/6 reached B, 0.83 deaths/run, no death-cascade cluster.** This meets the brief's bar for the formal gate.

### Milestone B re-gate on 1.16.1: 2026-10-03/04 (code uncommitted on 9190887, content hash `f9406fd15c1c6d7f`; Node 22.23.3, Java 1.8.0_504, mineflayer 4.39.0)

`20261003-103119-b-b2-gate`: 20 new held-out seeds; the B gate unchanged (≥ 60 % within 70 min, ≤ 1 death/run, 0 interventions); `reasoner=none`, `--parallel 1`, under `caffeinate`, on AC power with sleep disabled. All 20 seeds were written to `private/seeds.json` before the first run. The content hash was re-verified after the batch. No held-out run was examined before all 20 had finished.

| metric | value | gate | previous gate (20261002) |
|---|---|---|---|
| reached B ≤ 70 min | **9/20 = 45 %** (Wilson 95 % CI 25.8–65.8 %) | ≥ 60 % ✗ | 15/20 = 75 % |
| deaths/run | **23 → 1.15** | ≤ 1 ✗ | 22 → 1.10 |
| interventions | 0 | 0 ✓ | 0 |
| infra errors | 0 | – | 1 (host crash) |
| ground truth on B claims | 9/9 verified | – | 15/15 |
| outcomes | 9 goal, 9 timeout, 2 unrecoverable | – | 15 goal, 2 timeout, 1 death_limit, 1 unrecoverable, 1 infra |

**Round-2 targets (measured on this set):**

| | this gate | previous gate |
|---|---|---|
| deaths before nether_ready | 15 | 17 |
| repeat deaths < 5 min after the previous one | **0** | 6 (in 6 runs) |
| wood-search stalls (log) | **4** | 13 |
| inventory-click skill failures | 1 (a furnace-window click in `smelt`, not a swap) | 26 (20 in portal builds) |
| rejected equips retried and absorbed | 2 | – |
| stale effects cleared on respawn | 0 (no elder guardian met) | – |

**B legs:**
- 14/20 reached nether_ready; 11 built a portal, all by lava cast. 134 cells cast with 0 failed casts; 136 lava fetches with 15 failed attempts.
- 10 entered the Nether and 9 returned.
- Nether deaths: 1 (r07: a ghast fireball while resting at 5 HP during `return_overworld`, after an earlier death had cost its iron gear; r07 still reached B).
- Portal entry failures: r04 and r10, `STATE_INCONSISTENT usePortal step=teleport` ×14. In r04, a skeleton right after the build sent the armed bot into a cover dig-in beside the frame, and the walk-only portal approach could not leave the pocket (NAV_UNREACHABLE, reported as "stood in the portal").
- B-kit timeouts after nether_ready: r08 (`b_bucket` 662 s, `b_gold_armor` 616 s) and r19 (`b_gold_armor` 1534 s).

**Where the failed runs' time went.** 9 timeouts and 2 L5 terminations. 6 runs never reached nether_ready (r05, r09, r12, r13, r14, r15), and r16 reached it at 4054 s. Their largest objectives were surface resource searches:
- **logs:** r12 2012 s and r15 2986 s, 80 search steps each and > 1600–2100 blocks from spawn at sea level without a log; r14 1207 s;
- **gravel for flint:** r05 1351 s (terminated: `flint_and_steel` ×14, gravel on lake beds reachable only from water), r09 910 s, r13 1114 s, r16 1004 s. 18 flint collect stalls and 21 unreachable-gravel failures, against 0 and 0 in the previous gate; `flint_and_steel` took 518 s/run against 332/215 s. No code changed in this round touches gravel targeting;
- **food hunts:** 56 `SEARCH_EXHAUSTED food` in 6 runs.

Scheduled night shelter rose to 477 s/run (previous gate 228/174). Most of it was in runs still without iron gear at night; the shelter window change (dusk 12 500 → 12 000) adds about 25 s per night.

**Deaths (23):**
- killers: zombie 5, skeleton 4, lava 3, drowning 3, creeper 2, drowned 2, other 2, ghast 1, polar bear 1;
- 11 during flee;
- weapon at death: iron sword 13, stone sword 8, hand 2.

Bare-handed deaths fell from 11 to 2, and there were 0 cascades. The remaining deaths are spread over 12 runs.

**Gate: milestone B FAILS** on the reach rate (45 % < 60 %) and on deaths/run (1.15 > 1.0). The death-cascade class this round targeted is gone: 0 repeat deaths within 5 minutes and 2 bare-handed deaths. **Single dominant remaining cause: A-phase surface resource acquisition on poor terrain** (logs in treeless or water-dominated areas, gravel for flint on lake and river beds, food animals). It held 6 of 11 failed runs short of nether_ready within 70 min, and night sheltering in those runs compounded it. C must not start.

### Milestone B round 3 (resource search on poor terrain) on 1.16.1: 2026-10-04 (code uncommitted on 9190887; dev seed sets and fixtures, never a gate)

Brief: pass the unchanged B gate by fixing the dominant remaining cause, slow A-phase resource gathering on treeless and water-heavy starts. No C, no B redesign, `reasoner=none`. Design in architecture §10E.

**Diagnosis of re-gate `20261003-103119-b-b2-gate`** (all 20 bundles; the batch report's new resource section, run retroactively):

| | 20 runs | notes |
|---|---|---|
| night shelter | 16 119 s (p50 746, p90 1 415 s/run) | the first night of 12 runs sheltered with only `food` deferred; failed runs 900–2 300 s |
| food (hunt) | 10 582 s, 28 700 blocks | animals remembered only within 32 blocks, though the server sends them to 144; 122 spot visits; 56 `SEARCH_EXHAUSTED food` |
| raw meat eaten or lost uncooked | 105 items | 30–40 % of the meat in r10, r11, r13, r16, r19: hungry during long hunts with only raw meat |
| wood (collect log) | 6 211 s, 13 917 blocks | r12 and r15 (ocean spawns) swam outward 1 600–2 100 blocks; after a respawn at the same spawn, r15 re-searched the same corridor and r12 re-searched although it had cut logs 900 blocks away |
| gravel for flint | 3 589 s | r05: lake-bed gravel dug from the water, the bot stuck in a water hole, run terminated (`flint_and_steel` ×14); r09: 40 blocks of one unreachable bank, 5 per attempt |

**Fixes:** architecture §10E: the surface relocator with a terrain survey and searched regions; tree spots and wide log scans; flint knapped from mined gravel; animal memory to 144 blocks; cook before eating raw; night fillers (cooking, golden helmet before nether_ready); dusk 12 500; the report section. Crops and hay: not built (1 pickup in ~46 B-phase runs, and bread does not count as cooked food). Boats: not built (a treeless start has no wood for a boat).

**Tests:**
- Unit: `tests/unit/b-round3.test.ts`, 19 tests: heading survey (coast, trees, novelty, searched regions after a respawn, no circling, failed headings), region refresh and expiry, log clustering, tree and animal spots, `cookPlan` cases, night fillers (order, day, after nether_ready, invariant), flint plan. Two updated: flint is now knapped from mined gravel; forage reaches 24 blocks while the stock is short. 249/249 pass.
- Fixtures: `tests/scenario/b-round3.scenario.test.ts`, 8/8 on the real server:
  - ocean start: one relocation at 90°, toward the coast, then the loaded log 94 blocks off;
  - remembered tree 360 blocks away walked to directly, with no relocation;
  - pond gravel 49/49 untouched, flint from a dry bank;
  - carried gravel knapped;
  - unreachable bank: 27/27 blacklisted, then a reachable block mined;
  - a cow 100 blocks off remembered and hunted;
  - a hungry bot cooks 4 of 6 porkchops and carries the furnace on;
  - night order `cook_raw` → `pre_gold_armor` → shelter.
- Related existing fixtures: acquisition, shoreline, survival and b-round2, 28/29. The cod fixture failed once after the cow test, a known flake; it passes on re-run.

**Smoke 1 (`20261004-112726-b-b3-smoke1`, 3 fresh dev seeds), stopped by hand during r01 at about 3 200 s; r02 and r03 never ran.** The batch was stopped to fix what r01 showed rather than run two more seeds with known bugs.
- Worked:
  - Night filler `pre_gold_armor` mined the golden helmet at night (762–848 s).
  - Flint and steel took 38 s, at night.
  - After each death the bot walked straight to a remembered tree (194 and 198 blocks away).
  - An ocean-ish spawn (67 % water) found logs 116 blocks off after one relocation.
- Failed:
  - At t = 1 s, before chunks had loaded, the bot relocated and marked its spawn area searched for logs.
  - The night was spent mining under a mountain. At dawn the hunt's `toSurface` failed (goal y 64, surface at y 79), and the hunt walked toward remembered animal spots through caves into lava (y 10). The bot escaped at 8.9 HP, burned to death while resting with a water bucket, and later also died to a skeleton.
- Fixes: architecture §10E, "After smoke 1".
- Tests:
  - Unit: 251/251, adding `extinguish` selection.
  - Round-3 fixtures: 9/9, adding a real on-fire bot, put out with the water bucket scooped back.

**Smoke 2 (`20261004-123116-b-b3-smoke2`, 3 fresh dev seeds), stopped by hand during r01 at about 1 800 s.**
- r01 reached nether_ready at **820 s**, against a gate p50 of 1 436 s. The day-1 hunt walked to remembered spots, `cook` fired once, and the night filler `cook_raw` cooked the stock at night, so food_10 and nether_ready came at 820 s.
- It then died in lava during the portal build (1 054 s), and **the new `extinguish` reflex caused that death**. `escapeLava` ended at the lava's edge. `extinguish` (also P0, so nothing preempted it) then held the bot still for 1.9 s while it took lava damage (3.7 HP every half second).
- Fix: `extinguish` fires only on the ground with no lava within 2.5 blocks, and stops if lava comes that close. Unit test added (252/252); the fire fixture passes.

**Smoke 3 (`20261004-130354-b-b3-smoke3`, 3 fresh dev seeds, code after the smoke-2 fixes): 3/3 reached B, 0 deaths, ground truth ✓ on all 3.**

| run | nether_ready s | B s | deaths | notes |
|---|---|---|---|---|
| r01 | 842 | 1 435 | 0 | food_10 at 705 s, in day 1 |
| r02 | 1 431 | 2 757 | 0 | night fillers `cook_raw` and `pre_gold_armor`. Portal phase (B behaviour, unchanged): at 8 of 10 cast cells the pool was judged "unusable: no safe stand reaches an open source". The bot moved to a site 100 blocks away and wore out its pickaxes tunnelling, then re-crafted and built. |
| r03 | 1 438 | 1 931 | 0 | night filler `pre_gold_armor`; food in day 2 from 6 remembered-spot visits |

**Dev batch (`20261004-144730-b-b3-dev1`, 6 fresh dev seeds, same code as smoke 3): 5/6 reached B (Wilson 95 % CI 43.6–97 %), 0 deaths, nether_ready 6/6 (p50 1 535 s), ground truth ✓ on every run.**

| run | nether_ready s | B s | deaths | notes |
|---|---|---|---|---|
| r01 | 2 576 | 2 837 | 0 | food took 757 s and 2 158 blocks: 23 remembered-spot visits in sparse terrain |
| r02 | 798 | 1 344 | 0 | – |
| r03 | 1 709 | 2 126 | 0 | 3 animal relocations |
| r04 | 1 553 | 2 015 | 0 | – |
| r05 | 1 517 | – | 0 | **L5: `nether_excursion` failed 14× (NAV_HAZARD).** No safe excursion target at the arrival portal. The tunnel fallback picked the line through the arrival portal's obsidian frame ("needs_pickaxe" with an iron pickaxe) and retried only that line over three portal trips. Fixed: see below. |
| r06 | 796 | 2 681 | 0 | portal phase about 1 700 s: 6 lava-cast sites. Each was abandoned at 2–8 cells when the pool had no reachable open source. B behaviour, unchanged this round. |

Resource section, per run, against re-gate 20261003:

| | dev1 | re-gate 20261003 |
|---|---|---|
| wood p50 | 74 s | 140 s |
| gravel p50 | 20 s | 73 s |
| food p50 | 355 s | 446 s |
| raw meat lost uncooked | 2 in 6 runs | 105 in 20 |
| night shelter p50 | 228 s | 746 s |

- Night fillers ran 8×.
- 48 remembered animal spots were visited.

**Fix after dev1 (B excursion fallback, a bug fix and not a redesign).** `tunnelTargets` (`nether-plan.ts`) now does three things:
- rejects tunnel lines that cross a block slower than 3 s to dig with the carried tools, or a portal block;
- returns every clear cardinal line;
- `netherExcursion` tries each line in turn.

A unit test was added: a portal frame on the east line yields the 3 other lines.

Bar for the formal gate (≥ 4/6, ≤ 1 death/run, no recurring long resource-search timeout): **met**.

### Milestone B re-gate (round 3) on 1.16.1: 2026-10-04/05 (code uncommitted on 9190887, content hash `6811964499b8195c`; Node 22.23.3, Java 1.8.0_504, mineflayer 4.39.0)

`20261004-191217-b-b3-gate`: 20 new held-out seeds; the B gate unchanged (≥ 60 % within 70 min, ≤ 1 death/run, 0 interventions); `reasoner=none`, `--parallel 1`, under `caffeinate`.
- All 20 seeds were written to `private/seeds.json` before the first run.
- Content hash: `find src config package.json package-lock.json -type f | sort | xargs cat | sha256`, first 16. Verified before launch and after the batch.
- The host ran on battery for parts of the night (lowest 10 %) but never slept or shut down.
- No held-out run was examined before all 20 had finished.

| metric | value | gate | re-gate 20261003 |
|---|---|---|---|
| reached B ≤ 70 min | **15/20 = 75 %** (Wilson 95 % CI 53.1–88.8 %) | ≥ 60 % ✓ | 9/20 = 45 % |
| deaths/run | **24 → 1.20** | ≤ 1 ✗ | 23 → 1.15 |
| interventions | 0 | 0 ✓ | 0 |
| infra errors | 1 (r10: uncaught Mineflayer assertion) | – | 0 |
| ground truth on B claims | 15/15 verified | – | 9/9 |
| outcomes | 15 goal, 2 death_limit, 2 timeout, 1 infra | – | 9 goal, 9 timeout, 2 unrecoverable |
| nether_ready | 16/20, p50 1 386 / p90 2 338 s | – | 14/20, p50 1 436 / p90 3 101 s |
| time to B p50 / p90 | 1 753 / 2 840 s | – | 2 056 / 3 468 s |

**Resource search** (report section; re-gate 20261003 values from the same code run retroactively):

| | this gate | re-gate 20261003 |
|---|---|---|
| wood (collect log) time/run p50 / p90, total | 88 / 246 s; 2 706 s, 2 972 blocks | 140 / 889 s; 6 211 s, 13 917 blocks |
| gravel time/run p50 / p90, total | 42 / 156 s; 1 616 s | 73 / 452 s; 3 589 s |
| food (hunt) time/run p50 / p90, total | 260 / 438 s; 5 611 s, 14 926 blocks | 446 / 1 008 s; 10 582 s, 28 700 blocks |
| search relocations / exhausted regions marked | animals 24, relocate 4 / animals 24 | – |
| remembered-spot visits | animal 86, loaded logs 24, tree spot 2 | animal 122 |
| raw food eaten or lost uncooked | 29; `cook` interrupts 18 | 105 |
| night sheltering p50 / p90 / total | 227 / 586 s; 4 713 s | 746 / 1 415 s; 16 119 s |
| night fillers | `cook_raw` ×15, `pre_gold_armor` ×15 | – |
| completion: food_10 / flint and steel | 16/20 (p50 1 349 s) / 18/20 (p50 757 s) | 14/20 (p50 1 436 s) / 16/20 (p50 770 s) |

**Portal and Nether.**
- 16 runs reached nether_ready, 15 built a portal (lava cast ×15), and 15/15 entered the Nether, made the excursion (walk ×15) and returned.
- 183 cells cast with 0 failed casts; 12 failed lava fetches.
- 0 Nether deaths; 0 arrivals without a safe cell.
- Site failures, all recovered: pool "no safe stand" ×5, aim ×4, fill ×4.

**Deaths (24 in 9 runs):**
- killers: drowned 8, zombie 5, skeleton 3, cave spider 2, lava 2, creeper 1, drowning 1, fall 1, other (burned) 1;
- 23 before nether_ready; 15 at 0 armor; 9 bare-handed;
- 6 repeat deaths < 5 min after the previous one, in 3 runs (re-gate 20261003: 0).

| run | deaths | diagnosis |
|---|---|---|
| r08 | 5 (death_limit, 173 s) | all drowned, bare-handed, near an ocean spawn. **The new wide log scan (`loaded_logs`, ≤ 160 blocks) chose a log at y 50, 74 blocks off, on the sea floor: a shipwreck timber, not a tree.** Each walk swam through drowned water. A walk cancelled by `flee` did not blacklist the target, so it was chosen again after every flee and respawn. |
| r02 | 5 (death_limit) | the same pattern: a `loaded_logs` / `tree_spot` target at y 36–37 in the ocean was chosen 9×, with 3 drowned deaths; then zombies ×2 at 0 armor |
| r06 | 3 (timeout) | creeper (food). Drowning during night filler `pre_gold_armor`. Skeleton while re-gearing. 23 animal relocations; gravel and gold mining NAV_HAZARD ×13. |
| r15 | 3 (B at 3 726 s) | fall; lava ×2, one during `pre_gold_armor` at night |
| r04 | 2 (timeout) | cave spider ×2: one during `pre_gold_armor` at night, one during the portal build; nether_ready at 1 991 s, portal not finished |
| r10 | 2 (infra) | skeleton, zombie; then the bot process crashed: Mineflayer `Window.acceptClick` "invalid operation", an uncaught assertion in the transaction-confirm handler |
| r17 | 2 | zombie during `pre_gold_armor` at night; skeleton |
| r01, r20 | 1 each | burning (on fire while resting at night at 900 s); zombie |

- 4 deaths came during the night filler `pre_gold_armor`, mining at night (r04, r06, r15, r17). Before this round those bots sheltered.
- 8 deaths came from far-log targets on the sea floor (r02, r08).

**Gate: milestone B FAILS on deaths/run (1.20 > 1.0).** The reach rate passes (75 % against 60 %), and the A-phase resource causes this round targeted are largely gone:
- nether_ready 16/20;
- wood, gravel and food time all well below the previous gate;
- night shelter down 71 %;
- no long resource-search timeout.

**Single dominant remaining cause: early drowned death cascades at ocean spawns, caused by this round's wide log targeting.** Log blocks on the sea floor (shipwrecks), not trees, were accepted as wood targets and re-chosen after every flee and respawn. This produced 8 of the 24 deaths and both death_limit runs. Without them the gate would have had 16 deaths (0.80/run). Proposed fix, not built: accept as wood only logs with leaves within a few blocks above them and no water around them; blacklist a wood target whose walk a threat interrupted. Secondary, in order: deaths during the night filler `pre_gold_armor` (4); the Mineflayer `acceptClick` crash (1 infra run). **C must not start.**

### Wood-target hotfix (after round-3 gate 20261004): 2026-10-05 (code uncommitted on c9fd72e, content hash `9af4b66ae04572cb`)

Scope: the underwater-log regression only (round-3 gate r02/r08: 8 drowned deaths, both death_limit runs). Nothing else changed.

**Fix.**
- `src/observer/trees.ts` `treeVerdict`: a log counts as wood only if its trunk (straight, or one diagonal step per level for acacia) stands on soil, air (foot already dug) or leaves; the log has < 2 water neighbours; ≤ 4 of the 8 cells around the trunk one above its foot are water; no water above the top; ≥ 3 non-persistent leaves within 3 blocks of the top. Applied to `collect` candidates (near and the 160-block wide scan) and to the observer's tree spots.
- Danger zones: a wood walk or dig cancelled by `flee`, `surface` or death, or with an aquatic hostile within 24 or the head under water, blacklists a 24-block zone around the target for 1800 s (survives death); zone logs and tree spots are skipped. `SkillRunner.cancel(by)` carries the preempting interrupt id. `collect(log)` moves inland (≤ 2 per call) when aquatic hostiles are about and the bot is at the water.

**Tests.** Unit: `tests/unit/wood-targets.test.ts` (8) plus the tree/search/runner/shoreline files, 56/56. Fixtures `tests/scenario/wood-targets.scenario.test.ts` 3/3: a sea-floor wreck and a beached wreck (the old filter accepted 20/20 of their logs) are rejected and the bot walks 91 blocks to the real tree; saplings of all seven 1.16.1 tree forms grown naturally, 124–174 logs, 0 rejected; a flee from a drowned on the way to a tree records the zone and the next collect goes to the other tree.

| run | gate 20261004 | hotfix |
|---|---|---|
| replay gate r02 (`20261005-103623-b-wood-hotfix-replay-r01`) | death_limit, 5 deaths (sea-floor log chosen 9×) | **B 2 231 s, 0 deaths**; wooden pickaxe 91 s (was 369 s); no sea-floor target |
| replay gate r08 (`…-replay-r02`) | death_limit at 173 s, 5 drowned | **B 4 162 s, 1 death** (skeleton in the Nether, during return); wood 538 s: ocean island, a 25× flee chain from one drowned swam ~800 blocks (survival behaviour, unchanged) |
| fresh dev `20261005-122339-b-wood-hotfix-smoke` | – | 2/3 B (1 367 s, 1 949 s, 0 deaths); r01 timeout, 3 deaths (creeper ×2, zombie bare-handed while sheltering): food hunts exhausted, flint at 3 090 s; wood zones fired 2×, no wood search failure |

Replay + smoke: 4/5 B, 4 deaths (0.80/run), 0 drowned deaths, 0 sea-floor wood targets. Residuals (not wood): flee chains in open water on island spawns; creeper deaths after gear loss.

### B gate procedure: early-fail rules (2026-10-05, evaluator only; bot code unchanged from ed01f93)

Scope: reduce wall-clock time lost on runs that cannot recover, without changing scoring (§1, early-fail rules). The B criteria are unchanged. Early-stopped runs stay in the denominator as failures and keep their deaths.

**Thresholds, fixed before the gate:** `objective_exhausted` at 2 full exhaustions with no alternate objective; `controller_stall` at 15 min without progress, plus ≥ 3 cycles of the active requirement, plus no discovery; `impossible_remainder` off (its only defensible bound is 12.3 s).

**Validation (replay of every finished historical B run with an event log, 106 runs: 69 successes, 37 failures).**
- Unit tests: `tests/unit/early-stop.test.ts` 25/25. Each rule is tested positive and negative (repeat, alternate, progress reset, upkeep, wrong suspend kind; 15-min boundary, cycle count, window, discovery kinds, progress kinds, active requirement; the bound and its off switch; rule-1 labels; the live tail). One live evaluator run (fake bot) ends `early_fail` with its death and `early_stop.json`. Replays of trimmed historical event streams (`tests/unit/fixtures/early-stop/`): 3 failed runs stop earlier, and 3 slow or closest-call successes are not stopped. Evaluator and report tests 13/13. The full suite was not rerun.
- **Failed runs stopped earlier (replay):**

| run | natural end | rule | stop at | saved | stage |
|---|---|---|---|---|---|
| b2-gate r09 | timeout 4 200 s | controller_stall | 1 600 s | 43 min | A-phase, `food` hunt (11 cycles, no progress since bucket 662 s) |
| b2-gate r10 | L5 3 794 s | objective_exhausted | 1 461 s | 39 min | A-phase, `food` exhausted 2× with nothing else to do |
| b2-gate r05 | L5 3 121 s | controller_stall | 1 544 s | 26 min | A-phase, `food` (4 cycles) |
| b2-dev3 r05 | L5 3 732 s | controller_stall | 2 205 s | 25 min | B-phase, `stone_pickaxe` STATE_INCONSISTENT (equip wedge) |
| b-gate-part2 r01 | L5 3 875 s | controller_stall | 2 567 s | 22 min | A-phase, `wooden_pickaxe` STALLED (stale Mining Fatigue) |
| b-gate r13 | infra (host crash) 2 613 s | controller_stall | 1 876 s | 12 min | B-phase, `b_gold_armor` SKILL_TIMEOUT |

  Across the four historical B gates, this would have saved 0 to 109 min per gate (b-gate 12, part 2 22, b2-gate 109, b3-gate 0). The b3-gate failures were death_limit ×2, timeouts with intermittent progress ×2 and infra ×1, which the rules correctly leave alone.
- **Slow successes not stopped:** b3-gate r15 (B 3 726 s, 3 deaths), b2-gate r18 (3 496 s), b2-gate r11 (3 461 s), b-gate r06 (3 441 s), b2-gate r07 (3 335 s), b-gate r08 (3 167 s), wood-hotfix replay r02 (4 162 s). None of the 69 successes is stopped.
- **Margin / aggressiveness:** tightening the stall window to ≤ 11 min would stop a success (b3-dev1 r06, B 2 681 s, at 1 659 s). A single exhaustion would stop two successes (b-dev2 r02, b3-dev1 r06). Dropping to 2 cycles stops nothing new. At 15 min and 2 exhaustions there are ≥ 4 min of stall margin and a 2× exhaustion margin over the closest success. Stops with exactly 3 cycles and < 16 min without progress are flagged "minimal margin" in the report.

### Milestone B re-gate (wood hotfix, early-fail procedure) on 1.16.1: 2026-10-05/06 (code uncommitted on ed01f93, content hash `4c8cac037e7e0da1`; Node 22.23.3, Java 1.8.0_504, mineflayer 4.39.0)

`20261005-145957-b-b4-gate`: 20 fresh held-out seeds, 70 min, reasoner none, `--parallel 1`, early-fail rules on (thresholds as fixed above). Bot code = the wood-target hotfix (ed01f93); only the evaluator changed. 0 host suspensions, 0 infra.

| B criterion (unchanged) | result | verdict |
|---|---|---|
| ≥ 60 % reach B | **15/20 = 75 %** (Wilson 95 % CI 53–89 %), GT 15/15 verified | PASS |
| ≤ 70 min/run | all 15 within 70 min (p50 1 725 s, p90 2 654 s, max 3 094 s) | PASS |
| ≤ 1.0 deaths/run | **13 deaths = 0.65/run** (creeper 4, zombie 3, skeleton 2, ghast 2, wolf 1, husk 1); 0 drowned; 1 repeat death < 5 min | PASS |
| 0 interventions | 0 | PASS |

**Gate: milestone B PASSES.** Compare round-3 gate 20261004: 15/20, 1.20 deaths/run.

Failures (5): r10 timeout (nether_ready 1 620 s; creeper death at the portal site 1 817 s, then re-gearing; no portal), r11 timeout (never nether_ready; food_10 never reached, 1 184 s sheltering), r14 timeout (in the Nether 1 694 s; two ghast deaths; excursion 3 115 s, no return), r18 timeout (3 creeper deaths before nether_ready; nether_ready 3 917 s, excursion at 4 181 s, out of time), r15 unrecoverable (`nether_excursion` failed 14×, NAV_HAZARD, L5 at 2 153 s; rule 1).

**Early-fail rules in the gate: 0 runs stopped, 0 min saved.** The rule-1 L5 run (r15) ended 34 min before the limit, as before. Not stopped, correctly by the predeclared definitions:
- r11, r14, r18: the longest stretch without progress was 794 s, 682 s and 790 s respectively, all under 15 min, and r14 and r18 also had discoveries in it.
- r10: no progress for 1 118 s (1 620 → 2 738 s). The cycles came from `b_gold_armor` (8, MISSING_RESOURCE after the death) and then `wooden_pickaxe` (2). Once the active requirement switched to `wooden_pickaxe` at 2 517 s, it had only 2 cycles before progress resumed.

No trigger looks aggressive (none fired). If anything they are conservative: requirements re-met after a death (re-crafting tools) count as progress, which kept r10, r14 and r18 alive to the limit. Any change to that definition must be made before a future gate, not applied to this one.

### Milestone C development on 1.16.1: 2026-10-06 (code uncommitted on 910e2c2; census, fixtures and dev batches, never a gate)

**Nether structure census** (`src/evaluation/census.ts`, evaluator-only console `locate` from a 9 × 9 grid of Nether positions, ±1 200 blocks; 20 fresh seeds, not retained; architecture §14.2 asks for it before any search budget is set). `runs/census-1791292143406/census.json`.
- 828 structures (fortress or bastion start chunks). Every start chunk lies at offset 0–22 of its 27-chunk region on both axes; no region holds two structures. This confirms the 1.16.1 placement rule the search uses (milestones.md, C rule notes).
- Fortresses are 116 of the 320 central regions (36 %); the rest are bastions or empty (a bastion attempt fails in basalt deltas).
- Nearest fortress start from points within 40 blocks of the Nether origin (where B's portals arrive): p10 172, p25 233, **p50 304**, p75 391, **p90 540**, max 871 blocks. With a 176-block scan of loaded chunks, a median run must still travel ~100–150 blocks in the right direction to see one.

**Fixtures** (`tests/scenario/c.scenario.test.ts`, flat world, Nether arenas by console; labeled, development only), as of the code that went into the first dev runs:
- *Piglin bartering:* baby piglins read from metadata index 15 (verified: exactly one of three summoned); 10/10 ingots handed over one at a time by use-on-entity; 0 provocations. Pass.
- *Nether gold:* `obtain gold_ingot 2` with a stone pickaxe mines nether gold ore and crafts ingots at a carried table. Pass.
- *Fortress search:* fortress 235 blocks away (beyond view); with every other zone pre-marked as seen, the region search leg toward the unseen part of the zone brings the bricks into the scan after one leg. Pass.
- *Blazes (vanilla spawner, golden helmet + iron boots, sword, shield):* with a fire resistance potion: pass (kills, rods, 0 deaths). Without one: died in 4 of 5 attempts during development (fireballs and burning with 4–6 blazes). Found and fixed on the way: the shield was pulsed every 300–400 ms, but a 1.16 shield blocks only after 5 ticks of use → continuous guard; blazes out of strike range were never approached → strike cells up to 16 blocks; retreat down a straight corridor stayed in sight → hidden trail point / terrain / dig-in first. Consequence for the policy: `c_fire_res` (barter for a potion before the rods).
- *Enderman alternate:* kills with sword and continuous shield. Pass (after the guard fix; the pulsed shield had ended at 6 HP).
- *Return:* 100+ blocks back along an L-shaped causeway over lava, then through the portal. Found: the `nether` profile preferred towering and bridging over the lake (scaffolding cost 1 vs +8/+40 per step beside lava) and ran out of blocks → `nether_travel` profile; the live trail shrank under the walker → snapshot. Pass.
- B portal fixtures (`portal.scenario.test.ts`) 6/6 with the C code.

**Labeled `ckit` fixture runs (scenario c, development only; each stopped once its leading failure was clear, code fixed in between):**
- `ckit1` r01: B in 147 s. Gold mining failed at once (excavation "no safe step" from an open cavern) → `mine` in the Nether reaches targets by pathfinder first. Piglin/enderman search never found an unseen direction (it looked 160 blocks out, inside the loaded view) → 320. Death: a `nether_travel` leg bridged over the lava-sea cavern, a placement failed, fell 60 blocks into lava → no scaffolding at all in `nether_travel`.
- `ckit2` r01: 24 ingots mined (~200 s); crafting them failed: `craft` gave up after 4 rounds even when each round made progress → now 4 rounds *without* progress. Piglin search walked to stale spots, ignoring piglins visible beyond 48 → visible piglins up to 128, hold gold and let them come, short legs. Death: a 37-block entity chase along roof ledges (y 117) fell 50 → no long chases; Nether mining band.
- `ckit3` r01: death on a magma floor while mining at y 35 → P0 `stepOffMagma`, magma floor cost in `nether_travel`, mining band y 40–100. After respawn and re-gearing (the C Overworld kit chain worked), it re-entered without a golden helmet and piglins killed it; `cover` fired 30× in 2 s because it did not count crossbow piglins as shooters → fixed.
- `ckit4` r01 (stopped at 960 s for a host restart): B 334 s, fortress seen on B's excursion, 24 ingots mined and crafted by 577 s (fixes hold), 0 deaths. Then 380 s of bartering with **0 trades**: piglins visible but unreachable; every short approach leg "succeeded" after 2–7 blocks, so the piglin was never skipped. **Next fix:** skip a piglin after 2 legs that do not bring it closer (and log approach attempts).
- `ckit5` r01 (after the per-piglin approach budget; stopped at 1 810 s): bartering works but slowly, 20 ingots traded by ~1 600 s and the first pearls; 11 piglins left as unreachable (crimson forest ledges). Leading failure: **hoglins**. The distance-scaled threat score chose `defend` against hoglins at 7 blocks four times; three ended at ≤ 4 HP, the fourth was a death. Fixes: hoglins and zoglins are always avoided (flee within 10, never fought); barter partners exclude piglins with a hoglin within 12 and weigh height differences; an unreachable piglin is dropped after one stale approach leg (piglins walk to a gold holder on their own when they can). Also seen: `c_food` hunted raw chicken, which counts as raw meat but not as a food item → OBJECTIVE_NOT_SATISFIED (bounded, suspended; the same formula as B's `b_food`).
- `ckit6` r01 (stopped at 1 820 s): B 303 s; died at 435 s to a magma cube (`defend` chosen at 6.5 and 9.2 blocks, same distance-scaled mistake as hoglins) → magma cubes are avoided too. After respawn the C kit was rebuilt, but the shield craft was preempted after placing the crafting table, which stayed behind; the bot re-entered without one and the golden-helmet plan asked for logs in the Nether (14 failures, suspended) → `c_enter` now requires `c_table` and `c_pickaxes`. The fallback to the fortress search worked: the region search found a fortress in 7 legs (~460 s, the region (0,−1) zone).
- `ckit7` r01 (stopped at ~2 400 s): B 376 s, fortress seen during B, 24 ingots by 605 s. Then **1 trade in 20 min**: every piglin ended "unreachable". The approach legs used an x/z goal and arrived beside piglins standing 15–20 blocks above or below. Fixes: a 3D `near` goal at the piglin's position; and when a piglin is within 7 blocks in sight but not walkable, one ingot is tossed toward it (a piglin that picks up gold barters it the same way; new fixture: piglin on an unreachable ledge, pass). Death at 1 849 s: burned (fire, then lava) during bartering; not yet diagnosed.
- `ckit8` r01 (stopped at ~1 200 s): tossing works (5 trades in ~6 min, 2 by toss) amid hoglins. Death at 1 019 s: the hoglin flight failed and the interrupt's "flight cooling down → defend" fallback fought the hoglin. Also a ghast 30 blocks off drew 30 instant flights in 4 s (its cover on cooldown → flee, which "succeeds" at once). Fixes: avoided mobs → a sealed dig-in (`cover`'s melee path), flight if that cools down, never `defend`; a shooter beyond 16 blocks whose cover is cooling down draws no interrupt.
- `ckit9` r01 (stopped at ~2 500 s): 24 ingots by 593 s; died at 605 s to a provoked enderman in a 2-s `defend` → endermen join the avoid list (they count only within 3 blocks, i.e. when provoked; `huntEndermen` still owns them). After respawn a golden-helmet craft was cancelled just after placing the table, so `c_gold` later planned logs in the Nether, wandered and fell (2 035 s) → the Overworld kit carries 2 crafting tables.
- `ckit10` r01 (stopped at ~2 370 s): two lava deaths in gold mining. (1) The pickaxes wore out (mining 24 ingots plus the digging to reach the ore used ~500 durability); the plan then tried to gather logs in the Nether, wandered and met lava. (2) `pickup` chased dropped nuggets with the navigator's default strategy (controlled excavation under the Nether roof), fell 17 blocks down a cliff, then into lava. Fixes: no `log` source in the Nether; `c_restock` (in the Nether with < 40 pickaxe durability: back through the portal, the Overworld kit restocks); kit durability 600; Nether `pickup` walks only, on the travel profile, and leaves drops more than 3 blocks above or below.
- `ckit11` r01: B failed (a lava cast on an unusable pool, then a skeleton death; after it, B's golden-helmet plan hits "cannot resolve log: depth > 10" in the Overworld, B code). No C evidence; restarted on fresh seeds.
- `ckit12` r01 (stopped at ~1 930 s): 24 ingots by 805 s; then **2 trades in 12 min** (one by toss), 11 piglins "unreachable" at 9–35 blocks, then a lava death while approaching one. After respawn the night schedule deferred the table and shield (no armor → not night-capable) and the bot sheltered. Leading C failure across ckit5–12: **piglins in open terrain are mostly out of reach** (other levels, ledges, walls). Changes: piglins in sight preferred; toss from up to 12 blocks, aimed up; within 16 blocks horizontally and 8 vertically, with no deep drop on the straight line, the approach may tower and bridge (`nether` profile); approach events log the height difference.
- `ckit13` r01 (fixture, 120 min, timeout): **first pearls_14 (3 528 s)**: tossing made trading work (54 ingots handed over in the run, most by toss; 3 fire resistance potions came with them). `c_restock` worked (pickaxes worn → Overworld → back in). Deaths: (1) 515 s, piglins attacked through the golden helmet 30 s after gold mining nearby → the dig guard now counts every piglin within 18 blocks, in sight or not (the server judges sight, not the client); (2) 3 620 s, at the blaze spawner camp: four blazes at 1 block, stone sword, 2 armor points, and **none of the three fire resistance potions drunk** — the "≥ 3 blazes in sight → retreat" rule ran before the drink step → potions are now drunk first, on arrival at a spawner camp or when blazes are near; a `blaze state` event every 10 s; (3) a later death in the second trip. Ended at the limit with B 55 s, pearls lost in death 2.
- `ckit14` (3 runs; stopped in r03): r01 ended in B (`nether_excursion` L5, the known B residual, as B gate r15). r02 reached B at 320 s but never re-entered for C: its portal stands underground (y 14, cast at a cave lava pool), every walk to it excavated through caves with skeletons, `cover` preempted it, and the dig wear re-opened the 600-durability pickaxe kit, which needed surface wood — a 40-minute loop; one skeleton death; timeout. Fix: the kit is built to 600 but re-opens only below 350.

**Fresh-spawn smoke `20261006-215727-c-c-smoke1`** (3 dev seeds, 120 min, reasoner none, no early-fail rules): **0/3 reached C.**
- r01: B at 1 573 s, back in the Nether 133 s later, 41 ingots traded → 8 pearls (0.20 per ingot; expectation 0.28), then three Nether deaths (lava while mining gold; ghast fireball ×2) and the 120-min timeout. Pearls never reached 14.
- r02: B only at 5 818 s (97 min): five Overworld deaths before and around B (lava ×2, creeper ×2, zombie) → death limit. A/B-phase survival, not C.
- r03: **infra error**: the host disk filled up (`ENOSPC`, 134 MB free of 228 GB) and the bot crashed writing a failure bundle at ~330 s. This session's run artifacts total 37 MB; the space is used outside the project. **No further batch can run until disk space is freed.**
- Report fix: the C section counted only pearls the barter skill itself saw; loot picked up by the P2 pickup was missing (r01 showed "0 pearls"). It now sums every pearl picked up.

**Smoke diagnosis and ghast fix (2026-10-07, before the 6-seed dev batch).** From `20261006-215727-c-c-smoke1` r01's death bundles and events:
- *Ghast deaths (2 of 3 Nether deaths).* Both deaths' `hostile` lists were empty: the observer dropped every entity beyond 32 blocks, and ghasts shoot from up to 64. In the first, the bot stood still 10 s on a stalled approach leg, took two fireball hits (20 → 8.5), then lost 1 HP every half second to fire one cell beside its centre column (feet and head read `air`, so no `escape_fire`), rested and ate in the open, and died to a third fireball. In the second it was hit at 9.9 HP while mining gold, ate, rested, and died to the next one. Fix: architecture §10F "Ghast fire" (64-block ghast tracking with charge flag, P1 cover from charging/close ghasts, P0 `deflect` shield reflex, hitbox fire detection). Ghast fixture: idle bot without the reflex dies in ~13 s; reflex only 0 deaths in 3/3 runs (min HP 16); full interrupt set 0 deaths in 3/3 runs.
- *Lava death while mining gold (1 of 3).* The bot reached a gold target at y 50 (path leg ended "ok" within range 4 after 239 partial paths) and within ~1 s was 18 blocks lower in the lava sea; no dig, pickup or nav event in between. The bundle's voxel slice was taken after respawn (Overworld), so the fall cannot be reconstructed. Not changed; recorded as undiagnosed.
- *Other time sinks in r01* (for later rounds, not changed): each Nether death cost 800–1 100 s before the bot was back in the Nether (re-kit 650 s of it a bounded hunt, then a 74–256-block walk to the portal at ~0.5 block/s with cover stops). r02's loss was A/B-phase: a food-poor world (`food_buffer` 1 806 s, starvation), lava ×2, creeper ×2, zombie.

**Dev batch `20261007-110334-c-c-dev1`** (6 fresh dev seeds, 120 min, reasoner none, no early-fail rules, code hash 78dcbfa8b7c07e49 = ghast fix): **0/6 reached C** (Wilson 95 % CI 0–39 %), 23 deaths (3.83/run), 0 interventions, 0 infra, ground truth agrees on every run. Outcomes: 4 timeouts, 2 death limits. **No 20-seed gate** (the plan required ≈ ≥ 3/6).
- Funnel: B 5/6 (p50 1 772 s; r02 only at 5 573 s, r01 never), back in the Nether for C 5/6 (B → re-entry p50 224 s, p90 1 589 s), gold ingots 4/6, first pearl 2/6, pearls_14 0, fortress seen 2/6 (both on B's excursion; the fortress search never ran: pearls come first), first rod 0. Bartering: 88 ingots → 18 pearls (0.21/ingot; expectation 0.28), 4 piglin provocations.
- Ghast fix: 0 ghast deaths; `deflect` fired in r04/r05 (most blocks 0 HP lost).
- Deaths: 9 in the Nether after B, 3 more in the Nether during B, the rest Overworld (creeper 4, zombie 3, drowning 2, spider, lava 2) before B or while re-kitting; 17 of 23 came after a run's first death.
- Leading C failures, by mechanism (events, traces, nav records per run):
  1. **Hoglins** (3 deaths + r04's 2 000-s pin): the avoid rule's sealed dig-in either found no diggable column (r04: 134 failed covers on the 200-block walk back to the portal, 207 restarted walks, then killed) or was knocked apart mid-dig (r05: 20 → 0 HP in 6–8 s twice, no counter-attack).
  2. **Bridges of the `nether` profile over deep drops or the lava sea** (3 deaths): B excursions in r01 (cobblestone placed, then 35-block fall) and r02 (`place_error`, 81 → 28 into lava), and a gold-ore search leg at y 34 in r04 (netherrack placed over the lava sea). Two more Nether falls (smoke r01 gold mining, r02 bartering on `nether_travel`) stay unexplained (1-Hz trace only).
  3. **Piglins angered by gold digs** (r03: two ores mined, killed 4 s later; r06 similar): the guard counted piglins within an 18-block sphere; vanilla angers every piglin in the player box inflated by 16 (corners ~29 blocks).
  4. Others, not changed: re-entering after a death without golden armor (r06: piglin, 7 s after arrival — the golden helmet is a Nether objective); 34 ingots → 0 pearls by chance (r03); Overworld deaths and slow re-kits (food hunts ~1 000–1 400 s) after a C-phase death; c_restock walks of 200+ blocks.
- **Fixes (architecture §10F "After dev batch c-dev1")**: guarded hoglin fight; no `nether` bridge over lava or a drop > 4; Nether search legs on `nether_travel` in y 40–100; box-shaped piglin guard; a `fall` event recorder. Fixtures `tests/scenario/nether-hazards.scenario.test.ts` (all development runs of the guarded fight): two hoglins with an iron sword 6 of 7 runs survived (min HP 9–20; the death: 20 → 5 HP before a single block, then the dig-in fallback could not centre); three hoglins with a stone sword 5 of 6 survived (one death: hits from the sides, 8 strikes spread over three targets → strikes now focus one target; after that 2 of 3 clean, 1 survived at 4.4 HP in the dig-in). A pillar perch tried first was knocked off while building (removed). Bridge over a 30-deep pit: walked around, 0 blocks placed, 0 falls (4/4). Ghast 2/2, survival 10/10 on the final code; C fixtures 6/8 in sequence (the two known order-dependent ones).

### Milestone C round 2 (opportunity order, bastion gold, adaptive barter, cheap death recovery): 2026-10-08 (code uncommitted on 910e2c2; fixtures only so far, never a gate)

User brief after `20261007-110334-c-c-dev1` (0/6): make C realistically capable of ≥ 40 % within 120 min before another full-seed batch; no c-dev2 yet, no D. Design: architecture §10G.

**Evidence read from c-dev1 (new report columns, recomputed on its events):** first useful structure seen during B in 4 of 6 runs (r04 fortress at 1 732 s, r05 fortress + blaze spawner at 1 681 s, r02 and r06 bastion), yet every run took the piglin/ore route; ore gold ≈ 3–60 ingots per run for 0–34 handed over; C deaths 13, death → back in the Nether 641–1 456 s (n = 5). From the 1.16.1 server jar: every bastion template type carries gold blocks (bridge piece 16, entrance 7, housing wall base 12, stable side wall 12, treasure centres 12–19) and gold-bearing chests; barter table pearls 20/423, 4–8 (simulated ingots to 14 pearls p50 52, p90 107).

**Targeted 1.16.1 check before relying on a bed** (`tests/scenario/bed-spawn.scenario.test.ts`, 2/2): using a bed by day → "Respawn point set" + "You can sleep only at night", player `SpawnX/Y/Z` = bed head; death → respawn beside the bed (also walled in on three sides); bed removed → respawn at the world spawn.

**Fixture isolation** (`tests/scenario/c.scenario.test.ts`, run in sequence before and after):
- Before: blaze-without-fire-resistance started among 2 leftover blazes and died; the enderman test then **hung the worker at 100 % CPU for 40 min** (inspector stack: `huntEndermen` fight loop calling `state()` without yielding: the navigator's entity goal settled at once while reach was still > 3, the event loop never processed packets, the enderman never moved). The trail test never ran: this hang was the old "trail fails in sequence".
- Fixes: `beforeEach` kills every non-player entity and resets Nether memory; both blaze tests build their own room far away; `huntEndermen` and the blaze loop yield every pass (an enderman not reached after 6 approaches is left).
- After: 6/8 in sequence. Trail ✓ (in sequence), barter ✓, ledge toss ✓, nether gold (fallback mining) ✓, fortress search ✓, blazes with fire resistance ✓. ✗ blazes **without** fire resistance in its own fresh room (0 kills; a spawner keeps 3–6 blazes in sight and the crowd rule retreats every time; death) — a real skill limit, not leakage (with the 2026-10-07 run: 2 of 2 isolated deaths). ✗ enderman alternate: 0 kills, quit at 8 HP among 5 endermen (no hang any more).
- Consequence (policy): fortress-first barters for one fire resistance potion first when a gold source is known; the rods objective camps at a spawner only with fire resistance, else starts on fortress floors (`roam`, unmeasured).

**Focused C fixtures** (`tests/scenario/c-route.scenario.test.ts`, 6/6 on the final code, after two fixes found by its first run: the bastion target scan was centred on the bot, so a large bastion was marked exhausted from one end; and a fixture memory leak):
- Opportunity order from live observation (full controller, C list): fortress room in loaded chunks → first C objective `c_rods` (mode `roam`: no potion, no gold source); bastion blocks only → `c_gold` via `bastionGold` (batch 8).
- Bastion gold: chest no piglin sees → 5 ingots + spare golden boots (string left), open gold block → 9 ingots, gold block with 2 piglins in the anger box → `guarded`, left; 0 provocations, 0 deaths.
- Progressive bartering: 12 pearls + 20 ingots, 2 piglins; 2 pearls land after the first hand-overs → `barterPearls` ends at 14 pearls with 18 ingots kept; ledger `given` matches.
- Bed wool: hunt `white_wool` kills the white sheep, leaves the red one.
- **C death recovery:** bed set and kit staged at a portal (`setSpawnBed`, `stashKit`: stone sword, 2 stone pickaxes, table, 4 food, 32 cobblestone, golden boots), death 30 blocks away → respawn at the bed → objectives `c_unstash`, `c_enter` → back in the Nether wearing golden boots **13 s after the death** (c-dev1: 641–1 456 s).
- Unit: 327/328 (the pre-existing b-round2 failure on HEAD, untouched).

**Not yet run (host on battery at 19 %, 4.1 GB disk free at 2026-10-08 ~21:00 local):** the 3 B-state C runs on random terrain (`ckit`), the 3 fresh full-seed smoke runs, c-dev2.

#### ckit-r2 (`runs/20261009-004257-c-ckit-r2`, 3 runs planned, stopped after run 1 to fix the defects it showed): 2026-10-09

`npm run eval -- --scenario c --fixture ckit --n 3 --parallel 1 --label ckit-r2` (development fixture, never scored; host on battery, 100 % at start). The batch was stopped with SIGTERM at the start of run 2 (r02 has no data); no `src/` edit was made while r01 ran.

**r01 — timeout at 7 199 s, C not reached, 2 deaths (both C).** B at 271 s (bastion seen on the B excursion at 256 s → route `bastion-first`). Overworld C prep 271 → 899 s: spare golden boots, wool + bed (`setSpawnBed` set at 893 s, 3 blocks from the portal), kit chest staged; most of it was walking to and from the portal, which sits at y 51 under the surface (84 blocks to it: 200 excavation steps, 180 s; the first `setSpawnBed` timed out on that walk). C entry 899 s; first bastion gold 2 161 s (one chest, 5 ingots; one other chest `NAV_UNREACHABLE`, retried every ~600 s three times); 8 ingots handed over → 0 pearls; `c_restock` at 2 504 s (pickaxe durability) → 260-s walk to the portal and back.
- **Defect 1 — calm piglins treated as threats.** `mobThreat` still scored a piglin within 3 blocks of a gold-wearing bot, and `cover.shooters()` counted crossbow piglins whatever the armour. In the bastion: 146 `flee` interrupts from piglins (`piglin@1.4–3: threat 6 > capacity 4.2`), `cover` held 8 s at a time "hidden" from crossbow piglins instead of digging in from a magma cube (≈ 60 consecutive 8-s covers, 1 637–2 453 s), and the sealed-in `hold` waited 30 s at a time on piglins (`shelter` 885 s after the first death). **Both deaths** were mid-flee from piglins: the flight ran into a large magma cube, 20 → 0 HP in 2.3–2.4 s (3 451 s, 5 108 s).
- **Defect 2 — the bot dug up its own respawn bed** on the restock trip (2 768 s, `white_bed +1` while pathing near the portal), so the first death respawned at the world spawn (`stash bed_lost`, 19 blocks off). Recovery still took 23 s (death → `takeStash` → back in the Nether wearing the staged golden boots). The second death had no stash and no bed left: full re-kit 5 108 → 6 491 s (Overworld gold for golden boots 776 s, new bed 410 s), re-entered at 7 165 s.
- Route metrics (C report): route bastion-first, first structure bastion at 256 s, bastion chests 1 (5 ingots), gold blocks 0, ore ingots 0, ingots given 8, pearls 0, rods 0, C deaths 2, recoveries [23 s].

**Fixes after r01** (architecture §10G):
- `calmPiglin` / `menacing` (threat.ts): a piglin never attacks a gold-wearing player until angered, at any distance, so an unprovoked piglin is no threat, no shooter (cover), no reason for night shelter, rest exposure, the sealed-in hold or combat's weak-state check; anger still shows as a hit (`piglinsProvoked`) and restores all of these.
- `isProtected` (hazards.ts): beds and chests are never dug — pathfinder `blocksCantBreak`, the excavator, the stuck/ceiling digs, and `digIn`.
- Unit 329/330 (new: calm piglins at 1.5 and a crossbow piglin at 10 are no threat/no shooter and raise no interrupt; provoked → both count; calm piglins do not keep a sealed-in bot waiting; protected names). The pre-existing b-round2 failure is unchanged.

#### ckit-r2b (`runs/20261009-025619-c-ckit-r2b`, 3 runs, with the calm-piglin and protected-bed fixes): 2026-10-09, 0/3 C

`npm run eval -- --scenario c --fixture ckit --n 3 --parallel 1 --label ckit-r2b` (AC power; no `src/` edit during the batch). Development fixture, never scored.

| run | outcome | B s | route (first structure) | C entry s | gold (source) | ingots → pearls | rods | C deaths | death → back in Nether s |
|---|---|---|---|---|---|---|---|---|---|
| r01 | timeout 7 200 s | – | – | – | – | – | – | 0 (3 Overworld deaths: spider at y 17 at 165 s lost the whole ckit, husk, skeleton) | – |
| r02 | timeout 7 199 s | 73 | fortress-first (fortress + spawner at 46 s; FR barter first) | 1 420 | 43 ore ingots | 34 → 6 pearls, 1 splash FR | 0 | 3 (lava fall, enderman ×2) | 8, 1 163 |
| r03 | **unrecoverable** at 3 657 s: `c_structure failed 14× (last NAV_HAZARD)` | 77 | search → bastion (2 675 s, then unreachable) | 1 316 | 0 | 0 | 0 | 1 (lava fall) | 1 136 |

- **The new mechanisms worked where reached:** calm piglins caused no flee or cover loops (0 piglin interrupts in r02/r03); the bed held (r02: 3 respawns at the bed, death → back in the Nether in 8 s with the kit); fortress-first chose ore gold → barter for fire resistance → spawner as designed (FR splash at 1 873 s after ~16 ingots).
- **Failures, by mechanism:**
  1. **Falls of 6.5–6.7 blocks into lava** (r02 1 948 s on the walk to the spawner, holding an unused splash FR potion; r03 1 478 s on a structure-search leg; one more 6.5 fall survived). Not a bridge (`nether_travel` places nothing). r02: the bot jumped up a block, a server position correction landed it over a cell the client held as air, and it fell straight through; r03: a sideways drop beyond the recorder's 3 × 3 window. Unexplained beyond that.
  2. **Angry endermen while bartering** (r02 ×2): 7 per hit, 20 → 0 HP in 2 s; the first time the bot dug in at 12 HP, then left the pocket at once (nothing marked the enderman as angry) and died.
  3. **Restock churn after a C death** (r02): one 131-use stone pickaxe → 4 restock round trips in an hour.
  4. **Structure search ended the run** (r03): `c_structure` was not persistent; 14 `NAV_HAZARD` failures → L5 terminate with 59 min left.
  5. Fire resistance lost with a death; the FR-first barter then spent 18 more ingots without another potion (P(no FR in 18) ≈ 42 %).
  6. Overworld C prep is slow (628 s r2-r01, 1 347 s r02 with a creeper death, ~400 s r03) and an A/B-phase run (r01) never reached B: not C mechanisms, not changed.
- **Fixes after r2b** (architecture §10G):
  - `escapeLava` uses a carried fire resistance potion first: splash at once; drink only above 10 HP and with no safe cell within 1.5 blocks. Fixture `tests/scenario/lava-potion.scenario.test.ts` 2/2 (bot dropped into a 5 × 5 lava pool's centre: splash → FR at 12.8 HP, out at 14.8; drink from 18 HP → FR at 2 HP, survived; without a drink in the same pool from 18 HP: dead in 4.5 s).
  - Angry endermen: metadata index 16 (screaming) verified on the server (`tests/scenario/enderman-anger.scenario.test.ts`, 1/1) → `aggro`; an angry enderman is a threat at any distance (cover/dig-in), and a sealed-in bot holds while one is within 32 blocks.
  - After a C death a pickaxe is still enough at 131 uses to re-enter, but when one is built it is built to `pickReopen` (350).
  - `c_structure` persistent (like `c_fortress`): repeated hazards suspend it; gold and piglins go on.
  - C report: a fire-resistance-first fortress route is labelled `fortress-first` (was `piglins/ore`).
- Regression on the r2b fixes: unit 330/331 (pre-existing b-round2 failure); `c-route` 6/6, `ghast` 2/2, `enderman-anger` 1/1, `lava-potion` 2/2; `nether-hazards` 4/5 — "three hoglins with a stone sword" failed (guarded fight quit at 6 HP, then the dig-in did not drop into its shaft; the documented failure mode), and 1 of 2 reruns failed again: 1/3 survived today against 5/6 earlier. None of the r2b changes touch the hoglin path; recorded as a still-marginal fixture. Next: ckit-r2c (3 runs) launched 2026-10-09 08:20.

#### ckit-r2c (`runs/20261009-082052-c-ckit-r2c`, stopped after run 1 to fix a fatal navigation defect): 2026-10-09

r01 (`death_limit`, 5 deaths, 5 382 s, C not reached): B at 230 s (fortress seen at 218 s → fortress-first); C entry 786 s; ore gold → FR barter (no potion; 1 pearl) → `c_restock` at 1 660 s. **Re-entry after the restock failed six times** ("stood in the portal but the dimension did not change": `stepIn` walked without digging and stopped 1.5 blocks short, one block above the portal floor, after the bot had mined stone beside its underground portal at y 21) → `c_enter` suspended; the bed hunt then failed underground ("could not reach the surface to hunt"); re-entered at 3 860 s via a later attempt. Bastion found at 4 054 s; at 4 466 s a **fall of 6.7 blocks into lava** on the bastion approach; no bed → world-spawn respawn at night, unarmed, 20 blocks above the stash → 4 Overworld deaths walking back (skeleton, zombie, a 30-block fall down its own portal shaft during a flee, creeper) → death limit. The batch was stopped with SIGTERM 10 min into r02 (no data); no `src/` edit was made while r01 ran.

**Lava falls explained (2 of 3 deaths):** in ckit-r2b r03 (1 478 s) and ckit-r2c r01 (4 466 s) the fall began right after the navigator's **unstick move** (`stuck_detected` → `unstick_move`, dir chosen by `stepHazard`, which vouches for the next cell only). The move held forward + jump for 700–900 ms and carried the bot ~3.5 blocks: past the safe cell and off the ledge beyond it. (ckit-r2b r02's fall followed a server position correction instead; still unexplained.)

**Fixes after r2c r01:**
- Unstick move: brakes after `UNSTICK_STEP` (0.6 blocks) along its direction (forward, sprint and jump released, 150 ms back) and ranks directions whose second cell is also safe first. Fixture `tests/scenario/unstick-ledge.scenario.test.ts` (raised platform, 8-block drop onto lava): first version still carried the bot to x 2.08 (over the edge cell) with forward released on entering the next cell, because airborne momentum carries ~1 block; with the brake 3/3 — the move ends 1.05 blocks from the start, at x 1.55 when the ledge is the only safe direction; with other safe directions the ledge side is not taken.
- Portal step-in: walk, then a path that may dig, then the other portal cells; the failure logs where the bot stood. Obsidian is protected from travel digs (portal frames).
- Unit 331/332 (pre-existing b-round2 failure).
- Regression after the unstick brake and step-in fallback: nav, survival, c-route, nether-hazards, ghast, portal fixtures 48/48 (incl. three hoglins with a stone sword). Next: ckit-r2d (3 runs).

#### ckit-r2d (`runs/20261009-102334-c-ckit-r2d`, 3 runs, fresh fixture seeds): 2026-10-09

| run | outcome | B→C entry s | first structure | gold (source) | pearls / rods | C deaths | death → re-entry s | kit / bed |
|---|---|---|---|---|---|---|---|---|
| r01 | `unrecoverable` (c_bed 14×), 5 403 s | never re-entered | – | – | 0 / 0 | 0 (3 Overworld deaths in the prep) | – | no / no |
| r02 | timeout, 7 185 s | 1 363 | bastion 3 213 s | 0 (bastion: none taken) | 0 / 0 | 3 | 391 | no / no |
| r03 | `death_limit`, 6 142 s | 347 | bastion 526 s | 6 ingots (2 bastion chests) | 0 / 0 | 5 | 6, 1 607, 1 807 | yes / yes (4 bed respawns) |

0/3 reached C (0/9 ckit runs since round 2). Mechanisms:
- **r01, Overworld prep in a frozen ocean.** The second crafting table needed one log; every surveyed direction was water (`waterAll` 1), so the search swam north. Drowned chased the swimming bot for 350 s (flee stalled 15 times) and killed it at 603 s, and the whole iron kit was lost. Rebuilding took about 3 200 s with 2 more deaths. Back near the portal the bot ended under packed ice: "repeatedly out of air", with water exit candidates 0, 75 blocks from the portal for 1 200 s, and c_bed failed 14 times.
- **r02, bed set from inside the portal.** `setSpawnBed` walked "near" the portal and stopped in a portal cell. The bed was placed 3 blocks up, with no "Respawn point set" message. The 2.5 s wait plus the bed hunt that followed left the bot standing in the portal long enough to be teleported. It then hunted sheep in the Nether, digging toward Overworld coordinates, so the bed and the kit chest were never set up. **Two Nether falls (35 and 50 blocks)**: both started with the bot standing on a ledge edge, held up by the neighbouring block, and snapping to the exact centre of the air column (23.9 → 24.5; 27.9 → 27.5). The snap is upstream mineflayer-pathfinder's `fullStop()` (called on every dig, placement and reached goal), which sets x/z to the block centre when the bot is more than 0.2 off it. This is also the likely cause of ckit-r2b r02's unexplained fall. The rest were Overworld deaths (creeper, skeleton) with no kit.
- **r03, the bed and kit worked.** Prep took 347 s and the first C death (a piglin at the bastion) was back in the Nether in 6 s. Then **three Nether falls**, two at the identical spot after the same trail leg: pathfinder's walk-jump accepts a jump that passes the next node mid-air (`getReached` ignores `onGround`), and the jump beside a 30-block drop carried the bot 0.6 blocks sideways off the ledge. The 6 bastion-chest ingots were lost with the first death. With 0 gold, `barterPearls` failed twice and `c_pearls` switched to endermen (1 kill, 0 pearls kept).
- **Kit chest logging bug (all earlier runs):** `takeStash` logged `taken: {}` every time, because the observer's inventory snapshot lags the withdrawals. The 5 s item deltas show the kit was in fact taken (e.g. r2b r02: cobblestone −1 net after losing 33 and taking 32).
- Overworld prep time per objective across ckit-r2 … r2d (B → C entry): 347–1 363 s when the bot gets in. The spare golden boots for the kit chest cost 103–706 s in every run.
- Post-B deaths across the 9 ckit runs: 11 in the Overworld (creeper 3, skeleton 3, zombie 2, drowned 2, fall 1) and 9 in the Nether (falls 5, lava 3, enderman 2, magma cube 2, piglin 1). Every Overworld death costs the whole kit.

**Fixes after r2d:**
- Fall guard (`src/nav/fall-guard.ts`, installed by the navigator after the pathfinder, so it runs later in each physics tick, before the controls are simulated):
  - The re-centring snap is vetoed when it would take the bot off its only floor column.
  - Each tick on the ground with movement keys held, the keys are simulated with the server's physics (held 3 ticks, then released with momentum kept, until landing). A move that lands more than 4 blocks down, never lands, or enters lava has its keys released. No position or velocity is set for it: the bot only declines to press keys.
  - Development bug: mineflayer's `controlState` does not spread into plain booleans, so the first version simulated NaN x/z and vetoed everything. The keys are now read one by one.
  - Fixture `recentre-ledge` 3/3. A reached goal at x 1.1 on a ledge stays at x 1.10; without the guard the same fixture snaps to x 1.50 and falls 8 blocks. Re-centring over a supported column still happens. A forward-jump toward an 8-block drop is vetoed and stops at x 1.27, while a jump up a 1-block step still climbs to y 13.
- The pathfinder never routes through `nether_portal` cells unless the goal itself is a portal cell (usePortal's step-in).
- A portal crossing during any skill other than usePortal, netherExcursion or buildNetherPortal cancels the running skill (`cancel('dimension')`).
- `setSpawnBed` logs the bot's position and the messages received while using the bed. `takeStash` counts the kit from the client inventory.
- Unit 333/334 (pre-existing b-round2 failure).
- Regression after the r2d fixes: nav, survival, c-route, nether-hazards, ghast, portal, bed-spawn, shoreline, unstick-ledge fixtures 55/55, plus recentre-ledge 3/3. Next: ckit-r2e (3 runs).

#### C staging round (cheap staging, minimum re-kit, water/ice escape, bed robustness): 2026-10-09/10 (code uncommitted on 910e2c2, content hash `69fc858bae870258`; fixtures only, never a gate)

User brief after ckit-r2d: shorten B → first C entry and death → back in the Nether without risking the trip kit; ckit-r2e only after targeted tests pass. Design: architecture §10G "C staging round".

**Measured before (ckit-r2 … r2d, random terrain):** B → first C entry 347–1 362 s when the bot got in; the spare golden boots cost 103–706 s in every run; all 3 Overworld deaths of the staging came on its wood trips (c_table ×2, c_stash_wood), each losing the whole iron kit; c-dev1 death → back in the Nether 641–1 456 s.

**Fixture suite `tests/scenario/c-staging.scenario.test.ts`** (flat world, real 1.16.1 server). First run 2026-10-09: 2/7. Failures on 2026-10-10, read before any edit, and their fixes:
- *Cheap staging* — the implementation worked (bed, kit chest, Nether in 9 s, nothing gathered); the test expected `stone_pickaxe: 1` in the chest, but both spares were crafted from carried planks (`C.stashPickaxes` 2). **Test fixed** (≥ 1).
- *ckit inventory, tree 40 blocks off* and *bot starts inside the portal* — passed on every 2026-10-10 run, alone and in sequence, with no edit; the 2026-10-09 failure messages were lost with the host restart, so no cause can be named.
- *Night bed with a monster* — the caged zombie stood 9.5 blocks from the bed site on x (the 1.16.1 check is a ±8 × ±5 × ±8 box around the bed head), so the bot slept ("Sweet Dreams"); the refusal path never ran. **Fixture fixed**: the cage is put 5 blocks behind the site the skill picks (computed before the cage exists), the zombie is summoned after nightfall; the test now requires the "You may not rest now; there are monsters nearby" refusal, `answer: set`, no sleep, and the respawn beside the bed. Bed logic unchanged.
- *Under an ice sheet* — a real trap and a **runtime defect**: the bot had sunk to feet y 8.6, the ice was at y 13, and `surface()` looked for the ceiling only 2–4 blocks above the feet (all water), so no ice ceiling was seen; with no water route (hole 14 blocks away) the one fallback dig was spent on a water cell, and the bot ended under the ice at air 6. Fixed: ceiling scan up to 6 above the eyes, dig once within 3.5, the fallback dig waits for a block. Run alone, a second defect showed: `escapeWater` returned true at once because `isInWater` reads false while bobbing at the surface; fixed with `standingDry` (on ground, feet cell not water). Now: ice dug at air 15–16, surfaced at air 19, flush exit onto the sheet.
- *Minimum re-kit* — passed in sequence (39 s) but **failed alone** (no entry in 180 s): `c_table` searched for logs in the treeless fixture. In sequence it had chopped the tree left by the ckit-inventory test (outside the next test's reset radius). The fixture gave 3 logs: enough for the pickaxes, the sword and the table placed to craft them (crafting leaves it in the world, by design), not for the table carried in. **Fixture fixed**: 4 logs, and the x 40 tree is removed after its test. Not changed (noted): after a death the crafting table placed for the re-kit stays behind, so a carried table costs one more log.

**Targeted validation on the final code:**
- Unit: `c-staging`, `milestone-c`, `nav-water` 67/67; typecheck clean.
- `c-staging.scenario.test.ts`: 7/7 in sequence; each test alone: 7/7 (under-ice 2/2 alone after the fixes).
- Existing C death recovery (`c-route.scenario.test.ts` "C death recovery", kit chest + bed): alone ✓ and in sequence after the c-staging suite ✓ (8/8 combined).
- Not run (per brief): full unit/scenario suites, other fixtures, smoke seeds, c-dev2.

**Measured times — flat-world fixtures only** (no terrain, no mobs, portal 6 blocks away; they show the mechanism, not gameplay):

| fixture | path | time |
|---|---|---|
| B → first C entry, carried planks + bed | `c_table2` → `c_bed` → `c_stash` (spare stone sword, 2 stone pickaxes, table, 4 food, cobblestone) → `c_enter` | 9–10 s |
| B → first C entry, ckit inventory (no wood, gold, wool) | `c_stash_wood` (local collect, nothing within 24) → `c_enter`; no chest, no bed, the tree 40 blocks off never approached | 6 s |
| death after B, no kit staged → Nether | wooden/stone pickaxe, stone sword, golden boots from 4 carried ingots, 1 table → `c_enter`; no second table, no shield (no iron), no hunt/mine/search | 20–24 s |
| C death with bed + kit → Nether (c-route) | respawn at the bed → `c_unstash` → `c_enter`, golden boots from the kit | 13 s |

Representative gameplay times exist only from random-terrain runs: before this round 347–1 362 s (B → C entry) and 641–1 456 s (death → Nether, c-dev1). New random-terrain numbers come from ckit-r2e below; nothing is extrapolated from the fixtures.

#### ckit-r2e, first launch (`runs/20261010-144752-c-ckit-r2e`): 2026-10-10, void — 3/3 infra at start-up

All three runs ended `infra_error` after 7.6–8.6 s ("bot exited without result", no events): `TypeError: Cannot read properties of undefined (reading 'bind')` at `installFallGuard`. The fall guard (added after ckit-r2d) wraps `bot.clearControlStates`; the bot process (`src/bot/main.ts`) builds the navigator right after `createBot`, before mineflayer injects its plugins on `inject_allowed`, so the function did not exist yet. Every fixture builds the navigator after `spawn`, which is why the 55 regression fixtures and recentre-ledge passed; no eval batch had run since the guard was added. **Fix:** without `clearControlStates` the guard installs on the first `spawn` (the pathfinder's `physicsTick` listener is registered by then, so the guard still runs after it). Checks: a throwaway check in the `main.ts` order (navigator before injection) — `clearControlStates` undefined at construction, wrapped after spawn, guard listener after the pathfinder's; a 4-min real-process start-up run (`20261010-145031-c-ckit-r2e-startup`, `--limit 4m`, development only): no crash, 228 s of play, A and portal work; recentre-ledge 3/3; typecheck clean. Not counted; ckit-r2e relaunched with the same command.

#### ckit-r2e (`runs/20261010-145733-c-ckit-r2e`, relaunch with the start-up fix): 2026-10-10, **incomplete — 0 scored runs, no C result**

`caffeinate -dimsu npm run eval -- --scenario c --fixture ckit --n 3 --parallel 1 --label ckit-r2e` (AC power, 100 %; 2.16 GB free at launch; disk watchdog: SIGTERM to the evaluator below 700 MB free; no `src/` edit during the batch).

| run | outcome | elapsed s | B s | B → first C entry | staging | gold / pearls / rods | deaths | structures | Overworld return |
|---|---|---|---|---|---|---|---|---|---|
| r01 | **infra_error**: uncaught mineflayer `AssertionError: invalid operation` (`prismarine-windows` `Window.acceptClick` ← `confirmTransaction`; same upstream defect as b3-gate r10) | 2 045 | 2 018 (Enderman death at 374 s before B lost the kit; B rebuilt) | – (crashed 27 s after B, in `c_stash_wood`) | – | 5 ingots peak (B-phase golden armor) / 0 / 0 | 1 (Overworld, Enderman, pre-B) | bastion seen 1 995 s (B excursion) | – |
| r02 | **stopped** by the disk watchdog at 669 MB free (macOS added a 13th 1 GB swapfile at ~15:45; batch artifacts 1.7 MB, world 17 MB) | 1 043 | 215 | **6 s** (`c_stash_wood`: no log within 24 → skipped; `c_enter` 4 s) | none made (no carried wood, no bed at hand) | 0 / 0 / 0 | 0 | bastion 531 s → `bastionGold` NOT_FOUND (no reachable target, 655 s); `findFortress` NAV_HAZARD (886 s) | `c_restock` (pickaxe wear) → Overworld at 999 s; re-kit started |
| r03 | not run | – | – | – | – | – | – | – | – |

- Usable evidence: one real-terrain B → first C entry of 6 s (before this round 347–1 362 s). The cheap staging skipped everything optional and entered at once. No death → re-kit → Nether timing on real terrain (no post-B death occurred).
- The fall guard is active in the real bot process: 44 `fall_guard` vetoes across r01/r02, 0 fall deaths.
- Not resumed: free disk was 0.67–1.8 GB after the stop (swap-driven, outside the project). Resume when space allows: `npm run eval -- --resume 20261010-145733-c-ckit-r2e` (r02 is then scored infra and r03 runs); a fresh 3-run batch is cleaner given 2 infra runs.

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
- **Scored:** every outcome except `intervened` counts in the denominator. **`infra_error` counts as a failure** and is also reported separately. An infra rate above 5 % blocks the gate until it is fixed.
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
6. **Server settings** are fixed per batch and recorded in `batch.json`: vanilla 1.21.4, `difficulty=normal`, default gamerules, `view-distance=10`, `simulation-distance=10`, `online-mode=false`. `/tick` is never used in scored runs.
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
  "codeRev": "abc1234", "dirty": false, "mcVersion": "1.21.4", "config": {"reasoner": "none", "limitMin": 120, "target": "C"},
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

## 6. Navigation benchmark (M0 and any nav or dependency change)
The evaluator places the bot at spawn on fresh `dev` or held-out seeds. The bot picks targets with its own RNG in the Overworld (surface 30/100/300 blocks away, and a cave target Y=-20..20 under 50 blocks). Nether targets use fixture runs. The benchmark reports success rate, time per block, stuck count per km, and failure classes per profile. Targets are picked by the bot at run time, so they depend on no seed.

## 7. Reporting rules
- Report every attempt, including infra errors and intervened runs, which are shown but not scored.
- A claim of reliability needs the n, the CI and the seed-set id. Claim final success only after the F gate passes on two held-out sets.
- Keep `runs/` out of Git. Paste each gate's `report.md` summary into a gate log section at the end of this file.

## Implementation notes (M0)
- Server settings as in §2.6, plus `spawn-protection=0` (vanilla already disables spawn protection with an empty op list; set explicitly so a non-op bot can dig near spawn) and `sync-chunk-writes=false` (performance only). All recorded in each `batch.json`.
- **Ground-truth queries:** at the end of each run, while the bot is still connected, the evaluator runs read-only console queries `data get entity <bot> Inventory` and `… Pos`. They go into `ground_truth.jsonl`. `summary.json.groundTruth.verified` is false when the server inventory disagrees with the bot's claimed outcome, and such a run never counts as a success.
- **Fixture `kit`** (`--fixture kit`): the evaluator gives a stone pickaxe and 32 dirt when the bot joins. It is used only for the navigation benchmark's "milestone-A-like" variant. Fixture batches are labeled and never scored.
- The seed exists only in the evaluator and in `runs/<batch>/<run>/private/seed.txt`. The bot gets a whitelisted environment (`BOT_CONFIG`, strict schema, no seed field). `tests/unit/isolation.test.ts` checks that bot-side code never references seeds, the server log, world dirs or ground truth.

## Gate log

### M0: 2026-09-27 (code uncommitted, dirty working tree; Node 22.23.3, mineflayer 4.39.0, pathfinder @6f5c26b)

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

### Navigation benchmark: 2026-09-27

8 trials per run (surface 30/30/100/100/300/300, then 2 cave targets at Y −20..20 within 50 blocks horizontally; caves run last), profile `overworld`.

| batch | condition | surface30 | surface100 | surface300 | cave | all | deaths |
|---|---|---|---|---|---|---|---|
| `20260927-214528-navbench-bare2` (6 fresh seeds) | bare-handed (scored) | 11/12 | 10/12 | 9/12 | 0/12 | 30/48 = 62.5 % | 3 |
| `20260927-221204-navbench-kit` (6 fresh seeds) | fixture `kit` (not scored) | 11/12 | 10/12 | 7/12 | 4/12 | 32/48 = 66.7 % | 0 |

Speed on successful trials is 0.26–0.37 s/block on the surface. Stuck events are 3.4/km (bare) and 6.4/km (kit).

Failure classes: the bot was in water or next to it in 11 of 18 bare failures and 8 of 16 kit failures. It cannot climb out of water onto a 1-block ledge, and it swims with its eyes submerged, so air drains. Dry cave failures come from A* returning only `partial` results for 3D targets with digging, plus oscillation on partial paths. No stuck event happened while digging.

`20260927-211743-navbench-bare` is superseded: its trial order put caves mid-run, and a failed cave trial left the bot underground, contaminating later surface trials. `20260927-214238-navbench-kit` was aborted for the same reason.

### Navigation hardening benchmark: 2026-09-28 (code uncommitted)

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

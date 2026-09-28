# Architecture

Phase 2 design for the stack chosen in [proposed-stack.md](proposed-stack.md): headless Mineflayer bot on a vanilla Java **1.21.4** server, in Node 22 / TypeScript. Milestones are in [milestones.md](milestones.md) and evaluation is in [evaluation.md](evaluation.md).

## 1. Principles

1. **Deterministic by default.** All continuous play is plain code: movement, mining, combat, eating and survival reflexes. With `reasoner=none` the bot must be able to finish the whole game. The model makes it more robust, but the run never depends on it.
2. **Structured state is the sensor.** Mineflayer state feeds a typed `WorldState`. Screenshots are only captured as supporting evidence at boundaries.
3. **Event-driven reasoning.** The model is never polled. It is called only through a gated trigger list with a per-run budget (§5.4).
4. **Menus, not free-form control.** The model picks from validated options that the deterministic layer builds. It never writes actions, coordinates or code at runtime.
5. **Idempotent, goal-shaped skills.** A skill is defined by the state it produces, such as "have 3 iron ingots", not by a script. That makes cancel-and-reissue safe, so there is no pause/resume machinery.
6. **One owner per concern.** Each component in §3 owns exactly one decision. Anything else reads its output.
7. **Legal information only.** No commands, ops, seed, server log or fixed coordinates in the bot. Only client-visible state and the bot's own memory.

## 2. Process layout

```text
┌──────────── Evaluator process (src/evaluation) ─────────────┐
│ seed pool (private) → world dir → minecraft-wrap server      │
│ spawns bot child process with RUN_DIR, HOST, PORT, CONFIG    │
│ tails server log → ground_truth.jsonl (deaths, advancements) │
│ wall-clock timeout, kill, collect artifacts, write summary   │
└───────────────┬───────────────────────────────┬──────────────┘
                │ TCP (Minecraft protocol)      │ child process + files
┌───────────────▼──────────┐   ┌────────────────▼───────────────────────────┐
│ Vanilla 1.21.4 server     │   │ Bot process (src/bot … src/telemetry)       │
│ online-mode=false, no ops │◄──┤ Mineflayer + plugins                         │
│ difficulty=normal         │   │ Navigator · Observer · Controller · Skills   │
└───────────────────────────┘   │ Planner · Recovery · Reasoner · Telemetry    │
                                │ localhost control endpoint (observe/pause)   │
                                └──────────────────────────────────────────────┘
```

The bot process never receives the seed, the server log path or the world directory. The evaluator is the only component that sees them (see evaluation.md §2).

## 3. Components and responsibilities

| Component | Dir | Owns | Does not |
|---|---|---|---|
| **Bot runtime** | `src/bot` | Mineflayer connection, version pin, plugin loading (auto-eat, armor-manager, collectblock, pvp), reconnect, process lifecycle, localhost control endpoint | decide anything |
| **Navigator** | `src/nav` | The only code that calls the pathfinder. Goals, dimension movement profiles, stuck/hazard detection during movement, the unreachable-target blacklist, long-range waypointing | choose destinations |
| **Observer** | `src/observer` | Builds `WorldState` from Mineflayer, the event bus, `WorldMemory` (known locations, explored chunks, death points), block-interest index, `StateDigest` projection | judge progress or act |
| **Skills** | `src/skills` | Skill registry, `SkillRunner` (timeouts, abort, stall detection, logging), all skill implementations, `obtain` item-dependency resolver | choose which objective to pursue |
| **Controller** | `src/controller` | Main loop and arbitration: survival interrupts > maintenance > objective. Starts and cancels skills and routes results to Recovery | pick objectives or classify failures |
| **Planner** | `src/planner` | Milestone predicates, `ProgressionPolicy` (state → objective), strategy catalog and ordering, `Reasoner` interface, provider adapters, prompt templates | execute or recover |
| **Recovery** | `src/recovery` | Failure classification and signatures, the escalation ladder, retry/blacklist bookkeeping, death handling, terminate decision | pick normal objectives |
| **Telemetry** | `src/telemetry` | Persisting events, traces, snapshots, failure bundles, screenshots and `summary.json` into `RUN_DIR` | build state |
| **Evaluator** | `src/evaluation` | Seeds, server lifecycle, batches, ground truth, fixture scenarios, aggregate reports, `inspect` CLI | run inside the bot |
| **Schemas** | `src/schema` | Shared zod schemas and TS types: `WorldState`, `StateDigest`, events, `SkillResult`, `Failure`, `DecisionRequest`/`Response`, `RunSummary` | contain logic |

Dependency direction, with no cycles: `controller → planner, recovery, skills → nav, observer → bot`. `telemetry` subscribes to the event bus. `planner` and `recovery` read `observer` state but never touch `bot` or `nav`. `evaluation` only knows the bot as a child process plus the files it writes.

## 4. Runtime control flow

### 4.1 What runs where

| Cadence | What | Model? |
|---|---|---|
| Every physics tick (50 ms) | Mineflayer physics, pathfinder, pvp, auto-eat, armor-manager, nav stuck sampler | no |
| Mineflayer events | Observer updates (health, inventory, entity, block, dimension, death); events go on the bus | no |
| **Controller tick (every 5 ticks, 250 ms)** | Hazard scan → interrupt check → active-skill watchdog (timeout/stall) → start the next skill if idle | no |
| 1 Hz | Trace sample to disk; milestone predicate evaluation; memory upkeep (location decay, blacklist expiry) | no |
| Skill end / milestone change / death / dimension change | Planner picks the next objective; Recovery handles failures | only via the gate (§5.4) |
| Escalation L4, strategy exhaustion, ambiguous choice | `Reasoner.decide()`, async, while the bot sits in `holdSafe` | **yes** |

### 4.2 Controller loop (per controller tick)

```text
state = observer.state()
1. interrupt = interrupts.highest(state)          // P0 emergency, P1 threat, P2 maintenance
   if interrupt and interrupt.priority > active.priority:
        runner.cancel(active, reason='preempted')  // abort signal, onCancel cleanup
        runner.start(interrupt.skill)              // survival skills never fail upward; they end
        return
2. if active running: runner.watchdog(active)      // timeout → TIMEOUT, no progress → STALLED
   return
3. if last result pending:
        if result.status == success → planner.onSuccess(result)
        if failure/timeout           → action = recovery.handle(failure)   // §7
        if cancelled (preempted)     → nothing; objective will be re-issued
4. objective = planner.next(state)                 // deterministic; may enqueue a reasoner call
   if objective == AWAIT_DECISION → runner.start(holdSafe)
   else runner.start(objective.skill, objective.params)
```

Priorities:
- **P0 emergency:** in lava or fire, drowning (air < 5), falling into the void, suffocating. Examples: `escapeLava`, `surfaceForAir`, `extinguish`.
- **P1 threat:** a hostile targeting the bot within 8 blocks, or health ≤ 8 with a threat present. Runs `defend` or `flee`, chosen by a threat score (mob type, count, armor, health).
- **P2 maintenance:** food ≤ 14 with food in inventory (auto-eat covers most of this), inventory full, night without shelter in the Overworld (`shelter`), and nearby drops worth picking up.
- **P3 objective:** the skill chosen by the planner.

An interrupt ends when its condition clears. The objective skill is then **re-issued from scratch**. Because skills are goal-shaped (§6.1), a re-issued skill finds its progress already in the inventory or world.

### 4.3 Skill outcome handling

| Outcome | Controller action |
|---|---|
| `success` | Emit `skill_end`, re-evaluate milestones, then `planner.next()`. Clear the failure counters for that objective. |
| `failure` | `recovery.handle()`. The ladder in §7 returns `retry(params')`, `alternate(strategy)`, `replan`, `ask_reasoner`, or `terminate`. |
| `timeout` | Same as failure with class `SKILL_TIMEOUT`. The runner has already run `onCancel`. |
| `stalled` (no progress heartbeat) | Same as failure with class `STALLED` or `NAV_STUCK`. Evidence includes a local voxel slice. |
| `cancelled` | Preempted by an interrupt or a pause. Not a failure, and nothing is counted. |
| Death (event) | The runner aborts everything and Recovery's death handler runs (§7.4). |

## 5. Planner and reasoner

### 5.1 ProgressionPolicy (deterministic)

`next(state): Objective | AWAIT_DECISION` walks an ordered **requirement list**, AltoClef `BeatMinecraftTask`-style, and returns the first unmet requirement whose preconditions can be met. The list is data, not code branches, and has no coordinates or seed facts:

```text
wood_tools → stone_tools → food_buffer(≥10 cooked) → iron_tools(pick, sword) → bucket
→ iron_armor(partial ok) → shield → flint_and_steel → obsidian(10) | lava_cast → nether_portal
→ enter_nether → fortress_located → blaze_rods(≥7) → ender_pearls(≥14) [barter | endermen]
→ return_overworld → eyes_of_ender(≥14) → stronghold_located → portal_room → end_portal_open
→ enter_end → beds(≥6) → dragon_dead
```

The targets (7 rods, 14 pearls/eyes, 6 beds) live in `config/progression.json`. They are generic margins for breakage and misses, not tuned to any seed.

```ts
type Objective = {
  id: string                    // 'blaze_rods'
  milestone: MilestoneId        // 'C'
  skill: SkillId                // 'collectBlazeRods'
  params: Record<string, unknown>
  strategy: string              // 'fortress_spawner' | ...
  budgetMs: number              // per-objective wall budget (milestone watchdog)
}
```

The **strategy catalog** gives each objective an ordered list of strategies. Each strategy has an applicability predicate and a cost estimate. For example:
- `ender_pearls`: `[barter_gold (if bastion known & gold ≥ 32), hunt_endermen, barter_gold]`
- `obsidian`: `[lava_cast (bucket + lava pool known), mine_diamond_pick]`
- `fortress_located`: `[axis_sweep, spiral_explore]`

The policy uses the first applicable strategy that hasn't been exhausted. **Ambiguity** is flagged when two applicable strategies' cost estimates are within 20%, or when none is applicable. Only in that case does it return `AWAIT_DECISION` (if a reasoner is enabled). Otherwise it picks deterministically.

### 5.2 Reasoner interface (model-agnostic)

```ts
interface Reasoner { decide(req: DecisionRequest, signal: AbortSignal): Promise<DecisionResponse> }

type DecisionKind = 'select_objective' | 'choose_strategy' | 'diagnose_failure'
                  | 'choose_recovery' | 'propose_skill_change'

type DecisionRequest = {
  id: string; kind: DecisionKind; trigger: TriggerReason   // why this call happened
  digest: StateDigest                                    // §8.2, ≤ ~1.5k tokens
  objective?: Objective
  failure?: FailureRecord                                // class, signature, ladder history
  attempts: AttemptSummary[]                             // ≤ 10 for this objective, newest first
  options: DecisionOption[]                              // whitelist; empty only for propose_skill_change
  image?: ArtifactRef                                    // diagnose_failure only, if provider supports images
}
type DecisionOption = { id: string; label: string; detail: string;
                        paramsSchema?: JSONSchema; estCost?: string; priorFailures: number }

type DecisionResponse = {
  choice: string | null           // must be an options[].id; null = "no good option"
  params?: unknown                // validated against the option's paramsSchema
  confidence: number              // 0..1, self-reported
  diagnosis?: { failureClass: FailureClass; hypothesis: string; evidence: string[] }
  proposal?: { skill: SkillId; change: string; rationale: string }   // never applied at runtime
  rationale: string               // ≤ 600 chars, logged
}
```

Implementations:
- `NoneReasoner` returns the policy's default (the first option). It is the default and needs no API key.
- `ScriptedReasoner` replays canned responses for tests.
- `ModelReasoner` renders a provider-neutral prompt from `src/planner/prompts/`, calls a `ModelClient`, parses the JSON and validates it with zod.

```ts
interface ModelClient {
  readonly id: string; readonly supportsImages: boolean
  completeJSON(p: { system: string; user: string; schema: JSONSchema; image?: Buffer;
                    maxTokens: number; signal: AbortSignal }): Promise<{ json: unknown; usage: Usage }>
}
```

Provider adapters (`anthropic`, and later `openai`) implement only `ModelClient`, in `src/planner/providers/`. Nothing outside that directory imports a vendor SDK. The model id comes from config (`REASONER_MODEL`).

### 5.3 Response handling
- **Invalid JSON, a choice not in `options`, or params that fail the schema:** retry once with the validation error appended, then fall back to the deterministic default. Count it as `reasoner_invalid`.
- **`confidence < 0.5`:** use the deterministic default unless the default is already exhausted for this signature. In that case take the model's choice. Always log both.
- **`choice = null` on a recovery decision:** treated as a vote to terminate. Recovery terminates only if the ladder is also exhausted.
- **Timeout** (default 90 s) or a provider error: deterministic fallback. The bot keeps running `holdSafe`, which still gets interrupts.
- **`propose_skill_change` and `diagnosis`:** written to `RUN_DIR/proposals.jsonl` for the developer agent. They are never executed.

### 5.4 Call gate (avoiding excessive calls)

`ReasonerGate` is the only path to `Reasoner.decide`. Allowed triggers:

| Trigger | Kind |
|---|---|
| Recovery ladder reached L4 (§7.2) | `choose_recovery` (+ `diagnosis`) |
| Strategy exhausted for an objective, with others still applicable | `choose_strategy` |
| Policy flagged ambiguity | `choose_strategy` / `select_objective` |
| Same failure signature seen ≥ 3 times across objectives | `diagnose_failure` |
| Before a terminate decision | `choose_recovery` (last chance) |

Limits (config defaults):
- 30 calls per run, 8 per milestone
- at most 1 call per 60 s, except for the pre-terminate call
- responses cached by `(kind, signature, milestone)` for the rest of the run, so an identical question is never asked twice

When the budget is exhausted the gate returns the deterministic default and emits `reasoner_skipped{reason:'budget'}`. Every call logs trigger, kind, latency, tokens, choice, confidence and whether it was accepted.

Offline, **developer-agent diagnosis** (Opus/Codex reading run artifacts) is separate from the runtime reasoner. It needs no runtime hooks beyond the artifacts in §9.

## 6. Skill system

### 6.1 Levels

| Level | What | Examples | Called by |
|---|---|---|---|
| **Primitives** (`ctx.act`) | Thin wrappers over Mineflayer and the Navigator. Each one adds abort, timeout and event logging. Not skills and not registered. | `goto`, `dig`, `place`, `equip`, `craftOnce`, `activate`, `attack`, `useItem`, `openContainer`, `toss` | skills only |
| **Generic skills** | Reusable and parameterized over items, blocks and mobs | `navigate`, `explore`, `collect`, `craft`, `smelt`, `obtain`, `killMob`, `defend`, `flee`, `eat`, `shelter`, `pickupDrops`, `holdSafe` | controller, other skills |
| **Progression skills** | Game-stage procedures built from generic skills | `buildNetherPortal`, `findFortress`, `collectBlazeRods`, `barterPearls`, `huntEndermen`, `locateStronghold`, `enterStrongholdPortal`, `killDragon` | controller (via planner) |

`obtain(item, count)` is the recursive resolver. It maps an item to an acquisition method from a data table (`src/skills/sources.ts`): craft (recipe tree, via mineflayer-crafting-util or a small resolver), smelt, mine a block, kill a mob, barter, or pick up. The planner asks for *what* is needed and `obtain` works out *how*. The planner never does item recursion.

### 6.2 Contract

```ts
interface SkillDef<P, O = unknown> {
  id: SkillId
  level: 'generic' | 'progression' | 'survival'
  params: ZodSchema<P>
  isSatisfied?(s: WorldState, p: P): boolean        // goal already met → immediate success
  preconditions(s: WorldState, p: P): { ok: true } | { ok: false; missing: Requirement[] }
  timeoutMs(s: WorldState, p: P): number            // hard budget; child budgets ≤ parent remaining
  stallMs: number                                   // max time without ctx.progress()
  run(ctx: SkillCtx, p: P): Promise<O>              // throw SkillFailure(class, reason, detail)
  onCancel?(ctx: SkillCtx): Promise<void>           // stop nav, clear control states, close windows
  localRecovery?: Partial<Record<FailureClass, LocalRecovery[]>>   // ladder L1, ordered
}

interface SkillCtx {
  bot; act; nav: Navigator; state(): WorldState; memory: WorldMemory
  signal: AbortSignal; log(ev): void; progress(metric: string, value: number): void
  run<Q>(child: SkillId, p: Q): Promise<SkillResult>   // nested, depth ≤ 4, shares abort
  capture(label: string): void                          // request screenshot + snapshot
}

type SkillResult = {
  skill: SkillId; params: unknown; status: 'success'|'failure'|'timeout'|'stalled'|'cancelled'
  failure?: Failure; outputs?: unknown
  metrics: { durationMs: number; navCalls: number; navFailures: number; localRecoveries: number }
  evidence: ArtifactRef[]
}
type Failure = { class: FailureClass; reason: string; detail: Record<string, unknown>;
                 missing?: Requirement[]; signature: string }
```

Rules:
- A skill never calls the reasoner, never picks another objective and never catches `AbortError`.
- If preconditions fail, the result is `failure/MISSING_RESOURCE` (or `PRECONDITION_FAILED`) with `missing` filled in. The planner then turns `missing` into a sub-objective through `obtain`, capped at 3 levels deep.
- **Progress heartbeat:** skills call `ctx.progress()` when a measurable quantity improves, such as items gained, distance to target or search area covered. The runner fails with `STALLED` if nothing improves for `stallMs`.
- **Cancellation:** the runner aborts the signal, awaits `onCancel` (max 2 s), and then force-clears Mineflayer control states and `pathfinder.stop()`.
- **Logging:** the runner emits `skill_start{skill, params, depth}` and `skill_end{result}`. Skills only log domain events (`location_discovered`, `barter_result`, ...).

### 6.3 Representative skills (contracts only)

| Skill | Params | Success | Typical failures | Timeout |
|---|---|---|---|---|
| `navigate` | `goal: NavGoal, profile` | within goal range | NAV_STUCK, NAV_UNREACHABLE, NAV_HAZARD | 20 s + 1.5 s/block |
| `explore` | `pattern: spiral\|axis, until: Predicate, maxRadius` | predicate true (e.g. block kind seen) | SEARCH_EXHAUSTED, NAV_* | from maxRadius |
| `collect` | `block\|entity, count, maxDist` | inventory +count | NOT_FOUND, NAV_*, MISSING_RESOURCE (tool) | 60 s + 15 s/item |
| `craft` | `item, count` | inventory has count | MISSING_RESOURCE, STATE_INCONSISTENT | 30 s |
| `smelt` | `input, count, fuel?` | output in inventory | MISSING_RESOURCE (fuel/furnace) | 15 s + 11 s/item |
| `obtain` | `item, count` | inventory has count | whatever its children return | sum of children, capped |
| `defend` / `flee` | `threat` | threat gone or distance > 24 | COMBAT_DANGER (health ≤ 6 while fighting) | 45 s |
| `buildNetherPortal` | `method: lava_cast\|obsidian` | lit portal within 4 blocks, location stored | MISSING_RESOURCE, NOT_FOUND (lava), STATE_INCONSISTENT | 6 min |
| `findFortress` | `strategy` | nether bricks in loaded chunks, location stored | SEARCH_EXHAUSTED, NAV_HAZARD | 12 min |
| `collectBlazeRods` | `count` | rods ≥ count | COMBAT_DANGER, NOT_FOUND (spawner) | 12 min |
| `barterPearls` | `count, goldBudget` | pearls ≥ count | MISSING_RESOURCE (gold), NOT_FOUND (piglins), COMBAT_DANGER | 10 min |
| `locateStronghold` | — | `stronghold_est` stored from 2 eye throws ≥ 200 blocks apart with crossing angle ≥ 10° | STATE_INCONSISTENT (eye not tracked), MISSING_RESOURCE | 10 min + travel |
| `enterStrongholdPortal` | `estimate` | in End | SEARCH_EXHAUSTED (frame not seen), MISSING_RESOURCE (eyes) | 15 min |
| `killDragon` | `strategy: bed_perch\|melee_perch` | dragon entity dead, or exit-portal activation observed | DEATH, COMBAT_DANGER, MISSING_RESOURCE (beds) | 20 min |

## 7. Failure and recovery

### 7.1 Failure classes

| Class | Meaning / detector |
|---|---|
| `NAV_STUCK` | Moving but < 0.5 blocks displacement in 5 s, or no distance improvement in 20 s |
| `NAV_UNREACHABLE` | Pathfinder rejects the goal (no path) or repeatedly returns partial paths |
| `NAV_HAZARD` | Nav aborted because the path would cross lava, fire or a fall > 4 without water |
| `NOT_FOUND` | Target block or entity not in the interest index within search radius |
| `SEARCH_EXHAUSTED` | Structure or explore search covered `maxRadius` or its time without success |
| `MISSING_RESOURCE` | A precondition lacks an item, tool or fuel (`missing` filled in) |
| `PRECONDITION_FAILED` | A non-item precondition, e.g. wrong dimension |
| `COMBAT_DANGER` | Health or threat score crossed the retreat threshold during a skill |
| `STATE_INCONSISTENT` | Inventory or window desync, action rejected by the server, expected block change missing |
| `SKILL_TIMEOUT` / `STALLED` | Runner watchdogs |
| `DEATH` | `death` event |
| `STRATEGY_EXHAUSTED` | Every strategy for the objective has hit its failure limit (produced by Recovery) |
| `INFRA` | Disconnect, kick, server crash, uncaught exception |

**Signature:** `class|skill|objective|dimension|detailKey`, where `detailKey` is e.g. `target=blaze` or `terrain=lava_lake`. It carries no coordinates and is used to count and dedupe.

### 7.2 Escalation ladder (owned by `recovery`)

```text
L1 local       skill.localRecovery[class] inside the skill (jump/back off/dig out,
               close windows + resync, re-pick nearest target)           ≤ 3 per skill run
L2 retry       same skill, varied params: blacklist target 10 min, widen radius,
               relocate 32–64 blocks, switch nav profile                   ≤ 2 per objective+signature
L3 alternate   next strategy in catalog; or re-plan (planner.next with the failed
               objective suspended for 5 min)                              per catalog
L4 reasoner    gate-permitting: diagnose + choose from a recovery menu
               {retry variant, alternate strategy X, relocate, rebuild prerequisite,
                reset to safe base, abandon objective, terminate}
L5 terminate   STRATEGY_EXHAUSTED at a required objective with no L4 answer, or
               death limit, or INFRA not recovered after 2 reconnects
```

Special cases:
- `COMBAT_DANGER` goes straight to the P1 interrupt (`flee`, then `eat`, then `shelter`) and then L2. It is not escalated until it repeats.
- `MISSING_RESOURCE` is not a real failure. The planner inserts an `obtain` sub-objective. It only escalates if `obtain` itself fails.
- `STATE_INCONSISTENT` always runs a resync first: close windows, wait 1 s, compare inventory. If the error persists, reconnect once.
- **Milestone watchdog:** each milestone has a time budget (config). When exceeded, Recovery raises `STALLED` at the milestone level, which starts at L3.

### 7.3 Terminate criteria
The run ends with outcome `unrecoverable` when L5 is reached. It ends with `death_limit` after 5 deaths, and with `timeout` when the evaluator's wall clock expires. Recovery writes the final failure bundle before exiting with code 3.

### 7.4 Death handling
1. A death bundle is captured (§9), including damage events from the last 60 s.
2. After respawn, the memory of the death point, what was lost and its dimension is kept.
3. If the death point is in the Overworld, within 300 blocks, reachable, and less than 4 minutes old (before despawn), the bot runs `recoverItems`. Otherwise it skips that step.
4. The planner resumes from the actual inventory. Milestone predicates are state-based, so the lost progress is simply re-planned.
5. Two deaths with the same signature count as a repeated failure and trigger the gate's `diagnose_failure`.

## 8. State representation

### 8.1 WorldState (in-memory, for skills and the controller)

```ts
type WorldState = {
  t: number; tick: number; dim: 'overworld' | 'the_nether' | 'the_end'
  pos: Vec3; yawPitch: [number, number]; onGround: boolean; inLiquid: 'none'|'water'|'lava'
  vitals: { health: number; food: number; saturation: number; air: number;
            effects: string[]; onFire: boolean; timeOfDay: number; isRaining: boolean }
  inventory: Record<string, number>; hotbar: (string | null)[]; freeSlots: number
  equipment: { head, chest, legs, feet, mainHand, offHand: string | null }
  nearby: { entities: EntityInfo[]; interestBlocks: Record<string, Vec3[]>; hazards: Hazard[] }
  memory: WorldMemory
  control: { objective?: Objective; skillStack: { skill: SkillId; startedAt: number }[];
             interrupt?: string; recovery?: RecoveryState }
  milestones: Record<MilestoneFlag, number | null>   // first-reached timestamp
  counters: { deaths: number; reasonerCalls: number; failuresBySignature: Record<string, number> }
}
type WorldMemory = {
  locations: { kind: LocationKind; dim: Dim; pos: Vec3; confidence: number;
               source: 'observed'|'triangulated'|'built'; lastSeen: number }[]
  explored: Record<Dim, Set<ChunkKey>>        // chunks the bot has seen loaded
  blacklist: { key: string; until: number; reason: string }[]
  deaths: { pos: Vec3; dim: Dim; t: number; lost: Record<string, number> }[]
  eyeThrows: { from: Vec3; dir: Vec3; t: number }[]
}
```

`LocationKind`: `spawn`, `bed`, `crafting_table`, `furnace`, `chest`, `lava_pool`, `village`, `portal_ow`, `portal_nether`, `fortress`, `blaze_spawner`, `bastion`, `stronghold_est`, `end_portal`, `death`.

The **interest index** is maintained by the observer. It holds a set of block names, and the set is the union of a base list (lava, obsidian, logs, ores, nether_bricks, end_portal_frame, ...) and whatever the active objective declares. The index is updated on `chunkColumnLoad` and on block updates. It keeps the nearest 16 positions per kind. Raw chunk data never leaves Mineflayer.

**Milestone flags** are pure predicates over `WorldState` in `src/planner/milestones.ts`, evaluated at 1 Hz. The first transition emits a `milestone` event. Examples: `has_iron_pick`, `nether_ready`, `in_nether`, `fortress_found`, `rods_7`, `pearls_14`, `eyes_14`, `stronghold_located`, `in_end`, `dragon_dead`.

### 8.2 StateDigest (model context and logs)

A deterministic projection with hard caps. It is written to every `skill_end`, failure bundle and `DecisionRequest`:

```json
{
  "t": 1834.2, "dim": "the_nether", "pos": [112, 71, -40], "biome": "nether_wastes",
  "vitals": {"hp": 14, "food": 17, "air": 300, "effects": [], "armor": "iron×3,gold_boots"},
  "inv": {"blaze_rod": 3, "cooked_beef": 11, "cobblestone": 94, "gold_ingot": 12, "...": "≤25 kinds"},
  "tools": ["iron_pickaxe(80%)", "iron_sword", "shield", "bow", "arrow×24", "flint_and_steel", "water_bucket"],
  "objective": {"id": "blaze_rods", "strategy": "fortress_spawner", "milestone": "C", "elapsedS": 312},
  "milestones": {"reached": ["A", "B"], "flags": ["fortress_found", "in_nether"]},
  "locations": [{"kind": "portal_nether", "dist": 140, "dir": "S"}, {"kind": "blaze_spawner", "dist": 22, "dir": "E"}],
  "nearby": {"hostile": ["blaze×2@9", "wither_skeleton@14"], "hazards": ["lava@3 below"], "blocks": {"nether_bricks": 4}},
  "activeSkill": "collectBlazeRods>killMob",
  "recent": ["killMob blaze ok 18s", "hp 20→9 from blaze fireball", "flee ok", "eat ok"],
  "failures": {"current": "COMBAT_DANGER|collectBlazeRods|...", "ladder": "L2", "countThisObjective": 2},
  "deaths": 1, "reasonerCallsLeft": 24
}
```

Caps: 25 inventory kinds, 8 nearby entities, 12 locations (relative distance and direction, plus absolute position), 20 recent events (coalesced), 10 attempt summaries. It is about 1–1.5k tokens.

## 9. Observation and telemetry

**Event record** (`events.jsonl`): `{ t, tick, type, sev, data }`. Types:
- Run and bot lifecycle: `run_start`, `spawn`, `death`, `respawn`, `dimension_change`
- Skills and navigation: `skill_start`, `skill_end`, `nav_start`, `nav_end`, `stuck_detected`
- Control: `interrupt_start`, `interrupt_end`, `milestone`
- Game observations: `damage`, `item_delta` (coalesced per 5 s), `location_discovered`
- Failure handling: `failure`, `recovery_step`, `reasoner_call`, `reasoner_result`, `reasoner_skipped`
- Other: `inventory_desync`, `chat`, `disconnect`, `intervention`, `capture`

**Recent-event summary:** a ring buffer of the last 200 events. The digest's `recent` list keeps `sev ≥ info`, drops nav and item micro-events, and coalesces repeats ("collected 12 oak_log in 40 s").

| When | Captured (in `RUN_DIR`) |
|---|---|
| Continuously | `events.jsonl` (all events); `trace.jsonl` at 1 Hz (`t, dim, pos, hp, food, skill`) |
| Every skill end, every 60 s | `state.jsonl` gets a `StateDigest` |
| Milestone transition | `snapshots/<milestone>.json` (full `WorldState` minus sets > 1k entries) plus a screenshot if the viewer is available |
| Failure at L2 or above | `failures/<n>-<class>/`: `state.json`, `digest.json`, `events_tail.jsonl` (last 200), `trace_tail.jsonl` (last 120 s), `skill_stack.json`, `nav.json` (goal, last path, replans, blacklist), `voxels.json` (13×7×13 block names around the bot), `shot_fp.png` + `shot_tp.png` (optional) |
| Death | same bundle under `failures/<n>-DEATH/` plus the damage log; the evaluator adds the server death message from ground truth |
| Timeout / stuck | same bundle, with `trace_tail` extended to 300 s |
| Run end | `summary.json` (evaluation.md §4), `reasoner.jsonl` (full request/response pairs), `proposals.jsonl` |

The **voxel slice** is the main nav-diagnosis artifact. It is structured, cheap, and readable by a coding agent without images.

**Screenshots:** prismarine-viewer in headless mode, loaded lazily as an `optionalDependency`, capturing one frame on demand from a first-person and a 3rd-person (8 blocks back, 4 up) camera. Capture failures are logged and never fatal. There is no continuous video by default. `--video` enables a rolling 60 s buffer for debugging sessions only. `--viewer` starts the browser viewer for humans.

**Control endpoint** (localhost, off in scored runs unless read-only):
- `GET /state`, `GET /digest`, `GET /events?since=`
- `POST /capture`
- `POST /pause` and `POST /resume`, which run `holdSafe` and log an `intervention` event that invalidates the run for scoring

## 10. Navigator

```ts
interface Navigator {
  goto(goal: NavGoal, o: { profile: NavProfile; timeoutMs: number; signal: AbortSignal }): Promise<NavResult>
  stop(): void
}
type NavGoal = { kind: 'block'|'near'|'xz'|'y'|'entity'|'away'; target: Vec3 | number; range?: number }
type NavProfile = 'overworld' | 'overworld_cautious' | 'nether' | 'end' | 'stronghold'
type NavResult = { ok: true; dist: number; ms: number }
               | { ok: false; class: 'NAV_STUCK'|'NAV_UNREACHABLE'|'NAV_HAZARD'|'SKILL_TIMEOUT'|'CANCELLED';
                   detail: { lastPos: Vec3; goal: NavGoal; replans: number; partial: boolean } }
```

- **Profiles** set pathfinder `Movements`: dig and place permissions, scaffolding blocks, liquid cost, blocks to avoid, max drop. For example, `nether` has very high lava cost, bridges with cobblestone/netherrack, never digs down, and avoids soul sand and magma.
- **Long range:** goals more than 96 blocks away are split into waypoints of 64 blocks or less toward the target, so each leg's path search stays inside loaded chunks.
- **Stuck sampler:** runs every 5 ticks and implements the `NAV_STUCK` rule. It tries a built-in unstick sequence first (jump, step back, dig the block at head height) before returning failure.
- **Unreachable blacklist:** targets that returned `NAV_UNREACHABLE` are blacklisted in `WorldMemory` for 10 minutes.
- **Swap point:** `src/nav/pathfinder.ts` is the only file importing mineflayer-pathfinder. A `baritone.ts` implementation can replace it without touching callers.

### 10.1 Navigation hardening (post-M0)

Everything below lives in `src/nav` and is pathfinder-agnostic unless noted. Callers still see only `goto`, `stop`, `budgetMs` and `recent`.

- **Strategy selection (`underground.ts`).** `goto` uses **controlled excavation** instead of pathfinder search for `y` goals at least 5 below the feet, and for `near`/`block` targets that are covered (≥ 2 solid non-tree blocks above) and either ≥ 5 below the feet or reached from a covered position. Everything else uses the pathfinder. `NavDiag.strategy` records which one ran. `budgetMs(goal)` is strategy-aware (excavation: 20 s + 4 s per block of vertical plus Manhattan work).
- **Controlled excavation (`excavate.ts`).** This is a deterministic local planner. Each step is one of the following, chosen greedily by `distance + 0.34 × blocks dug + 0.5 × fall`:
  - a verified dig-down;
  - a staircase step (3 blocks);
  - a 2-high tunnel step;
  - a stair-up step.

  Every candidate is rejected if any block it opens has lava or water beside it, if the landing is more than 3 blocks down or sits on lava or magma, if the standing space touches lava, if a block is unbreakable or impractical to dig (> 3 s), or if it revisits a cell. Blocks that need a pickaxe fail as `MISSING_RESOURCE` with `missing: wooden_pickaxe`, and so does starting without a pickaxe. Excavation never starts in or beside water: it first walks to the nearest dry cell (`dryStart`). The dug staircase or tunnel is the return path (verified by a scenario test: the pathfinder walks back out). Progress and failures are structured: `excavation {steps, dug, falls, byKind, entry, lastBlocked}` and `reason`.
- **Water model (in `pathfinder.ts`, Movements overrides).**
  - Kelp, seagrass and bubble columns count as water. Upstream treats them as walkable air and plans sea-floor routes.
  - No search node may have its head under water, and a submerged node can only move up.
  - Entering water lands on the surface cell. Upstream lands one block under it.
  - From deep water the bot can climb onto a flush shore. Upstream's jump-up height check rejects every such exit.
  - Pathfinder never digs straight down.
- **Water runtime (`pathfinder.ts`, `water.ts`).**
  - Air is read from the bot's own `air_supply` metadata (`observer/vitals.ts`). Mineflayer's `oxygenLevel` is overwritten by other entities' metadata.
  - The bot surfaces proactively when its head has been under water for 2.5 s or air drops below 14/20. Under an overhang it swims along the shortest water route to open air (`routeToAir`).
  - When the bot stalls in water, it goes to the best shoreline exit (`findWaterExits`): flush exits first, then a 1-block ledge whose lip it digs while afloat. Client physics cannot climb a 1-block ledge from water, and pathfinder only digs on ground.
  - After 3 failed exits the call returns `NAV_HAZARD`.
  - A planned swim longer than 40 nodes triggers one replan with a strong dry-land preference. Bridging with scaffold blocks is cheaper than swimming.
- **Physics robustness.**
  - `physics-epsilon.ts` adds vanilla's 1e-7 tolerance to prismarine-physics collision. Without it, float error lets the client box clip into a flush wall, and the server rejects every move (the M0 rubber-band loop).
  - A server-correction-loop detector (≥ 8 corrections in 1.5 s) re-centres the bot in its cell.
- **Tests.** Pure planners have unit tests (`tests/unit/nav-*.test.ts`). `npm run test:scenario` builds water and underground fixtures on a real flat server (`tests/scenario/`); these runs are labeled fixtures and never scored.

## 11. Repository layout

```text
src/
  schema/       zod schemas + TS types shared by all modules
  bot/          mineflayer connect, plugins, control endpoint, entry point (main.ts)
  nav/          Navigator interface, pathfinder impl, profiles, stuck sampler
  observer/     WorldState builder, event bus, WorldMemory, interest index, digest
  skills/       runner, registry, sources.ts (obtain table), generic/, progression/, survival/
  controller/   main loop, interrupts
  planner/      milestones, policy, strategies, reasoner/ gate, prompts/, providers/
  recovery/     classify, signatures, ladder, death handler
  telemetry/    writers, bundles, screenshots (optional viewer)
  evaluation/   evaluator, server (minecraft-wrap), seeds, ground truth, fixtures, report, inspect CLI
config/         progression.json, eval profiles (timeouts, budgets, server.properties template)
patches/        patch-package patches for pathfinder etc.
tests/
  unit/         pure logic: policy, milestones, obtain resolution, ladder, digest caps, gate budgets
  scenario/     real server fixture scenarios per skill (labeled fixtures, never scored)
  fixtures/     recorded WorldState/digest JSON for planner/recovery tests
docs/  runs/
```

Each directory owns a single entry in §3. `config/` is data only, and `patches/` is required by the pathfinder pin.

Tooling choices that close the "vitest or node:test" question from proposed-stack.md:
- **vitest** for tests.
- **zod** for schemas. zod is MIT and widely maintained, but it is a new dependency, so audit it at M0 install per AGENTS.md.
- **tsx** to run the code.
- **Scenario tests** run against a real server started by the evaluator's server module, and are tagged so `npm test` skips them by default.

## 12. Technical risk review

| Risk | Where it hits | Mitigation | When |
|---|---|---|---|
| **Pathfinding reliability** (caves, water, lava, stuck loops) | every milestone; the most likely leading failure | Single Navigator with profiles, stuck sampler and blacklist; Mindcraft's pathfinder patches; `voxels.json` in every nav failure; **navigation benchmark** on fresh seeds before milestone A work; baritone fallback behind the adapter | **Now** (M0) |
| **Structure search** (fortress, bastion, stronghold) | C, D | Detection only through blocks in loaded chunks (nether_bricks, polished_blackstone_bricks, end_portal_frame); systematic `axis_sweep`/spiral with an explored-chunk set; alternate pearl source (endermen) if no bastion; eye triangulation with 2 throws ≥ 200 blocks apart; stronghold dig-in allowed (pathfinder digs through stone bricks) | Design now, build in C/D |
| **Nether traversal** (lava lakes, ghasts, piglins, falls) | B, C | `nether` profile (bridge, no dig-down, high lava cost); gold armor piece before entry; fire-resistance not assumed; `portal_nether` memory for return; relight or rebuild portal (carry flint and steel and spare obsidian if possible); ghast → `flee` behind a block | B |
| **Combat** (blazes, wither skeletons, endermen, dragon) | A, C, E | Threat score and P1 interrupt; shield and iron armor as prerequisites; blaze fights from cover at spawner range; enderman hunting only with a pumpkin or when looking at the feet; bed-perch dragon strategy (no aiming); stay-alive thresholds in config | Basic in A; specialised in C/E |
| **Stronghold navigation** | D | Once frames are in view distance, `goto` with the `stronghold` profile, digging through walls; silverfish is a P1 threat; fill frames from inventory and verify the portal-open block update | D |
| **Model integration** (latency, invalid output, vendor lock) | any | Menu-only decisions, zod validation, one retry, deterministic fallback, `holdSafe` while waiting, `ModelClient` as the only vendor boundary, `ScriptedReasoner` for tests | Interface now; real provider after A |
| **Excessive context or model use** | cost, latency | Digest caps (~1.5k tokens), gate budgets and cache, image only for `diagnose_failure`; `reasoner_calls` is a first-class evaluation metric | Now |
| **Version/plugin incompatibility** | all | Exact pins (1.21.4 everywhere), lockfile, pathfinder commit plus patches, pvp vendoring check at install, viewer optional; nav benchmark reruns on any bump | Now (M0) |
| **Physics divergence** (prismarine-physics vs vanilla) | nav, combat | Tolerate `forcedMove`, count position corrections in telemetry, report them as `STATE_INCONSISTENT` detail | Now (telemetry only) |
| **Long run time** (evaluation throughput) | all gates | Parallel servers on separate ports; per-milestone stage metrics; fixture scenarios for late-stage development (never scored) | M0 harness; parallelism when runs exceed 1 h |

## 13. Design checks

- **Overlaps:** decision owners are unique (§3):
  - Objectives are chosen by the planner, and item dependencies are resolved by `obtain`.
  - Preemption is decided by the controller, and failure handling by recovery.
  - Persistence belongs to telemetry and state building to the observer.
  - Milestone predicates live only in the planner.
- **No LLM in continuous play:** every per-tick and per-controller-tick path is deterministic. The reasoner is only reachable through the gate and is capped at 30 calls per run.
- **Swappable providers:** vendor SDKs are imported only in `src/planner/providers/`. `NoneReasoner` is the default.
- **Diagnosability:** every L2+ failure, death and timeout produces a bundle with state, events, trace, skill stack, nav detail and a voxel slice. Batch reports index them by signature (evaluation.md §5).
- **Full-game capable:** the requirement list and strategy catalog already run to `dragon_dead`. Later milestones add progression skills and catalog entries, not new components.
- **Size:** ten small modules. Everything mechanical is reused per proposed-stack.md.

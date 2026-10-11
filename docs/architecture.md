# Architecture

Phase 2 design for the stack chosen in [proposed-stack.md](proposed-stack.md): headless Mineflayer bot on a vanilla Minecraft Java Edition **1.16.1** server (run on Java 8), in Node 22 / TypeScript. 1.16.1 is the sole target version; §14 lists the 1.16.1 game facts that later milestones depend on. Milestones are in [milestones.md](milestones.md) and evaluation is in [evaluation.md](evaluation.md).

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
│ Vanilla 1.16.1 (Java 8)   │   │ Bot process (src/bot … src/telemetry)       │
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
→ enter_nether → gold(barter stock) → ender_pearls(≥14) [barter | endermen]
→ fortress_located → blaze_rods(≥7) → return_overworld → eyes_of_ender(≥14)
→ stronghold_located → portal_room → end_portal_open → enter_end → beds(≥6) → dragon_dead
```

The targets (7 rods, 14 pearls/eyes, 6 beds) live in `config/progression.json`, which declares the version it was written for (`mcVersion`, checked against `src/version.ts` by a unit test). The gold stock for bartering is set in milestone C from the measured barter yield (§14.2). They are generic margins for breakage and misses, not tuned to any seed. In 1.16.1, pearls come before blaze rods because bartering is the primary pearl source (§14.2) and it happens wherever piglins are. Both remain one Nether trip.

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
- `ender_pearls`: `[barter_gold (piglins in view & gold ≥ stock), hunt_endermen (warped forest / Overworld nights), barter_gold after restocking]`
- `gold`: `[nether_gold_ore (any pickaxe, 2–6 nuggets each), bastion_loot (gold blocks / chests), overworld_gold_ore (iron pickaxe, smelt)]`
- `obsidian`: `[lava_cast (bucket + lava pool known), complete_ruined_portal (lava cast into the missing frame), mine_diamond_pick]`
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
| `barterPearls` | `count, goldBudget` | pearls ≥ count (1.16.1: ≈ 0.28 pearls per ingot, §14.2) | MISSING_RESOURCE (gold), NOT_FOUND (piglins), COMBAT_DANGER | 10 min |
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
- `STATE_INCONSISTENT` always runs a resync first: close windows, wait 1 s, compare inventory. If the error persists, reconnect once. On 1.16.1 the inventory resync is a server-rejected probe click, which makes the server resend the window (evaluation.md, implementation notes). Mineflayer's built-in sync needs the 1.17.1+ protocol.
- **Milestone watchdog:** each milestone has a time budget (config). When exceeded, Recovery raises `STALLED` at the milestone level, which starts at L3.

### 7.3 Terminate criteria
The run ends with outcome `unrecoverable` when L5 is reached. It ends with `death_limit` after 5 deaths, and with `timeout` when the evaluator's wall clock expires. Recovery writes the final failure bundle before exiting with code 3.

### 7.4 Death handling
1. A death bundle is captured (§9), including damage events from the last 60 s.
2. After respawn, the memory of the death point, what was lost and its dimension is kept.
3. If the death point is in the Overworld, within 300 blocks, reachable, and less than 4 minutes old (before despawn), the bot runs `recoverItems`. Otherwise it skips that step. After a mob death (B round 2, §10D) it also needs high-value items lost, daylight, an uncovered site and at most one melee hostile there.
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

`LocationKind`: `spawn`, `bed`, `crafting_table`, `furnace`, `chest`, `lava_pool`, `village`, `ruined_portal`, `portal_ow`, `portal_nether`, `fortress`, `blaze_spawner`, `bastion`, `stronghold_est`, `end_portal`, `death`.

The **interest index** is maintained by the observer. It holds a set of block names, and the set is the union of a base list and whatever the active objective declares. The base list uses 1.16.1 names: lava, obsidian, logs, ores (no deepslate variants), nether_gold_ore, nether_bricks, polished_blackstone_bricks, gilded_blackstone, end_portal_frame, and so on. The index is updated on `chunkColumnLoad` and on block updates. It keeps the nearest 16 positions per kind. Raw chunk data never leaves Mineflayer.

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

  Every candidate is rejected if any block it opens has lava or water beside it, if the landing is more than 3 blocks down or sits on lava or magma, if the standing space touches lava, if a block is unbreakable or impractical to dig (> 3 s), or if it revisits a cell. Blocks that need a pickaxe fail as `MISSING_RESOURCE` with `missing: wooden_pickaxe`, and so does starting without a pickaxe. Excavation never starts in or beside water. `dryStart` has three distinct outcomes, recorded as `NavDiag.dryStart`:
  - `already_dry`: excavate here;
  - `found`: walk to the nearest dry cell first;
  - `none`: no dry cell within 12 blocks, e.g. open ocean; the call fails at once with `NAV_HAZARD`.

  Before 2026-09-28, `already_dry` and `none` were the same `null`, so excavation started in open water.
- **Falling blocks.** After a step's dig pass, the excavator waits for falling sand or gravel over the step's cells to land. It then re-verifies every cell the step needs open and re-digs refills, up to 5 passes (`excavation.refills`). Before this, a cell read as air while the sand was still falling, the sand landed after the pass, and the bot stood one block above its target. That was the `excavation steps keep failing` signature, reproduced by the sand-layer fixture. The dug staircase or tunnel is the return path (verified by a scenario test: the pathfinder walks back out). Progress and failures are structured: `excavation {steps, dug, falls, byKind, entry, lastBlocked}` and `reason`.
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
- **Perched on a lip.** A hitbox can overlap a neighbouring block by millimetres, so the bot stands on its edge above an open feet cell. Each step's centring move sneaks, and sneaking never leaves an edge, so every step failed. That was the remaining `excavation steps keep failing` signature on 1.16.1 (excavation fixture r01).
  - Centring now sneaks only over a floor.
  - Before planning a step, a perched bot drops into its feet cell if the landing passes the normal landing checks (`excavation.unperched`).
  - Otherwise it plans from the lip without centring.
- **Dig acknowledgements (`src/bot/protocol-fixes.ts`, 1.14–1.18 protocol).** Mineflayer marks a dug block as air as soon as it sends "finish digging", and it ignores the server's `acknowledge_player_digging`.
  - A 1.16 server that counts too few ticks for a dig acks it with the block still present and breaks it later. Too few ticks happens when the server lags or the bot is airborne.
  - If a second early finish arrives while the first break is still pending, the second block is never broken.
  - The client then keeps a ghost air cell, walks into it, and the server silently teleports it back. This was the field signature `excavation steps keep failing` with about 160 corrections, in kit r04.
  - `installDigAck` applies the acknowledged state whenever it differs from the client's, as the vanilla client does, and emits `dig_ack_correction`. A real-server fixture reproduces the ghost block without the fix and passes with it.
- **Version isolation.** Block and item names in `src/nav` are 1.16.1 names. There is no deepslate, powder snow or dripstone; the plant is `grass` and the block `grass_block`. Version facts minecraft-data lacks live in `src/version.ts`.
- **Tests.** Pure planners have unit tests (`tests/unit/nav-*.test.ts`). `npm run test:scenario` runs 23 real-server fixtures on a 1.16.1 flat world (`tests/scenario/`). They cover water entry and exit, kelp and seagrass, surfacing, ledge and flush exits, bridging, a 1-wide staircase (collision epsilon), server-teleport recovery, staircase and tunnel excavation, lava and water pockets, falling sand, the lip case, no-dry-start, the return route, inventory resync and ghost blocks. These runs are labeled fixtures and never scored.

### 10.2 Milestone A safety debts (closed 2026-09-28)

The three open navigation items from the 1.16.1 migration were fixed narrowly, before any progression work:
- **Hazard-aware unstick** (`src/nav/hazards.ts`, `unstickDirections`). A reflex move is only taken in a cardinal direction whose entered cells, jump cell and landing (≤ 3 down) are free of lava, fire, magma and flowing lava beside the body. Forward is preferred on the first attempt and backward on later ones. With no safe direction the bot only jumps in place. The head-height dig never opens a block next to lava or water. Unit-tested with block maps (`tests/unit/nav-hazards.test.ts`).
- **Air reflex in `exitWater`.** Every wait inside a shoreline exit (approach, lip digging, jump-out) checks the head and air supply with the same `needsAir` rule as `runLeg` and surfaces first. If surfacing fails, the exit is abandoned as `NAV_HAZARD` (`cannot surface during water exit`) instead of drowning mid-exit.
- **Independent underground benchmark setup** (`src/controller/navbench.ts`). Before a `cave` or `depth` trial, if no dry excavation start is within reach (`dryStart` = `none`, e.g. the previous surface leg ended in ocean), the bot first walks back to its spawn as a setup move. If that fails, the trial is recorded as `SETUP_FAILED` and is excluded from the rate like `NO_TARGET`.

No new pathfinder evaluation was run. Dev-batch evidence (evaluation.md) did not show navigation as the limiting component.

## 10A. Milestone A implementation (as built)

This section records how §4–§7 were realised for milestone A. It changes no component boundaries.

**Controller** (`src/controller/progression.ts`, `interrupts.ts`). `ProgressionController` is the §4.2 loop.
- The objective skill runs through `runPreemptible`: a 250 ms poll asks `selectInterrupt` and cancels the skill when a strictly higher-priority interrupt appears. The objective is then re-issued from scratch.
- Milestones and funnel flags are checked at 1 Hz. Reaching the target cancels whatever runs.
- Interrupt failures set a per-kind cooldown (for example `defend:<id>` 20 s, after which the same mob gets `flee`). An interrupt that fires more than 25 times in 60 s is throttled for 30 s.
- P0 and P1 interrupt failures are recorded in `failures.jsonl` with ladder level `P0`/`P1`. P2 misses are not.
- The M0 scenario keeps the original `Controller` (scripted reasoner), so the M0 gate code path is unchanged.

**Interrupts** (pure, `selectInterrupt(state)`):
- **P0:** feet or head in lava or fire → `escapeLava` (runs to the nearest `safeCells` cell, preferring higher ground). Head in water with air < 12/20 → `surfaceForAir` (the navigator's `surface()`). Head inside a solid block → `escapeSuffocation`.
- **P1:** the threat score (below) says engage → `defend` or `flee`.
- **P2:**
  - `shelter` at night when there is nothing to fight with and hostiles are within 20;
  - `eat` (food ≤ 14, or health ≤ 14 with food < 18);
  - `equipGear` (better armor, shield to the off-hand);
  - `manageInventory` (≤ 1 free slot: toss junk and surplus);
  - `pickupDrops` for useful items, never bulk blocks while a self-collecting skill runs.
- **Falls.** Fall damage is prevented by movement limits (pathfinder max drop 4, excavation max fall 3, hazard-checked reflex steps). An in-flight water-bucket clutch was not built: it is not needed for the predicate, and dev batch 1 had one fall death in 9.

**Threat score** (`src/skills/survival/threat.ts`). Each 1.16.1 mob has a weight and a range in `version.ts` `MOB_THREATS`:
- Ranged mobs (skeleton, stray, pillager, witch, and drowned holding a trident) count within their range. Melee mobs count within 10 blocks, scaled by distance.
- Neutral mobs count only up close. Spiders count only in the dark. Zombified piglins never count.
- Mobs without line of sight count only within 2.5 blocks. A swelling creeper doubles its weight.
- Capacity is `2.2 × hp/20 × (1 + armor/12) × (weapon dps/8)^1.5 × shield 1.25 × water 0.6`.
- The bot defends when threat ≤ capacity (× 1.6 when the primary threat is explosive) and flees otherwise, or whenever health ≤ 6.
- Bare hands (4 dps) never take on a zombie; a stone sword does.

**Acquisition** (`src/skills/sources.ts`, `generic/obtain.ts`). `planObtain(item, count, inventory, hints)` is a pure, depth-bounded (10), cycle-checked resolver:
- The source table covers craft (minecraft-data recipes, variants normalised to groups: `planks`, `log`, `coal_any`), smelt (`version.ts` `SMELTING`), gather (collect or mine, with the pickaxe tier the block needs), hunt, and fill.
- It simulates the inventory with reservations, so shared inputs are never double-counted, and every step carries an absolute, goal-shaped target.
- All gathers of one material are folded into its first occurrence (one trip).
- Fuel is coal when coal ore is known, else planks (a log burns 1.5 items, its planks 6).

`obtain` runs **the first step only and re-resolves**. World hints change on the way: coal ore seen while mining means coal fuel instead of a surface trip. A broken pickaxe or a lost table simply reappears as a step. Recoverable child failures (`MISSING_RESOURCE`, `STATE_INCONSISTENT`) re-plan up to 4 times. A step that "succeeds" three times without changing the plan is a `STATE_INCONSISTENT` loop. After success, `obtain` digs up a crafting table it placed, so the table is carried into the mine.

**Mining** (`generic/mine.ts`).
- Targets come from the interest index: loaded chunk data, as §8.1 specifies. This includes ores not exposed to air (see the note in milestones.md).
- Candidates are skipped when digging them would open lava or water, and penalised at or below the lava level (y ≤ 10).
- Buried targets are reached by controlled excavation (`NavGoal.mode = 'excavate'`), never by cave pathfinding. Exposed, roughly level ones are reached by walking.
- The bot never digs its own column below its feet. With nothing in range it descends in 8-block excavation steps toward y 16, then tunnels (`Searcher`).
- The first descent is remembered as `mine_entry`. `toSurface` walks back up the dug staircase for surface work (hunting, trees, water).
- Tools: `nav/tools.ts` picks a tool that makes the block drop, never a sword, and charges iron-and-better tools 1.6× so stone pickaxes wear first. A damageable item is unequipped for hand digging.
- A broken pickaxe fails the mine step with `MISSING_RESOURCE`, and `obtain` crafts a replacement (scenario-tested). The policy's mining kit asks for ≥ 250 remaining pickaxe durability and 4 sticks before the iron trip.

**Other generic skills.**
- `smelt`: finds or places a furnace; counts from the furnace window while it is open, because Mineflayer copies the window back into `bot.inventory` only on close; loads the best fuel; resumes from furnace contents; carries the furnace on.
- `hunt`: food animals, never babies (1.16.1 metadata index 15), chase with the navigator's entity goal, collect drops.
- `fillBucket`: an open water source, raytraced by the server from the bot's view.
- `explore` / `relocate`: 48-block surface steps, or 24-block tunnels under cover.
- `findLavaPool`: excavate to y 14 and tunnel until the observer's lava-pool scan (≥ 10 connected source blocks with an open surface) has one.
- `recoverItems`: walks only (`mode 'walk'`).

**ProgressionPolicy** (`planner/policy.ts` `A_REQUIREMENTS`). Data, in order:
- wooden pickaxe, stone pickaxe, stone sword;
- food (met at 10 cooked, obtained to 14);
- mining kit (pickaxe durability, sticks);
- iron ingots (the state-based sum still needed for every unmet iron item: `ironNeed`);
- iron pickaxe, iron sword, shield, iron armor ×2 (helmet and boots, the cheapest pair), water bucket, empty bucket, flint and steel;
- lava pool.

Every entry is an `obtain` call except the lava pool. The first unmet entry whose prerequisites are met and which Recovery has not suspended is the objective. Food is first in the list but not a hard prerequisite of iron: a fruitless hunt that Recovery suspends lets mining proceed.

**Recovery** (`src/recovery/ladder.ts`, `death.ts`). L1 stays inside skills. Per objective and signature:
- `STATE_INCONSISTENT` → resync the inventory, then retry (≤ 2).
- An escaped `MISSING_RESOURCE` → one retry, because obtain re-resolves.
- Movement, search, combat, watchdog and infra classes → retry, then relocate (one search step).
- L3 switches to the `wide` strategy (12 search steps). Once strategies are exhausted, the objective is suspended for 5 min, but only if another objective is available; otherwise the bot relocates.
- An objective over its wall budget goes straight to L3. 14 failures of one objective terminate the run (L5).
- No reasoner is involved (`reasoner=none`).

**Deaths** (§7.4).
- The controller aborts the skill, waits for the death message, writes a `DEATH` bundle, and waits for the respawn.
- It then clears cooldowns, L2 counters, entity tracking, `mob:` blacklists and the skill stack. It keeps locations, explored chunks, other blacklists and death records, which are all knowable.
- `recoverDecision` goes back for the drops only when all of these hold:
  - Overworld, < 240 s old, ≤ 300 blocks away;
  - not a lava or void death;
  - the bot did not die there before;
  - something useful was lost.
- `recoverItems` runs at P2 priority, so the drop-pickup interrupt does not cancel it.
- The policy then re-plans from the actual inventory. An objective whose inputs were lost is never offered.

**Runtime safety nets** (`src/bot`):
- `installRaycastGuard` bounds prismarine-world's raycast iterator. Without it, a non-finite direction spins forever on the event loop.
- `startStallWatch` is a worker thread. If the main thread stops beating for 12 s, it pauses V8 through the inspector and records the stack in `stalls.jsonl`.
- Both were added while diagnosing dev3 disconnects, which turned out to be host sleep. They are kept as diagnostics and never change behaviour.

**Version facts** added to `src/version.ts`: furnace recipes, fuel burn times (nether stems do not burn), tool tiers, gravel flint chance (10 %), monster spawn light ≤ 7, phantom insomnia (72 000 ticks, more than a 45-minute run), night bounds, 1.9+ weapon cooldowns and damage, armor points, the mob threat table, creeper swell and fuse, entity metadata indices, food animals, and unsafe foods.

## 10B. Milestone A survival revision (after gate 20260929)

The A gate failed on surface combat deaths (36 in 20 runs), food search and one spin loop (evaluation.md, gate log). This revision fixes those classes inside the existing components. It adds no component and does not change the gate.

**Objective invariant** (`controller/progression.ts`).
- After every objective success the controller re-checks the requirement that chose it (`RequirementDef.met`). If the requirement is still unmet, it records `OBJECTIVE_NOT_SATISFIED`. The record carries the objective, the requirement's `desc`, the state digest and the prior result.
- The failure goes through Recovery: one retry, then a 5-minute suspension. A wider search cannot fix a mismatch.
- Every loop iteration that returns in under 250 ms (50 ms for interrupts) is followed by a timer pause. A synchronous or microtask-only spin is therefore impossible.
- Identical failure signatures within 30 s share one bundle and back off exponentially through an interruptible `holdSafe`, capped at 30 s.
- Each requirement's objective now asks for exactly what the requirement needs: per-piece armor, and enough stone pickaxes to reach the kit durability. A unit property test checks that every objective's success satisfies its requirement, for every member of a group item.
- Root cause of gate r09: `emergency_food` and the `eat` skill used different food definitions. Both now use `hasEmergencyFood`/`chooseFood`, and raw chicken counts as emergency food.

**Progression order** (`planner/policy.ts`), still data:
- emergency food; wooden pickaxe, stone pickaxe, stone sword;
- **food buffer**: ≥ 3 food items, nearby animals only (2 search steps, bounded);
- **wood kit**: logs for the shield, a crafting table and a margin, carried down;
- mining kit; iron ingots; iron pickaxe, iron sword, shield, iron helmet, iron boots, bucket;
- **cooked-food stock** (≥ 10, obtained to 14), which requires the sword, shield and both armor pieces;
- water bucket, flint and steel, lava pool.

`bounded` requirements keep their own search limits: Recovery's `wide` strategy does not apply to them.

**Day/night schedule** (`controller/schedule.ts`, pure).
- Surface night is time of day 12 000–23 300 in the Overworld.
- An objective's surface kind comes from its resolved `obtain` plan:
  - `hunt`: any hunt step;
  - `short`: logs or filling water;
  - none: mining, smelting, crafting, the lava pool.
- At night, hunting is always deferred. Short surface work is deferred unless the bot is `nightCapable` (iron sword, shield, ≥ 4 armor points). The controller runs the first objective that is not deferred.
- Hunting is deferred at night even for a `nightCapable` bot.
- With none left, the controller runs `shelter` as the objective (dig in, wait for day). A surface objective still running at nightfall is stopped (`schedule` event, `nightfall`) and re-planned.

**Ranged threats** (`skills/survival/cover.ts`, P1 `cover`).
- `assessThreat` returns `cover` whenever a shooter is in sight beyond 4 blocks, whatever the bot's capacity. At ≤ 6 HP it returns `cover` for a shooter in sight at any distance. Shooters are skeleton, stray, pillager, witch, evoker, illusioner, guardian and a drowned holding a trident.
- Shooters are never charged. A shielded-charge exception was tried and removed after dev batch 7, where two fully equipped bots died charging lone skeletons.
- Response, in order:
  1. Existing terrain: the nearest standable, hazard-free cell within 6 blocks that no shooter can see (eye and chest rays through the block view, `findCoverCells`).
  2. A sealed dig-in: `planDigIn`, then `digIn`.
  3. The shield raised toward the nearest shooter, for up to 12 s.
  4. `COMBAT_DANGER`, so the controller falls back to `flee`.
- The bot then holds cover for 8 s, or until the shooters leave range or come into melee range (`defend`).
- Each attempt emits a `cover` event with method and outcome. They are reported apart from flee and defend.

**Sealed dig-in** (shared by `cover` and `shelter`).
- The bot digs the three blocks under a column and re-places the top one against a side wall. That leaves an enclosed 1×2 pocket.
- Every dug block must dig in ≤ 1.6 s with the tools carried, release no liquid, and have solid walls at the bot's feet and head. The floor must be solid and harmless.
- The cap is any carried non-falling block, usually one just dug. The old shelter capped only with a block carried beforehand, so it never capped after a death.
- `body.enclosed` (observer) marks the pocket. While enclosed, P1 does not fire and P2 skips pickup and forage, so nothing pulls the bot out. That was the old shelter's main failure: cancelled 56 of 74 times.
- The pathfinder digs and towers back out; a scenario test verifies this.

**Creepers.** A creeper within 6 blocks (in sight, or within 3 blocks even out of sight) makes the action `flee` with the creeper as the primary threat, whatever the capacity. `defend` hands over when one comes that close.
- With a shield: a **standoff**. The bot faces the creeper with the shield raised until it explodes, leaves beyond 10 blocks, or 8 s pass. In 1.16.1 a shield facing the source blocks explosion damage. This replaced outrunning, because in dev batch 9 creepers followed equipped bots through repeated flee/resume cycles.
- Without a shield: `flee` weights the creeper ×3, runs 14 blocks, and succeeds once the creeper is beyond its 7-block defuse range and not swelling.

**Melee without chases.** `defend` closes in only on melee mobs within 6 blocks; beyond that it waits, facing them, for up to 5 s (they come to the bot). A shooter that backs off beyond 4 blocks is left to `cover`. Chase and walk-mode movements take no parkour jumps and drop at most 3 blocks. In dev batches 7 and 9 two chases ended 14–24 blocks down ravines.

**Sealed pocket hold.** While enclosed with a hostile within 8 blocks, P2 `hold` runs `shelter` (up to 30 s) instead of the objective. A 30 s gap follows each hold. In dev batch 8, a 16-block radius pinned bots for 30 min on mobs in nearby caves.

**Food** (`generic/hunt.ts`, `controller/interrupts.ts`, observer).
- The observer remembers food-animal sightings: 24-block clusters, 12 spots.
- A hunt takes, in order:
  1. a visible or given target;
  2. up to 3 remembered spots (≤ 160 blocks, seen within 10 min; each blacklisted 5 min once visited);
  3. at most `min(searchSteps, 6)` search steps.
- The search budget survives preemption for 10 min and resets on a kill.
- A P2 `forage` interrupt takes one short detour for an adult land food animal within 12 blocks. It needs the surface, daylight, no threat, and cooked plus raw meat under the stock target.
- **Fish.** Cod and salmon are hunt targets after land animals (distance penalty 24). A fish is targeted only when it is within 2 blocks of the water surface, and approached to reach range (2.5). After 3 failed fish chases, a hunt keeps to land animals.
  - Evidence: in 4 of the 6 food-failure runs of dev batches 8–9, land animals were seen 0–66 times and fish 200–990 times.
  - Cooked cod and salmon are furnace outputs, so they count as cooked food.
- The early buffer counts as met once sword, shield and armor are held, so it cannot alternate with the cooked-food stock.
- Hunting is always daytime work. Night hunting for equipped bots was tried after dev batch 6 and reverted after three deaths in dev batches 7 and 9.

**Recovery ladder additions.**
- `persistent` requirements (the three food objectives) never terminate the run. Search failures (`SEARCH_EXHAUSTED`, `NOT_FOUND`) never terminate any objective: "not found yet" is not unrecoverable under a time limit.
- `bounded` requirements (early buffer, emergency food) are suspended at their first search failure instead of retrying and relocating.
- A hunt's search budget resets once the bot is > 96 blocks from where the budget started.

**Other hazards found in dev batches.**
- The navigator skips dry excavation starts it failed to reach, for 5 min.
- `collect` never targets a block with water above it, and never digs with its head under water.
- `placeNear` rejects only lava-adjacent spots. With no free cell it digs a head-level niche, and failing that throws a structured `PRECONDITION_FAILED`.
- `manageInventory` fails when it frees no slot.
- The observer attaches the death message that precedes Mineflayer's death event, so item recovery knows a lava death destroyed the drops.

**Death context.** At each death the controller emits `death_context` from its last snapshot while alive. The snapshot holds weapon, armor, worn pieces, shield, objective, interrupt, skill stack, time of day, nearby hostiles, and any cover attempt in the 20 s before. `inspect batch` adds a survival section built from it (`evaluation/survival-report.ts`). For older runs it derives the same row from the event stream.

## 10C. Milestone B implementation (as built)

B adds progression skills, a navigation profile, observer memory and policy data. It adds no component.

**Observer memory.**
- `WorldMemory.transitions` records every dimension change the client sees (respawn packet): from, to, time, departure position (captured at the respawn packet, before the teleport), arrival position, and cause (`death` if a death preceded it, else `portal`).
- On a portal arrival, the observer remembers the nearest `nether_portal` block as `portal_nether` (or `portal_ow`). It polls loaded chunk data for up to 10 s.
- `WorldMemory.excursions` holds the farthest distance from the arrival portal reached on each Nether visit.
- Per-dimension caches are dropped on every transition.

**Milestone predicates** (`planner/milestones.ts`; exact reading in milestones.md): `portal_built`, `in_nether` (through the built portal), `portal_nether`, `excursion` (≥ 12 blocks this visit), `return_ok` (a portal transition back, after such an entry and excursion), and `B`.

**`buildNetherPortal`** (`skills/progression/portal.ts`, geometry in `portal-plan.ts`, bucket primitives in `buckets.ts`).
- *Strategy* (deterministic, first applicable): `lava_cast` needs a water bucket, an empty or lava bucket and a usable remembered pool. `obsidian` needs ≥ 10 carried obsidian, or a diamond pickaxe and ≥ 10 obsidian blocks in the interest index. Recovery's alternate strategy can narrow the choice.
- *Site.* The frame is a 4 × 5 rectangle with optional corners. Behind the whole rectangle stands a solid back wall: natural rock, or up to 20 placed blocks on open ground. In front is a cleared work area (5 high, then 4 high) with a solid floor. `findSites` scans loaded terrain within 9 blocks of the pool's safe access stand, in 4 orientations and ±2 levels. It rejects any site with:
  - liquid in or beside a cleared cell;
  - a gravity block above a cleared cell;
  - a block slower than 3 s to dig;
  - obsidian outside the frame cells;
  - lava within 4 blocks of the frame or work area.

  Cost is digs + 2 × placements − 0.5 × obsidian already in the frame. Ties break on position, so the choice is deterministic.
- *Bucket aiming.* A bucket is used through the server's raytrace from the player's look: `Item.raycast`, 5 blocks, outline shapes. A full bucket ignores fluids; an empty one stops at the first source. `bucketRay` replicates it client-side. Every use is aimed at a face whose ray lands the fluid in the target cell (`aimPlace`, `aimPickup`), re-checked along the look actually held, and verified from the server's block updates.
- *Lava cast.* Cells are cast top-down: top row, sides downward, bottom row. The cells a ray crosses below its target are therefore never obsidian yet. Per cell:
  1. Fill the empty bucket at a pool stand that keeps a block of distance from every lava cell.
  2. Pour water into a free neighbouring cell (beside or above, inside the walled rectangle).
  3. Pour lava into the frame cell: lava next to water becomes obsidian at once.
  4. Pick the water back up.
  5. Verify obsidian.

  If the lava stays lava, it is cooled with a second pour or bucketed back. Up to 3 attempts per cell. Water left behind by an interruption is picked up on resume.
- *Obsidian.* Carried obsidian is placed into the same frame, bottom-up, against the back wall.
- *Finish.* Wait for the interior to drain, verify 10 obsidian and an empty interior, then light with flint and steel on a bottom block (up to 3 tries). The portal is remembered only once 6 `nether_portal` blocks are seen.
- *Recovery inside the skill.* The site is remembered (`portal_site`) and resumed after a preemption unless `resumeCheck` finds obsidian or lava outside the frame. A site that fails twice is blacklisted for an hour. A pool with no safe access, no site or no sources left is marked `unusable`, so `lava_pool` becomes unmet and the bounded `findLavaPool` search runs again. Missing building blocks or a lost water bucket are obtained by nested `obtain` calls.

**`usePortal`** (`skills/progression/nether.ts`): leave through the built portal (Overworld) or the nearest remembered Nether portal.
- Navigate to the portal and check that it is lit. An extinguished portal is relit with flint and steel: the built frame from its geometry, an arrival portal by trying obsidian top faces.
- Step into the lowest portal cell and stand still for up to 9 s, 3 times.
- Success is the client's dimension actually changing. Then wait for chunks, record the arrival hazards, remember the arrival portal, and step out to a safe cell so the bot is not sent straight back.

**`netherExcursion`.** `excursionTargets` returns safe standable cells 12–20 blocks from the arrival portal: harmless floor, no lava within 2 blocks, no drop deeper than 3 beside the cell. There is at most one per 45° sector, and those with fewest lava cells within 4 come first. Up to 4 are tried with the `nether` profile. The fallback is a straight 2-high tunnel at portal level in the cardinal direction whose line holds the most lava-free rock (controlled excavation, which never opens lava). The farthest distance reached is recorded.

**`nether` navigation profile** (`nav/pathfinder.ts`): no parkour, drops of at most 2, no sprinting, no digging down. A step costs +40 beside lava and +8 within 2 blocks of it. A block with lava around it is never broken. Magma, fire and soul fire are avoided. Soul sand is allowed (it only slows). Netherrack or cobblestone scaffolding bridges short gaps. The runner picks the profile from the dimension unless a skill asks for one.

**Threats.** Ghast and blaze count as ranged (cover). Wither skeleton, magma cube, hoglin and zoglin count as melee. Piglins count unless the bot wears golden armor. Zombified piglins never count. Surface night (shelter, hunting deferral) exists only in the Overworld.

**Policy** (`planner/policy.ts` `B_REQUIREMENTS`). It is the A list, then B entries gated on `nether_ready` (`when`).
- After `nether_ready`, A requirements count as met except emergency food, a pickaxe and (since B round 2) a stone-tier sword. A cast turns the empty bucket into a lava bucket for a while, and a death may cost armor; neither re-opens the A kit.
- B entries, in order: flint and steel; a water bucket, a bucket and a usable pool, each only until the portal stands; ≥ 4 food items (bounded); `nether_portal`; `enter_nether`; `nether_excursion`; `return_overworld`.
- Every A requirement counts as met in the Nether.
- A death, an interruption or an accidental portal trip re-plans from state.

**Recovery additions.**
- Nether objectives are `noRelocate`: the ladder retries instead of taking a search walk.
- Any relocation while in the Nether becomes a retreat through the remembered portal (`recovery_step` `retreat`); the policy then re-enters.
- `findLavaPool` ignores pools marked unusable.
- The P2 drop pickup treats the portal skills like the other self-collecting skills: no detours for bulk blocks.

**Evaluator.** Scenario `b` (target `B`, 70-minute default). Ground truth: the `We Need to Go Deeper` advancement, `data get entity Bot Dimension` at the end, and `execute if block` on the reported built-portal cell. The batch report adds a B section (`evaluation/portal-report.ts`): the legs from `nether_ready` to return, strategy usage and success, cast and lava-fetch steps, pool rejections, Nether arrivals, excursions, retreats and deaths. Fixture `bkit` gives the nether_ready inventory but no pool knowledge, for development only.

**Reasoner.** `planner/model.ts` holds the `ModelClient` boundary and `ModelReasoner` (§5.3). No provider adapter is shipped and runtime reasoning is disabled (milestones.md, B note).

## 10D. Milestone B round 2: death cascades and inventory desync (as built, 2026-10-02/03)

Built after B gate 20261002 failed on deaths (1.10/run). Each change targets a measured cause (evaluation.md, B round 2).

**1.16.1 client fixes (`bot/protocol-fixes.ts`, `bot/inventory-sync.ts`, `bot/respawn.ts`).**
- `installRespawnEffectsReset`: Mineflayer keeps `bot.entity.effects` across a respawn; the vanilla client starts a new player entity with none. A stale Mining Fatigue made every client-side dig wait ~1000 s. All 13 gate wood stalls came from this, in the two runs that met an elder guardian. Event `effects_reset`.
- `installCursorSync`: the server's cursor slot (`set_slot`, window −1) is applied; Mineflayer dropped it, so the client cursor model went stale.
- `safeEquip`: every equip is serialized per bot, with at most 3 attempts. A rejected click waits for the server's window resend, then retries. An unanswered click (a container the server closed but the client kept) first resets the windows (`close_window`, then resync). A failure that remains is `STATE_INCONSISTENT key=inventory=rejected`, never an uncaught INFRA. Event `inventory_retry`. `useBucket` waits for the used bucket's slot update before returning. Recovery's L2 resync uses `resetWindows`.
- `respawnWaiter`: the controller's death flow no longer waits 15 s for a `spawn` event that has already happened, which had left the bot standing at the respawn point with no interrupts.

**Digs.** `acts.dig` refuses a dig predicted to take more than 20 s (`DIG_MAX_MS`), with `PRECONDITION_FAILED key=effect=mining_fatigue` or `dig=slow`. `collect` fails at once under fatigue, so Recovery relocates. It blacklists the target a stalled or timed-out run was working on. Food and log search steps prefer dry ground (`Searcher {dry}`).

**Death recovery (`recovery/death.ts`).** After a mob death, `recoverItems` runs only when all of these hold:
- the items lost were high-value (iron gear, buckets, flint and steel, obsidian);
- it is day;
- the site was not under cover;
- at most one melee hostile, and no shooter, was within 16 blocks at death.

Event `respawn_plan` records the first objective after each respawn.

**Weak state (`threat.ts weakState`: capacity < 1 or HP ≤ 6).**
- **Dig in, not flee:** with only melee mobs and none closer than 6 blocks, the P1 action is `cover`. Its melee path seals a 3-deep pocket. If no column is diggable, the cover cooldown turns the response into flee. Creepers, shooters, aquatic mobs and water keep their previous responses.
- **After a flight:** at night, or with hostiles within 20, `flee` ends with a dig-in.
- **No resting in the open:** `rest` does not fire with a hostile in sight within 16.
- **Holding the pocket:** in a sealed pocket a weak bot holds while a hostile is within 12. Holds chain with no gap for up to 240 s; after that, the normal 30 s gap applies.
- **Shelter window:** the shelter skill's night window equals the scheduler's (12 000–23 300).

**Evaluator.** Before the first run, the seed list goes to `runs/<batch>/private/seeds.json` (evaluator-private). `--resume <batchId>` continues an interrupted batch from it. A run the crash interrupted is not re-run and is scored `infra_error`. The survival report adds death cascades, wood-search stalls and inventory-rejection counts.

## 10E. Milestone B round 3: resource search on poor terrain (as built, 2026-10-04)

Built after B re-gate 20261003 failed (9/20, 1.15 deaths/run). Six of the 11 failed runs never reached nether_ready. Their time went to night shelter (16 119 s over the 20 runs), food hunts (10 582 s, 28 700 blocks), wood (6 211 s, 13 917 blocks) and gravel for flint (3 589 s). B itself is unchanged: every B entry still waits for nether_ready, and the gate is unchanged. Each change targets a measured cause (evaluation.md, B round 3).

**Surface search (`skills/generic/search.ts`).** Logs, food animals and the L2 `relocate` share one order. First, what the client has loaded. Then remembered spots. Then decisive relocation.
- *Survey.* From the loaded chunks, the surface class (water, tree, green, land) is probed at six distances (24–144) along 16 headings. Chunk loading gives each heading's share of unexplored chunks beyond the loaded radius (176–240). Each heading also has a look-ahead (64–256) that checks regions already searched for the same resource; the region the bot stands in is ignored, because every heading leaves it.
- *Score.* 2 × resource value − 0.5 × water + 1 × novelty + 0.3 × continuity − 3 × exhausted. A heading whose step just failed is penalised. The choice is deterministic.
  - Resource value: for wood, tree 1, green 0.5, land 0.25, water 0. For animals, green 1, tree 0.6, land 0.3.
- *Step.* 96 blocks on the surface, `dry`. Before the step, the area being left is marked searched for that resource: radius 128 for logs (the log scan covers 160), 96 for animals (the server tracks animals within 144). Marks expire after 60 min for logs, 25 min for animals and 10 min for relocate. Events `search_relocation` and `search_region`.
- The tunnel `Searcher` stays for underground work (mine, lava pool, water).

**Wood (`generic/collect.ts`, observer).**
- The observer remembers every log in the loaded chunks (up to 160 blocks, every 5 s) as `trees` spots: one per 24-block cluster, at most 24. A spot within 48 blocks whose logs are gone is forgotten. The spots are kept across deaths.
- `collect log` order:
  1. targets within 64 blocks;
  2. any loaded log up to 160 blocks (`loaded_logs`);
  3. the nearest remembered tree spot 32–1 200 blocks away (`tree_spot`);
  4. relocation.

  Steps 2 and 3 share 3 visits per run.
- A failed target blacklists the same-kind blocks within 3 of it: a whole trunk, or a whole gravel bank.

**Gravel and flint (`sources.ts`, `generic/mine.ts`).**
- Flint is knapped from one carried gravel block. `collect` re-places a carried block and digs it before looking at gravel in the world.
- That block comes from `mine`. Mining skips targets whose digging would release liquid, so it never takes lake-bed gravel from the water. It reaches buried gravel by excavation. When nothing is in range, it descends and tunnels.
- An unreachable gravel or sand bank is blacklisted whole.
- No dedicated underwater acquisition was built. Mined gravel is common underground, and the plan never needs water.
- Flint and steel is not surface work, so it runs at night.

**Food (`generic/hunt.ts`, observer, `controller/interrupts.ts`).**
- Animals are remembered as far as the server sends them (144 blocks; it was 32). A remembered spot stays useful for 20 min within 256 blocks (it was 10 min and 160), with up to 4 visits per hunt. The walk to a spot is `dry`, with a budget that grows with distance.
- Hunt search steps use the relocator for `animals`, so hunted-out areas are avoided.
- P2 `cook`, ahead of `eat`, fires when all of these hold:
  - food ≤ 14 and not an emergency;
  - only raw meat to eat;
  - the furnace route needs nothing gathered (a furnace or its cobblestone, and fuel);
  - the Overworld.

  It runs `obtain cooked_food` for up to 4 items. In the gate, 105 raw items were eaten or lost uncooked, 30–40 % of the meat in the food-timeout runs.
- `forage` reaches 24 blocks (12 before) while cooked plus raw meat is short of 14, so wood and gravel trips pick up food on the way.
- Crops and hay were not built: only 1 of the ~46 B-phase runs ever picked one up, and bread does not count as cooked food.

**Nights (`controller/schedule.ts`, policy `filler`).**
- A requirement marked `filler` is never an ordinary candidate. At night, when every candidate is deferred, the first filler that is not itself surface work runs before `shelter`. Event `schedule` `night_filler`.
- Fillers:
  - `cook_raw` (A): smelt the carried raw meat.
  - `pre_gold_armor` (B list, before nether_ready only): the golden helmet, which is mining and furnace work. `b_gold_armor` is then already met after nether_ready.
- Dusk is back at 12 500 for both the scheduler and the shelter window. Round 2's 12 000 cost about 25 s of daylight per night.

**After smoke 1 (`b3-smoke1` r01).**
- *Chunks settle before relocating.* Before the first relocation from a place, the relocator waits up to 5 s for the client to load the surrounding chunks, and the caller scans once more. At t = 1 s the bot had marked its spawn area searched for logs while chunks were still arriving. The loaded-log and tree-spot visit budget resets after each relocation, and so does the hunt's spot budget.
- *Hunts start on the surface or not at all.* A hunt still under cover after `toSurface` fails `NAV_STUCK`, and Recovery retries and relocates. It no longer walks to remembered spots through caves: r01 went from y 29 under a mountain into lava at y 10. `toSurface` climbs to the open sky above the bot (its column's highest collision block + 1), not to y 64. Under a mountain whose surface was at y 79, the y 64 goal had ended `NAV_STUCK`.
- *Burning.* Mineflayer never sets `entity.onFire`, so the observer reads the shared-flags byte (metadata 0, bit 0x01). P0 `extinguish`: on fire in the Overworld, out of liquid, with a water bucket → pour water at the feet, wait for the fire to go out, scoop the water back. In r01 the bot escaped lava at 8.9 HP and burned to death 15 s later while resting, carrying a water bucket.

**After dev batch 1 (`b3-dev1` r05).**
- `extinguish` fires only on the ground with no lava within 2.5 blocks (smoke 2 r01).
- The Nether excursion's tunnel fallback (`nether-plan.ts` `tunnelTargets`) never crosses a block slower than 3 s to dig with the carried tools (the arrival portal's obsidian frame, portal blocks, bedrock). It tries every clear cardinal line, not only the one with the most rock. r05 tunnelled 14× into its own portal frame and terminated.

**Evaluator.** The batch report adds a resource-search section (`evaluation/resource-report.ts`) for A and B batches:
- time and distance per resource (wood = `collect log`; gravel = `mine` or `collect` of gravel; food = `hunt`);
- relocations and exhausted regions per resource;
- remembered-spot visits;
- raw food lost uncooked and `cook` interrupts;
- night shelter time and fillers;
- completion of food_10, flint and steel, and nether_ready.

## 10F. Milestone C implementation (as built, 2026-10-06)

C adds progression skills, observer memory, policy data, a navigation profile and one controller hand-over. It adds no component. A and B code paths are unchanged except where C exposed a conflict (listed at the end).

**Observer memory (client-visible state only).**
- *Structures.* Every 5 s in the Nether, loaded chunk data within 176 blocks is scanned for natural nether bricks (fortress, ≥ 6 blocks, 96-block clusters), bastion blocks (polished blackstone bricks, gilded blackstone; ≥ 24) and spawners with nether bricks within 5 (blaze spawners). Each is remembered once (`location_discovered`).
- *Mobs.* Piglins and endermen within 160 blocks are remembered as 32-block spots (`piglins`, `endermen`).
- *Provocation.* A piglin swing within 4.5 blocks followed by damage within 1.2 s marks piglins hostile for 60 s (`provoked:piglin`): golden armor no longer counts in the threat score.
- *Trail.* From each Nether arrival, the cells the bot stood on, one per 6 blocks, loop-free (coming back within 4 blocks of an earlier point drops the loop). The way back to the portal is this trail reversed.
- *Failed headings* of Nether search legs (`netherFailed`, 10 min, 48 blocks, ±36°).

**Policy** (`planner/policy.ts` `C_REQUIREMENTS`): the B list (B entries stay met once B is recorded), then, gated on B:
- Overworld kit: ≥ 8 food items (bounded hunt), a crafting table, pickaxe durability ≥ 400 (stone pickaxes), a shield; then `c_enter` (`usePortal` to the Nether).
- Nether: `c_gold_armor` (golden helmet from nether gold), `c_gold` (gold ingots in batches of the expected need, ≤ 24; only once piglins have been seen), `c_pearls` (offered once piglins have been seen or the rods are in), `c_fortress`, `c_rods` (needs the fortress), `c_return` (`usePortal` to the Overworld once rods and pearls are held).
- Nether objectives are `noRelocate` and `noRetreat`: Recovery retries in place; a suspension with nothing else to do starts over in place instead of walking back through the portal.

**Strategy catalogs and hand-over** (`recovery/ladder.ts`, `controller/progression.ts`). A requirement may carry its own ordered catalog (`strategies`, each optionally a different skill); L3 moves through it, then suspends. `c_pearls`: `barter` → `endermen` (`huntEndermen`). `c_fortress`: `regions` → `axis`. `c_rods`: `spawner` → `roam`. A `MISSING_RESOURCE` for an item another requirement restocks (`resupply`, e.g. gold ingots → `c_gold`) hands the turn to it without counting as a failure. Requirements without a catalog keep `default`/`wide`.

**`findFortress`** (`skills/progression/fortress.ts`, planning in `fortress-plan.ts`).
- *Region model.* 1.16.1 places one Nether structure attempt per 27 × 27-chunk region, its start chunk in the region's first 23 × 23 chunks, fortress or bastion. The structure census (evaluation.md) confirmed this on 20 fresh seeds. A region is resolved when ≥ 90 % of its candidate zone has been loaded, or a bastion has been seen there.
- *Choice.* Among unresolved zones within 720 blocks of the arrival portal, the one with the most unseen chunks per block of travel; the target is its unseen centroid. Legs of ≤ 64 blocks; after each, the choice is made again. A leg whose heading failed nearby is turned by ±30°, ±60° or ±90°.
- *Legs* (`nether-move.ts`): the pathfinder with the `nether_travel` profile, then a straight 24-block tunnel at the current level (controlled excavation never opens a block beside lava). A leg that moved ≥ 24 blocks counts as progress.
- *Bounds.* ≤ 14 legs per run; `SEARCH_EXHAUSTED` when every zone within the radius is resolved. The alternate `axis` sweeps the least-seen cardinal direction.

**`collectBlazeRods`** (`blaze.ts`, geometry in `blaze-plan.ts`).
- *Approach:* a camp 2–5 blocks from a known blaze spawner (fortress floor, roofed and walled first), else the nearest fortress floor; a spawner that comes into view on arrival is preferred.
- *Fight:* strikes only within vanilla reach (3 blocks eye to hitbox) on the weapon's full cooldown; steps to a cell from which a hovering blaze is within reach; otherwise holds the shield **continuously** toward the blaze that is charging (a 1.16 shield blocks only after 5 ticks of use; a shield pulsed every 400 ms barely blocked in the fixture). Rods are picked up after kills.
- *Fire resistance:* blaze fireballs are fire damage, so a fire resistance potion (bartering, 20/423 per ingot) makes them harmless. It is drunk (or splashed) before the first engagement and again when it runs out.
- *Retreat:* at ≤ 8 HP with fire resistance; (without fire resistance) at ≤ 14 HP or with ≥ 3 blazes in sight: a trail point ≥ 16 blocks back that no blaze can see (the spawner stops beyond 16), hidden terrain within 12, a sealed dig-in, then plain distance. Eat and wait until 18 HP with the shield up.
- A blaze that stays out of reach for 12 s is left for 30 s. P1 ignores blazes while this skill runs above 8 HP; every other mob stays with P1.

**Fire resistance before the rods** (`c_fire_res`, bounded): with piglins known and no potion held, `barterPearls` continues until one fire resistance potion is held (gold batches of 12). Without fire resistance the blaze fixture died among six blazes; with it, none.

**`barterPearls`** (`barter.ts`). Golden armor worn; one gold ingot at a time is *used on* an adult piglin (the vanilla interaction takes exactly one), the piglin admires it for 6 s and throws its loot toward the bot, which picks up pearls, potions and obsidian. Baby piglins (metadata 15, verified on the server) are skipped; a piglin that refuses is left for 15 s. Bookkeeping: `barter` events `give`, `pearls`, `refused`, `provoked`. Out of gold → `MISSING_RESOURCE gold_ingot` (resupply). No piglin in view → remembered spots, then search legs toward unseen chunks; `NOT_FOUND` after 6. P1 ignores piglins while bartering unless they were provoked or health ≤ 8.

**Gold** (`sources.ts`, `generic/mine.ts`). In the Nether, gold nuggets come from nether gold ore (any pickaxe) and ingots are crafted from 9 nuggets at a table. `mine` never descends in the Nether; it tunnels at its level. Gold ore is `guarded_by_piglins` (1.16.1 tag): a gold block is never dug with a piglin within 16 blocks in sight, and targets within 20 blocks of a piglin are not chosen.

**`huntEndermen`** (alternate). Endermen within 48 (remembered spots, then search legs), melee within reach, shield between strikes, quit at 8 HP, pearls picked up.

**Return** (`usePortal`, `nether.ts`). Beyond 48 blocks from the Nether portal the bot follows its trail back (a snapshot: the live trail shrinks as the bot walks back), several points per leg within 40 blocks, the navigator's own strategy first, then the pathfinder. The skill's timeout grows by 1.5 s per block beyond 48.

**Ghast fire** (`skills/survival/ghast.ts`; after smoke `20261006-215727-c-c-smoke1`, where two of three Nether deaths were ghast fireballs from ghasts the observer never saw).
- *Observation.* A ghast shoots at a player it can see within 64 blocks (1.16.1 `GhastShootFireballGoal`); the observer used to drop every entity beyond 32. Ghasts and their fireballs (`fireball`) are now kept to 64 blocks, ghasts with a line of sight at any range, the charge flag (metadata 15, verified on the server) as `charging`, a charge within 15 s as `aggro`, and a fireball's closing speed.
- *Threat.* Ghast range 64. Beyond 32 blocks a ghast counts only once it has charged at the bot (idle ghasts far off draw nothing); the response is P1 `cover`. When only ghasts are in sight, cover digs in before it looks for terrain (a ghast flies around a wall).
- *Reflex.* P0 `deflect`: with a shield carried, a fireball within 40 blocks closing ≥ 3 blocks/s, or a charging ghast in sight, raises the shield toward it and holds it until the shot has passed (≥ 1.5 s after a charge, since the fireball has no measured speed yet; ≤ 6 s). A blocked fireball still explodes beside the bot and may light the ground, so fire at the bot ends the hold (`escape_fire` next). A running `cover` is never preempted by `deflect`; it calls the same `shieldUp` between its own steps (between dig-in blocks too).
- *Fire.* `body.inFire`: fire in any cell the 0.6-wide hitbox overlaps at feet or head level (feet/head read only the centre column, so fire one cell over burned the bot at 1 HP per half second without an interrupt). `escape_fire` fires on it, and `safeCells` rejects cells with fire beside them.
- *Fixture* (`tests/scenario/ghast.scenario.test.ts`, a 70 × 24 netherrack hall 8 blocks high so the ghast stays within the 4-block height band it needs to pick a target): an idle bot without the reflex died in ~13 s (5 fireballs). Reflex only: 0 deaths, min HP 16 in 3 of 3 runs over 30 s. Full interrupt set: 0 deaths in 3 of 3 runs over 45 s (min HP 16, 17, 4.8; the last as the hall floor filled with fire that never burns out on netherrack).

**After dev batch c-dev1** (`20261007-110334-c-c-dev1`, 0/6; evaluation.md):
- *Hoglins: guarded fight* (`skills/survival/hoglin.ts`, from `cover`'s melee path when a shield is carried and health > 7). The avoid rule's sealed dig-in failed (no diggable column; knocked out of the shaft), hoglins outrun a walking bot, and a pillar perch was knocked over while being built (fixture), so the bot fights: shield raised toward the nearest hoglin, never chasing, a strike only while every hoglin within 4.5 blocks attacked within the last 1.2 s (each attack is entity event 4; the next comes about 2 s later, the shield needs 5 ticks). A blocked hoglin hit does no damage and throws nothing. Below 7 HP the fight is left (dig-in, then flight). Strikes focus one hoglin until it dies. Fixture (all runs): 2 hoglins with an iron sword survived 6/7, 3 with a stone sword 5/6; not yet seen in a real run.
- *No bridge over a deep drop* (`nav/pathfinder.ts` `unsafeBridge`): in the `nether` profile a placed block needs solid ground within 4 below with only air between, else it costs 1 000 (towers and short gaps stay).
- *Nether search legs* (`skills/generic/explore.ts` `Searcher`): in the Nether a leg is a `near` goal held in y 40–100 on `nether_travel` (no scaffolding), not an `xz` goal on `nether`.
- *Piglin guard box* (`skills/generic/mine.ts` `piglinsWatching`): the 1.16.1 rule's box (player box inflated by 16, plus 1.5 for movement), not an 18-block sphere.
- *Fall recorder* (observer, diagnosis only): on leaving the ground the 3 × 3 columns around the take-off cell (y −6 … +2); a drop of ≥ 6 emits `fall` with them and the last ~2 s of positions and controls.

**`nether_travel` profile** (`nav/pathfinder.ts`). The `nether` rules, but scaffolding costs 20 and lava up to 4 blocks below a step counts as near. With the `nether` costs a tower-and-bridge over a lava lake (1 per block) beat walking a causeway beside it (+8/+40 per step); the fixture bot ran out of blocks mid-lake. B keeps `nether`.

**Changes to A/B code exposed by C.** (1) B's `tripDone` reads the recorded B milestone: in the Nether during C, `milestoneB` (it needs `return_ok`) is false, which re-opened `nether_excursion` and `return_overworld` and would have sent the bot straight home. B runs end when B is recorded, so B is unchanged. (2) Piglins count as a threat when provoked even with golden armor. (3) Barter leftovers are junk for the inventory policy (quartz, glowstone dust, magma cream, nether brick, crying obsidian, soul sand, fire charges, iron nuggets, books). (4) Ghast fire (smoke `20261006-215727-c-c-smoke1`): the observer keeps ghasts and fireballs to 64 blocks (other entities still stop at 32), ghast threat range 64 (32 for a ghast that has not charged), `deflect` is registered with the B skills (it fires only in the Nether), `cover` blocks ghast fire between its steps and digs in first against ghasts only (`digIn` takes an optional hook; without it, A/B's dig-in is unchanged), `body.inFire` reads the whole hitbox and triggers `escape_fire`, and `safeCells` rejects cells with fire beside them. Without ghasts or fire, A and B behave as before. (5) After c-dev1: B's `nether` profile no longer bridges over lava or drops deeper than 4 (B excursions fell twice in c-dev1); the Searcher's Nether legs (A code, Nether branch only); `cover`'s melee path fights hoglins behind the shield (hoglins are Nether-only) and its timeout is 90 s (A/B paths end inside 40 s as before).

**Evaluator.** Scenario `c` (target C, 120 min, reasoner `none`, no early-fail rules). Ground truth: B's checks plus rods and pearls in the server inventory. The batch report adds a C section (`evaluation/c-report.ts`). Fixture `ckit` (development only): the nether_ready kit plus 10 obsidian, a golden helmet and the C Overworld kit.

## 10G. Milestone C round 2: opportunity order, bastion gold, adaptive barter, cheap death recovery (as built, 2026-10-08)

After dev batch `20261007-110334-c-c-dev1` (0/6): B was reached at ~1 800 s, ~50 ingots of nether gold took 2 000+ s before enough pearls, the fortress search never ran because the policy forced pearls first (4 of 6 runs had already seen a fortress or bastion during B), 17 of 23 deaths came after a first death, and each C-phase death cost 640–1 460 s before the bot was back in the Nether. The ghast, hoglin, lava-bridge, piglin-anger and fall-telemetry fixes of §10F are unchanged.

**Opportunity order** (`planner/policy.ts` `cRoute`, deterministic, no model):
- *Fortress known* (also one seen during B: structure memory survives deaths and dimension changes) → **rods first** (`rodsFirst`). When no fire resistance potion is held and a gold source is known (piglins or a usable bastion), one is bartered for first (`fireResFirst`: gold in a small batch, `barterPearls { fireRes: 1, untilFireRes: true }`, bounded; every ingot also rolls pearls). Reason: the blaze fixture without fire resistance died at the spawner in 2 of 2 isolated runs on 2026-10-08 (0 kills: a spawner keeps 3–6 blazes in sight and the crowd rule retreats forever) and in 4 of 5 earlier development runs. The rods objective camps at a spawner only with fire resistance; without it it starts on the fortress floors (`roam`, where blazes come singly; not yet measured on real terrain).
- *Usable bastion known* (seen in this run, within `C.bastionRadius` 400 of a Nether portal, not exhausted, not set aside as unreachable) and no fortress → **pearls first** from bastion gold.
- *Neither* → `c_structure`: the region search (`findFortress { target: 'any' }`) stops at the first fortress or usable bastion, which then sets the route. Piglins alone do not count as a strong gold opportunity; a suspended search hands over to ore gold and bartering.
- After the first half: rods done → pearls (bastion, piglins, or the enderman alternate); pearls done → fortress search, a fire resistance barter (bounded), rods.
- Implementation note: the policy list is ordered data, so the route-dependent entries appear twice with the same id and mutually exclusive `when` (`c_gold`, `c_fire_res`, `c_rods`); Recovery suspends by id, so a suspended copy suspends both.

**Bastion gold** (`skills/progression/bastion.ts` `bastionGold`). The 1.16.1 bastion templates (server jar `data/minecraft/structures/bastion`) carry gold blocks in every type (bridge piece 16, entrance 7, housing wall base 12, hoglin-stable side wall 12, treasure centres 12–19) and chests whose loot tables give gold ingots, gold blocks and nuggets. The skill walks to the remembered bastion (≤ 8 legs, else unreachable for 10 min), then takes the cheapest target within `C.bastionScanR` 56: a gold block (needs an iron pickaxe; 9 ingots) only with no piglin in the vanilla anger box (player box grown by 16, sight or not: `PiglinTasks.angerNearbyPiglins(player, false)` on breaking a `guarded_by_piglins` block), a chest only with no piglin in that box that can see the bot (opening angers only seeing piglins) and with room above it. Never a target whose digging opens lava or water or with lava within 3 below an open face. A guarded target is waited on 8 s, then left 90 s. Chest loot taken: gold ingots, blocks, nuggets and one spare golden armor piece. Blocks are crafted into ingots at once. No target left within reach → the bastion is marked `exhausted`. Nether gold ore stays the fallback.

**Progressive barter and adaptive pearl budget.** Gold batches are capped at `C.goldBatch` 8 (was 24; one gold block already covers a batch), so bartering starts with the first batch and `barterPearls` stops the moment 14 pearls are held (gold not yet given stays). The ledger (`memory.cLedger`: ingots given, pearls and potions back, gold per source, seconds on nether gold ore) lives in bot memory. `goldExhausted` = no usable bastion and ≥ `C.oreBudgetS` 1 500 s of ore mining; `barterUnproductive` = ≥ `C.barterCap` 110 ingots given and pearls still short (1.16.1 table, simulated: P(< 14 pearls after 110 ingots) = 9 %; ingots to 14 pearls p50 52, p90 107). Either, with no gold in hand → `c_gold` is no longer offered and `c_pearls` runs `huntEndermen`. While waiting for admiring piglins the bot stands on a safe cell (no lava within 3, no cliff edge; `nether-plan.ts` `barterSpot`).

**Cheap C death recovery** (`skills/progression/stash.ts`, policy `c_ow_gold`, `c_stash_*`, `c_bed*`, `c_unstash`):
- *Bed at the portal.* 1.16.1 behaviour verified first (`tests/scenario/bed-spawn.scenario.test.ts`): using a bed by day answers "Respawn point set" and sets the respawn point; a death then respawns beside the bed (also when walled in except one side); without the bed the respawn is at the world spawn. The bot crafts a white bed from three white sheep (hunt filters by wool colour, metadata 16; white wool is no longer junk, capped at 3) when they are at hand (bounded hunt), places it within `C.bedNear` of the built portal and uses it. A respawn far from the bed marks it lost.
- *Replacement kit* (once, before the first C entry, bounded): a spare golden armor piece where Overworld gold is at hand (golden boots, 4 ingots; bounded 6 min), wood for the chest and spare tools, then a chest beside the portal with a stone sword, two stone pickaxes, a crafting table, surplus food (≤ 4 beyond the trip's 8), 32 cobblestone, and any spare golden armor, shield or flint and steel. Never the trip kit itself.
- *After a C death* (a death after the first C entry): `c_unstash` first (when the kit is within 32 blocks or the bot is armed), then only the minimum safe kit: 4 food, 1 table, one stone pickaxe's durability (131), a shield only from iron already carried, and **never a re-entry without golden armor** (`c_ow_gold`, required by `c_enter`). Item recovery stays off for Nether deaths (`recoverDecision`, unchanged); structure and portal memory is kept.

**Loops that never yield.** `huntEndermen`'s fight loop spun when the navigator's entity goal settled at once while the eye-to-hitbox reach was still > 3: with the event loop blocked no packet arrived, the enderman never moved, and the C fixture worker sat at 100 % CPU for 40 min (the old "trail fails in sequence" was this hang). The loop and the blaze fight loop now yield every pass; an enderman not reached after 6 approaches is left.

**Fixtures** (`tests/scenario/c.scenario.test.ts` isolation): every test starts with `kill @e[type=!player]` and fresh Nether memory; both blaze tests build their own room far away (the client must load a spawner's chunk after it is set). `tests/scenario/c-route.scenario.test.ts`: opportunity order from live observation, bastion gold under the anger rules, early stop at 14 pearls, white-sheep wool, and death → bed respawn → kit → re-entry wearing golden armor.

**After ckit-r2 r01** (one random-terrain run, evaluation.md): *calm piglins* — 1.16.1 piglins never attack a player in golden armor until angered, at any distance, so an unprovoked piglin (`calmPiglin`) is not `menacing`: no threat score, no cover shooter, no reason for the sealed-in hold, night shelter or rest exposure (r01 fled them 146 times inside a bastion and died twice when a flight ran into a magma cube). A hit (`piglinsProvoked`) restores all of it. *Protected blocks* — beds and chests (`isProtected`) are never dug by the pathfinder (`blocksCantBreak`), the excavator, the stuck/ceiling digs or `digIn` (r01 dug up its own respawn bed on a restock walk).

**After ckit-r2b** (3 runs, 0 C): *lava with a potion* — `escapeLava` uses a carried fire resistance potion before swimming out: a splash potion thrown down at once; a drinkable one only above `LAVA_DRINK_HP` (10) and with no safe cell within `LAVA_EDGE` (1.5), because lava keeps burning through the 1.6-s drink (`survival/potion.ts`, shared with the blaze fight). *Angry endermen* — 1.16.1 enderman metadata 16 (screaming) is read as `aggro`: such an enderman is a threat at any distance (the avoid rule digs in), and a sealed-in bot holds while one is within `ENDERMAN_HOLD_DIST` (32; it teleports back within seconds). *Restock* — after a C death 131 pickaxe uses still allow the re-entry, but a pickaxe built is built to `pickReopen`. *Search* — `c_structure` is persistent: hazards suspend it instead of ending the run.

**After ckit-r2c and r2d** (evaluation.md): *unstick* — the move brakes after `UNSTICK_STEP` (0.6 blocks) and prefers directions whose second cell is also safe; *portal step-in* — walk, then a digging path, then the other portal cells; obsidian is protected. *Fall guard* (`nav/fall-guard.ts`) — runs after the pathfinder on each physics tick. It vetoes upstream `fullStop`'s re-centring when the centre column has no floor under the bot, and it simulates the held movement keys with the server's physics (3 ticks held, then released, until landing), releasing them when the landing is more than 4 blocks down, never comes, or is lava. It never sets a position or velocity of its own. It is installed on the first `spawn` when mineflayer has not yet injected its plugins (the bot process builds the navigator right after `createBot`; the first ckit-r2e launch died at start-up in all 3 runs on the missing `clearControlStates`), which keeps it after the pathfinder's `physicsTick` listener. *Portals* — the pathfinder treats `nether_portal` cells as blocked unless the goal is a portal cell, and a portal crossing during a skill other than `usePortal`, `netherExcursion` or `buildNetherPortal` cancels that skill.

**C staging round (after ckit-r2d, 2026-10-09/10; supersedes the bed hunt, the 6-min golden-boots search and the wood trips of "Cheap C death recovery" above).** Measured on ckit-r2 … r2d: B → first C entry took 347–1 362 s; the spare golden boots alone cost 103–706 s in every run, and all 3 Overworld deaths of the staging came on its wood trips (c_table ×2, c_stash_wood), each losing the whole iron kit.
- *Required before the first entry* (policy `C_REQUIREMENTS`): food (`C.foodItems`), one crafting table (`c_table`), pickaxe durability, a shield, one golden armor piece (`c_ow_gold`).
- *Optional* (`stageOpen`: B recorded, no death since B, before the first C entry, ≤ `C.stageWindowS` 300 s after B; ≤ `C.stageTries` 2 attempts per item in `memory.cStage`): a second table (`c_table2`), a spare golden piece (`c_stash_gold`), the bed (`c_bed`), the kit chest (`c_stash`). Each is met the moment it is not offered, so nothing waits on it. Every optional item is a craft from carried resources (`craftOnly`: every planned step is a craft), never a gather, mine, smelt or hunt; the only gathering is `c_stash_wood` (collect `local`: natural trees within `C.stageWoodR` 24, dry, no search, no far scan, no tree spots). The bed is offered only when one is at hand (carried, or wool + planks carried) and the world spawn is far from the portal (`C.bedSpawnFar` 32 horizontally or 10 vertically); no sheep hunt.
- *Death after B* (`rekit`: any death after B, in either dimension, also before the first entry): the kit chest first when there is one (`c_unstash`), then the minimum safe kit only — `C.minFoodAfterDeath` 4 food, 1 table, `C.minPickAfterDeath` 131 pickaxe uses, a shield only from carried iron, a golden piece. No second table, no kit, no A rebuild.
- *Sites* (`stage-plan.ts`): bed and chest go at explicit cells within `C.bedNear` 6 of the portal, never a portal cell or its step-in lanes (2 cells in front of and behind each portal cell, opening height and one below), on solid non-gravity floor away from liquids, bed head and foot with room above, and a stand cell behind the foot (the server takes the bed's facing from the player's yaw). `bedAnswer`: "Respawn point set", "You can sleep only at night" and "You may not rest now; there are monsters nearby" all mean the point is this bed (1.16.1 `ServerPlayerEntity.trySleep` sets the spawn before the day and monster checks).
- *Portal occupancy*: observer `body.inPortal` (hitbox columns at feet and eyes); P0 `leave_portal` → `leavePortal` (walk to the nearest safe non-portal cell) outside the portal skills.
- *Water*: while swimming the pathfinder plans no digs, placements or corner-squeezing diagonals (ckit-r2d r01 was pinned at a packed-ice corner by dig/squeeze moves, not trapped under ice). A route failure on the water itself flags `water_trap`; P0 `water_escape` → `escapeWater` (surface, then shoreline exits within 12, then 40, including `notch` exits cut into packed ice or snow) runs before any objective. `surface()` digs an ice ceiling only when there is no water route to air or only one longer than `ICE_ROUTE_MAX` 4: the ceiling is the first non-water block up to `ICE_SCAN_UP` 6 above the eyes, dug once it is within `ICE_DIG_REACH` 3.5 (the bot keeps swimming up until then), with the right tool. Fixed 2026-10-10: the scan used a 2–4 block window above the *feet* (a bot that had sunk 1.4 blocks missed ice 4.4 above its eyes), and the one-shot fallback dig was spent on a water cell. `escapeWater` succeeds only when the bot stands dry (`standingDry`: on the ground, no water in the feet cell); it used `isInWater`, which reads false while the bot bobs at the surface (prismarine-physics shrinks the hitbox by 0.4 at each end), so it returned "dry" from the hole it had just dug without trying an exit.

**Report** (`evaluation/c-report.ts`): per run B→C, first useful structure, route (`fortress-first`, `bastion-first`, `search→…`, `piglins/ore`), gold by source (bastion blocks, chest ingots, ore), re-entry → first ingot, ingots given / pearls, re-entry → 14 pearls and → 7 rods, C deaths, death → back in the Nether, kit/bed use, return.

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
| **Version/plugin incompatibility** | all | Exact pins (1.16.1 everywhere, `src/version.ts`), lockfile, pathfinder commit plus patches, pvp vendoring check at install, viewer optional; nav benchmark reruns on any bump. Mineflayer's CI covers 1.16.5, not 1.16.1, so the 1.16.1 scenario suite and benchmark are the compatibility evidence | Now (M0) |
| **Legacy server runtime** (1.16.1 needs Java 8; bundles log4j 2.8.1) | evaluator | Explicit Java 8 path (`src/evaluation/java.ts`, rejects other majors); Log4Shell mitigated with `%msg{nolookups}` (`config/log4j2-server.xml`), verified by a lookup probe; server bound to 127.0.0.1 | Now |
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

## 14. 1.16.1 game model for later milestones

This section records the facts about 1.16.1 that the progression strategies above depend on. Items marked **(jar)** were read from the 1.16.1 server jar's data (`data/minecraft/loot_tables/…`, structure lists) or from minecraft-data 1.16.1. The rest are established 1.16 mechanics that fixture scenarios must confirm before any tuning depends on them. None of it is a seed fact.

### 14.1 Overworld (milestone A)
- **World shape.** y 0–255 with a bedrock floor at 0–4. The sea surface is at y 62. There is no deepslate, tuff, copper, amethyst, aquifers or noise caves; caves are carver tunnels and ravines. Carvers fill every cave cell at **y ≤ 10 with lava**, so y 10 is the lava level. `src/version.ts` holds these bounds (`OVERWORLD`, `UNDERGROUND`).
- **Ores.** Iron is y 0–63, gold y 0–31, redstone and diamond y 0–15, coal y 0–127.
  - Iron and gold ore **drop the ore block itself** and must be smelted; there are no raw ores **(jar)**.
  - Iron needs a stone pickaxe; gold and diamond need an iron pickaxe.
- **Mining depths.**
  - Iron mining happens around feet y 16, where a pickaxe opens the whole iron range quickly (`UNDERGROUND.miningY`). The navigation benchmark's `depth` trial targets this level.
  - Diamond-level strip mining uses feet y 11, the lowest level clear of lava lakes (`UNDERGROUND.diamondY`). It needs the excavation lava checks on every block, because lava pools sit directly below.
  - Diamonds are optional for the dragon: obsidian comes from a lava cast.
- **Hostile mob pressure.** Before 1.18, hostile mobs spawn at **block light ≤ 7** (0 from 1.18 on). Dark caves, forests and dusk therefore spawn more mobs than in the old 1.21.4 runs. Excavation and mining need the P1 threat interrupt and torches or cover earlier than the 1.21.4 plan assumed.
- **Mobs present:** zombie, husk, drowned (some with tridents in rivers and oceans), skeleton, stray, spider, cave spider, creeper, enderman, witch, slime, phantom, pillager patrols and raids.
  - Absent: goats and axolotls (1.17), warden (1.19), breeze and bogged (1.21).
  - **Phantoms** appear after 3 in-game days without sleep. A 180-minute run spans about 9 days, so sleeping in a bed (which also skips the night) becomes a maintenance objective in A.
- **Ruined portals** (new in 1.16) spawn in the Overworld. They have partial obsidian frames and a chest with gold and sometimes flint and steel **(jar)**, which makes them a cheap `obsidian`/`nether_portal` alternative.

### 14.2 Nether (milestones B and C)
- **Biomes:** nether wastes, soul sand valley (ghasts and skeletons; soul sand slows walking), crimson forest (piglins and hoglins), warped forest (endermen, so the safest `hunt_endermen` location), and basalt deltas (magma cubes, very uneven terrain; avoid).
- **Bartering (jar, `gameplay/piglin_bartering.json`).** A piglin trades one gold ingot for one roll of a 423-weight table:
  - **ender pearls at weight 20 (4.7 %), 4–8 per trade**: about 0.28 pearls per ingot, so ≈ 50 ingots for 14 pearls on average;
  - obsidian at weight 40 (9.5 %, 1 each);
  - string 8–24 (4.7 %; wool for beds, §14.4);
  - fire resistance potions, drinkable and splash (2.4 % each);
  - gravel, soul sand, nether bricks, leather, fire charges, crying obsidian (which cannot build a portal), quartz, glowstone and magma cream.

  The 1.16.2 jar lowers pearls to weight 10/459 with 2–4 per trade **(jar)**. Strategies written for later versions underrate bartering in 1.16.1.
- **Piglins** are neutral while the bot wears any golden armor piece. Mining gold blocks or opening chests near them angers them. **Piglin brutes do not exist in 1.16.1**: they are absent from minecraft-data 1.16.1 and from the 1.16.1 jar, but present in the 1.16.2 jar **(jar)**. Bastions are therefore much safer than in later versions. Hoglins are hostile; zoglins are hostile.
- **Gold sources.**
  - Nether gold ore drops 2–6 nuggets with any pickaxe **(jar)** and is common in all Nether biomes.
  - Gilded blackstone drops 2–5 nuggets some of the time **(jar)**.
  - Bastions hold gold blocks and chests.
  - Overworld gold ore needs an iron pickaxe and smelting.
- **Structures.** Fortresses (blaze spawners, wither skeletons; nether bricks) and bastions (polished blackstone bricks, gilded blackstone) compete for the same Nether structure regions, so the bot may see several bastions before its first fortress. `findFortress` keeps the explored-chunk sweep (`axis_sweep`, then `spiral_explore`). A structure census fixture must measure the typical search radius before any budget is tuned.
- **Blazes** drop 0–1 rods **(jar)**, so 7 rods take about 14 kills without Looting.

### 14.3 Stronghold and End (milestones D and E)
- Strongholds sit in rings around the world origin, with the first ring 1280–2816 blocks out. An eye of ender flies toward the nearest one and shatters 20 % of the time. The portal room has 12 frames, and each frame already holds an eye 10 % of the time. `eyes_of_ender(≥14)` therefore covers a full frame fill plus about 2 throws; triangulation uses 2 throws ≥ 200 blocks apart (§6.3), each of which may cost an eye.
- **End.** The dragon fight uses the 1.9+ mechanics, unchanged through 1.16.1: end crystals on obsidian pillars (some caged), dragon perching on the exit portal, and beds exploding outside the Overworld. The bed-perch strategy and the `melee_perch` alternate need no version change. Endermen are the End's ambient threat, so the no-eye-contact rule matters.

### 14.4 Strategy consequences (to implement in the listed milestones)
- **A:** smelting is required for iron (no raw ores). Add night sleep and phantom handling to maintenance. Excavation must treat y ≤ 10 as lava territory. Mob pressure underground is higher, so defend/flee must be ready before long excavations.
- **B:** portal options are `lava_cast` or completing a ruined portal. Wear one golden armor piece before entering (piglins).
- **C:** pearls come from **bartering first** (gold from nether gold ore and bastions), with `hunt_endermen` in warped forests as the alternate. Blaze rods come from fortress spawners. Fire resistance potions from bartering are a lava safety margin, never a precondition.
- **D/E:** unchanged from the design above. Beds can come from sheep wool or bartered string (4 string → 1 wool).

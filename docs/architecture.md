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

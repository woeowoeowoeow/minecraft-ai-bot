# Infrastructure audit

Phase 1 research. Status was checked on **2026-09-27** through the GitHub API (last push, recent commits, license) and the npm registry (latest version, publish date). "Last real commit" leaves out dependabot and CI-only commits.

Verdicts: **USE** means depend on it as-is (pinned). **ADAPT** means borrow code or design, or depend on it with a local patch. **REJECT** means don't depend on it.

## Summary

| Candidate | Role | Status (2026-09-27) | License | Verdict |
|---|---|---|---|---|
| mineflayer 4.39.0 | Client, world state, actions | Very active; release 2026-09-06; tests 1.8.8–26.1 | MIT | **USE** |
| minecraft-data / node-minecraft-protocol | Registry, protocol | Very active (3.117.0 / 1.68.0, Aug–Sep 2026) | MIT / BSD-3 | **USE** (transitive) |
| mineflayer-pathfinder 2.4.5 (npm) + master | Navigation | npm release is from 2023; master active in Sep 2026 | MIT | **USE, pinned to a git commit plus local patches** |
| @miner-org/mineflayer-baritone 4.6.2 | Alternative navigation | Active (Aug 2026); one developer; 46★ | ISC | **REJECT for now**; benchmark candidate behind the nav adapter |
| minecraft-pathfinding (@nxg-org) 0.0.26 | Alternative navigation | Dec 2025; README says "not meant to be used in production" | MIT | **REJECT** (watch) |
| baritone-ts (nuxdie) | Baritone port to TS | npm package **unpublished** 2026-01-29; 1★; last commit Jan 2026 | AGPL-3.0 | **REJECT** |
| Baritone (cabaletta) | Java pathfinding mod | Very active (v1.20.0, 2026-09-23) | LGPL-3.0 | **REJECT** as a dependency (Fabric client only); reference for its cost model |
| AltoClef (MiranCZ fork) | Java bot that beats the game | Last push May 2025; MC 1.16.5–1.21.1; many fragmented forks | MIT | **ADAPT** the strategy only; **REJECT** as runtime |
| mineflayer-collectblock 1.6.0 | Mine and collect with tool selection | Maintained; repo Release 1.7.0 (Mar 2026) | MIT | **USE** |
| mineflayer-tool 1.2.0 | Best-tool selection | Low activity; used by collectblock | MIT | **USE** (transitive) |
| mineflayer-pvp 1.3.2 | Melee combat | npm release from 2022; CI-only commits since | MIT | **ADAPT** (vendor it if its tick-event bug is still present) |
| mineflayer-auto-eat 5.0.3 | Hunger management | Maintained (Aug 2025), linkle69/mineflayer-auto-eat | MIT | **USE** |
| mineflayer-armor-manager 2.0.1 | Auto-equip armor | 2023; small and stable | MIT | **USE** |
| @nxg-org/mineflayer-custom-pvp 1.7.16 | Bow/shield PvP | Active (Apr 2026) | **GPL-3.0** | **REJECT** (license; not needed for the bed strategy) |
| minecraftHawkEye | Bow aiming | Last push May 2024 | **none** | **REJECT** (no license) |
| mineflayer-crafting-util 0.5.0 | Recursive crafting plans | May 2026; 5★ | MIT | **ADAPT** (try it; fall back to a small resolver) |
| mineflayer-statemachine 1.7.0 | Behavior FSM | npm 2023 | MIT | **REJECT** (a typed task tree of our own is simpler) |
| prismarine-viewer 1.33.0 | 3D view, headless screenshots/video | Repo active Sep 2026 (26.1 support); npm Feb 2025 | MIT | **USE as an optional dependency** |
| mineflayer-web-inventory | Inventory web UI | 2024 | MIT | **REJECT** (JSON observer covers this) |
| minecraft-wrap 1.10.0 | Download/start/stop vanilla server | Active (Aug 2026); used by Mineflayer's own tests | MIT | **USE** |
| itzg/docker-minecraft-server | Containerized servers | Very active | Apache-2.0 | **ADAPT later** (Linux/parallel scale-out; Docker not installed locally) |
| Paper server | Server | Very active | GPL/MIT mix | **REJECT** (changes vanilla mechanics) |
| Chunky | Chunk pre-generation | Active | GPL-3.0 | **REJECT** (not needed) |
| HeadlessMC | Headless Java client | Active (Aug 2026) | MIT | **REJECT** (only needed for a client-mod stack) |
| Voyager | LLM curriculum + skill library | **Stale since 2023-07**; pins mineflayer ^4.8 | MIT | **ADAPT** the primitive code as reference; **REJECT** the runtime |
| Mindcraft | LLM Mineflayer agent | Active (Jun 2026); recommends MC 1.21.6 | MIT | **ADAPT** skills.js and its patch list as reference; **REJECT** the runtime |
| MineDojo | Malmo-based research env | Stale (2024); old MC | MIT | **REJECT** |
| minecraft-mcp-server (yuniko) | MCP control over Mineflayer | Active (Apr 2026), 760★ | Apache-2.0 | **REJECT** as control; pattern reference for inspection tools |

## 1.16.1 compatibility audit (2026-09-28)

The target moved to vanilla **1.16.1** (PROJECT.md). Every current dependency was kept, because each one supports the older protocol. None was upgraded or downgraded.

| Dependency (pinned) | 1.16.1 support | Evidence | Verdict |
|---|---|---|---|
| mineflayer 4.39.0 | Supported range 1.8.8–26.1. The CI matrix tests 1.16.5 (same major), not 1.16.1 | Real-server smoke: login, chunks, `bot.game.minY = 0` / `height = 256`, dimension `overworld`, walking with 0 corrections, own air metadata (key 1), inventory sync. Full 1.16.1 scenario suite and benchmarks (evaluation.md gate log) | **Keep** |
| minecraft-data 3.117.0 | Native `pc/1.16.1` blocks, items, recipes, entities, collision shapes, protocol and loot (enchantments borrowed from 1.13.2). Entity categories are missing for piglin, hoglin, zoglin, zombified_piglin, strider, fox and bee (`UNKNOWN`) | `dataPaths.json`; 1.16.1 block names checked (kelp, seagrass, bubble_column, `grass` plant, `grass_path`; no deepslate, powder snow, raw ores, mangrove or cherry) | **Keep.** The category gaps are filled in `src/version.ts` |
| minecraft-protocol 1.68.0 | Protocol 736 (1.16.1) available. Tested set includes 1.16.5 | Real-server login and play | **Keep** |
| prismarine-physics 1.11.1 | Its own feature table maps major `1.16` to proportional liquid gravity, climbing by jump, trapdoor climbing and velocity blocks on top (soul sand, honey). Kelp, seagrass and bubble columns count as water | Source audit, water scenarios | **Keep.** The collision-epsilon patch (`src/nav/physics-epsilon.ts`) is version-independent and still applied |
| mineflayer-pathfinder @6f5c26b | Uses `bot.registry` with guarded names (`cobweb`/`web`, `cave_air`, `void_air`) | Scenario suite on 1.16.1 | **Keep.** Our scaffold list dropped `cobbled_deepslate` |
| minecraft-wrap 1.10.0 | `downloadServer('1.16.1')` works | sha1 of the downloaded jar = Mojang manifest `a412fd69…` | **Keep** |
| prismarine-viewer (optional, not installed) | 1.16.1 has native assets | — | Unchanged (optional) |

**Mineflayer behaviour that differs on 1.16.1:**
- Every entity has `type: 'mob'`, so hostile and passive are told apart by `entity.kind`, the minecraft-data category (`src/observer/observer.ts`).
- The `oxygenLevel` leak from other entities is specific to newer versions. On 1.16.1 Mineflayer uses its per-entity breath handler. `ownAir` still reads the bot's own metadata and is correct on both.
- `bot.game.difficulty` is `undefined` after login on 1.16.1. Nothing reads it.
- **No handling of `acknowledge_player_digging`** (the 1.14–1.18 block-break ack). Rejected or delayed breaks leave ghost air cells on the client. Fixed locally in `src/bot/protocol-fixes.ts`; a candidate upstream fix.
- **`_syncWindow` is a no-op before 1.17.1** (`stateIdUsed`). Replaced for 1.16.1 by a server-rejected probe click (`resyncInventory`).

**Java runtime.** Mojang's 1.16.1 manifest declares `javaVersion: {component: jre-legacy, majorVersion: 8}`. Only Temurin 21 and Zulu 11 were installed. `npm run setup` therefore installs a project-local Azul Zulu 8 JRE (GA, TCK-certified; for this host 8.0.504, macOS aarch64, SHA-256 verified against Azul's metadata) into `.cache/java/`. The evaluator invokes it by explicit path (`src/evaluation/java.ts`; override with `MC_JAVA`) and refuses any other major. Global Java and Node are unchanged. The 1.16.1 server starts in about 20 s at about 350 MB RSS (measured once, with a fresh world and one bot).

**Security.** The 1.16.1 jar bundles log4j 2.8.1, which is vulnerable to Log4Shell. The server runs with `config/log4j2-server.xml`, the jar's own log config with `%msg{nolookups}`, matching Mojang's official 1.12–1.16.5 mitigation. It is bound to 127.0.0.1. Probe: `say ${java:version}` logs literally with the config and prints `Java version 1.8.0_504` without it.

## Details

### Control layer

**Mineflayer — USE.** It is the only mature headless Java-protocol client with structured state: entities, blocks, inventory/windows, dig/place/activate, crafting (`recipesFor`/`craft`), furnace, chests, beds, dimension changes and physics. It ships TypeScript types. Maintenance is strong: frequent 2026 releases and a CI matrix that runs real servers from 1.8.8 to 26.1. The 4.38/4.39 fixes touch behaviors this project depends on (placement rejection, inventory desync, `player_loaded` on 1.21.4+).
- Limitations: physics comes from `prismarine-physics`, an approximation of vanilla. Downstream projects report water and knockback edge cases; Mindcraft patches `isInWater` in the dig-speed calculation. The newest versions (26.x) have the least field testing.
- Requires Node ≥ 22.

### Navigation

**mineflayer-pathfinder — USE, pinned and patched.** It is the de facto standard (Voyager, Mindcraft and collectblock all build on it). It offers A* with dig/place/parkour, a goal library, and movement configuration (`canDig`, `scafoldingBlocks`, `blocksToAvoid`, `liquidCost`).
- The npm release (2.4.5, 2023) predates useful master fixes (Sep 2026): `goto` now **rejects** an unreachable goal instead of resolving silently, and there are gate/door post-processing fixes. Pin it to a git commit.
- Known weaknesses from Mindcraft's `patch-package` set: lava avoidance, doors, overshoot tolerance, and getting stuck in lava. It is weak in the Nether (lava lakes, soul sand, fire) and slow on long unloaded routes, and it has no boat, elytra or long-range exploration planner.
- The new `createHuman` API is for looking human (anti-detection) and doesn't matter here.

**Alternatives.**
- @miner-org/mineflayer-baritone is the only credible swap-in: active, with parkour, swimming, ladders, towering and partial-path replanning. It has one maintainer, an ISC license and a small user base. Keep it as the fallback behind a navigation adapter, and benchmark it only if navigation becomes the leading failure.
- nxg minecraft-pathfinding describes itself as not production-ready.
- baritone-ts has been unpublished from npm, is AGPL, and has had no activity since January.
- Java Baritone is the best pathfinder that exists, but it only runs inside a Fabric/Forge **client**. No maintained Mineflayer↔Baritone bridge exists. The only bridge seen, `yuruko/burtcraft`, drives AltoClef from Node and has 1★.

### Complete-game bots

**AltoClef — ADAPT the strategy, REJECT the runtime.** It is the only open-source bot shown to beat Minecraft autonomously (first in May 2021). Its `BeatMinecraftTask` and "chains" design (priority survival interrupts over a task tree) is the best existing blueprint for this project's planner. The MiranCZ fork (MIT) covers 1.16.5–1.21.1. Why not run it directly:
- It is a Java client mod that needs a full game client (GPU or HeadlessMC).
- Maintenance is split across many hobby forks, and the most active one last pushed in May 2025.
- No reliability rate across random seeds has been published.
- It is harder for a coding agent to inspect and batch-evaluate than a headless Node process.

Borrow its task decomposition, its survival-interrupt priorities, and its stronghold, blaze and dragon tactics. Don't borrow its code.

**Voyager — ADAPT as reference.** Its `control_primitives` (`mineBlock`, `craftItem`, `smeltItem`, `killMob`, `placeItem`, `exploreUntil`, `useChest`) are small MIT Mineflayer wrappers worth reading. Everything else is stale (2023, mineflayer 4.8, Python LLM loop, per-step GPT calls) and conflicts with the goal of minimal runtime LLM use.

**Mindcraft — ADAPT as reference.** `src/agent/library/skills.js` (≈80 KB, MIT) holds battle-tested wrappers: `goToSurface`, `digDown`, `smeltItem`, `collectBlock`, `avoidEnemies`, `goToBed`, `pickupNearbyItems`. Its `patches/` directory is a free list of known upstream bugs (pathfinder lava/doors, the pvp tick event, a viewer unknown-entity crash, mineflayer water/rotation). Reject the runtime, which makes an LLM call per action and supports many model providers.

### Skills, combat, survival
- **collectblock (USE):** pathing plus tool selection plus item pickup for "get N of block X".
- **auto-eat and armor-manager (USE):** mechanics we would otherwise write ourselves.
- **pvp (ADAPT):** simple melee follow-and-attack. Mindcraft patches `physicTick` to `physicsTick`, so check on install and vendor it (~300 LOC) if needed.
- **Ranged combat:** hawkeye has no license and custom-pvp is GPL. End crystals are static targets, so ballistic aim is a small custom function, and the bed strategy against the dragon needs no aiming.
- **Crafting:** Mineflayer handles single recipes. mineflayer-crafting-util plans recursive trees; adopt it if it passes tests, otherwise write a ~200 LOC resolver over `minecraft-data`.
- **Structure detection:** no library exists. It is custom but thin: `bot.findBlocks` over loaded chunks (nether bricks → fortress, end portal frame → stronghold), with entity tracking of thrown `eye_of_ender` for triangulation.

### Observation and screenshots
**prismarine-viewer — optional USE.** It has browser view (`mineflayer({port})`) for humans and `headless` rendering to video/frames for failure bundles. Native textures go up to 1.21.4, and later versions render with the nearest assets. Headless rendering needs native `node-canvas-webgl`/`gl` builds, which are fragile on new Node and macOS versions. Make it an optional dependency so a broken build can never block a run. Structured JSON remains the primary observation.

### Server, worlds, batch evaluation
- **Vanilla server via minecraft-wrap — USE.** It downloads the official jar and starts and stops it programmatically; Mineflayer's own external tests run on it. The 1.16.1 server runs on a project-local Java 8 (see the 1.16.1 audit above). A world reset means deleting the world directory and restarting with a new `level-seed`.
- **Ground truth for the evaluator** comes from the server log: death messages, advancement lines such as `[Free the End]`, and dimension changes. The bot never sees this log.
- **Paper** alters vanilla behavior, which would invalidate results. **Docker/itzg** is the scale-out option on Linux later.
- **`/tick`** does not exist in 1.16.1. Game speed is never altered in scored runs.

### Coding-agent inspection
Claude Code and Codex already read files and run commands, so an MCP server isn't needed at first. The evaluator should write JSONL events, `summary.json` and a failure bundle per run, and a small inspector CLI should summarize them. A localhost-only control endpoint (`observe`/`pause`) on the bot process covers live inspection. minecraft-mcp-server is a reasonable pattern if an MCP wrapper becomes useful later, but it exposes *control* to an LLM, which this project avoids at runtime.

### Ender Dragon progression tooling
No maintained Mineflayer library covers Nether fortress search, blaze farming, piglin bartering, eye triangulation, portal-frame filling or dragon combat. AltoClef is the only complete reference. These are the core custom skills of the project.

## Sources
[mineflayer](https://github.com/PrismarineJS/mineflayer) · [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) · [miner-org/mineflayer-baritone](https://github.com/miner-org/mineflayer-baritone) · [minecraft-pathfinding](https://github.com/Minecraft-Pathfinding/minecraft-pathfinding) · [baritone-ts](https://github.com/nuxdie/baritone-ts) · [Baritone](https://github.com/cabaletta/baritone) · [AltoClef (MiranCZ)](https://github.com/MiranCZ/altoclef) · [Voyager](https://github.com/MineDojo/Voyager) · [Mindcraft](https://github.com/mindcraft-bots/mindcraft) · [prismarine-viewer](https://github.com/PrismarineJS/prismarine-viewer) · [minecraft-wrap](https://github.com/PrismarineJS/node-minecraft-wrap) · [mineflayer-collectblock](https://github.com/PrismarineJS/mineflayer-collectblock) · [mineflayer-pvp](https://github.com/PrismarineJS/mineflayer-pvp) · [mineflayer-auto-eat](https://github.com/linkle69/mineflayer-auto-eat) · [mineflayer-crafting-util](https://github.com/GenerelSchwerz/mineflayer-crafting-util) · [minecraft-mcp-server](https://github.com/yuniko-software/minecraft-mcp-server) · [HeadlessMC](https://github.com/headlesshq/headlessmc) · [itzg/docker-minecraft-server](https://github.com/itzg/docker-minecraft-server)

# Minecraft AI bot

Headless Mineflayer bot for vanilla Minecraft Java Edition **1.16.1**, working toward autonomous Ender Dragon kills on unseen random seeds.

Read [PROJECT.md](PROJECT.md), [AGENTS.md](AGENTS.md), then `docs/`. Current state: **milestone A** (stable Overworld progression to `nether_ready`) implemented and under gate evaluation; see [docs/milestones.md](docs/milestones.md) and the gate log in [docs/evaluation.md](docs/evaluation.md).

## Setup

Requires Node 22 (`.nvmrc`) for the bot and evaluator. The 1.16.1 server runs on **Java 8** (its Mojang manifest declares `jre-legacy`, major 8). The evaluator always starts it with an explicit Java 8 executable and never uses the `java` on your `PATH`.

```sh
nvm use            # Node 22
npm ci
npm run setup      # vanilla 1.16.1 server jar (sha1-checked) + a project-local Java 8 JRE, both into .cache/
```

`npm run setup` downloads Azul Zulu 8 (a GA, TCK-certified JRE, checked against Azul's published SHA-256) into `.cache/java/` for this OS and architecture. To use a Java 8 you already have, set `MC_JAVA=/path/to/java8/bin/java`. The evaluator refuses any other Java major.

The server starts with `config/log4j2-server.xml`, the jar's own log configuration plus `%msg{nolookups}`. 1.16.1 bundles log4j 2.8.1, which is vulnerable to Log4Shell (CVE-2021-44228).

## Run

```sh
npm test                                   # unit tests (no server needed)
npm run build                              # type check
npm run test:scenario                      # real-server fixtures on a 1.16.1 flat world: navigation, protocol, acquisition, survival (development only)
npm run eval -- --scenario m0 --n 10       # M0 batch on 10 fresh random seeds (scripted reasoner, 10 min limit)
npm run eval -- --scenario a --set dev --n 5          # milestone A development batch (45 min limit, reasoner none)
caffeinate -dimsu npm run eval -- --scenario a --n 20 # milestone A gate on fresh held-out seeds (keep the host awake)
npm run navbench -- --n 5                  # navigation benchmark (evaluation.md §6)
npm run navbench -- --n 5 --fixture excavation   # labeled fixture: tools + peaceful, isolates excavation
npm run inspect -- run <runId>             # one run: outcome, timeline, ground truth, bundles, last digest
npm run inspect -- batch <batchId>         # aggregates → runs/<batchId>/report.md
```

Options for `eval`: `--parallel N`, `--limit 10m`, `--reasoner none|scripted`, `--replay <runId,…>` (reuse private seeds for debugging, never for gates), `--keep-world`, `--label x`, `--fixture kit|kit2|excavation`.

## Layout

`src/` follows architecture.md §11: `schema/`, `bot/` (entry point), `nav/` (the only pathfinder user), `observer/`, `skills/` (runner + `navigate`/`collect`/`craft`), `controller/`, `planner/` (policy, reasoner interface), `telemetry/`, `evaluation/` (server lifecycle, Java runtime, seeds, ground truth, batches, inspect). Version facts not provided by minecraft-data live in `src/version.ts`. Run artifacts land in `runs/<batchId>/<runId>/` (evaluation.md §4); world dirs live in `.cache/worlds/` and are deleted after each run.

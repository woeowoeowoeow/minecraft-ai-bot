# Minecraft AI bot

Headless Mineflayer bot for vanilla Java 1.21.4, working toward autonomous Ender Dragon kills on unseen random seeds.

Read [PROJECT.md](PROJECT.md), [AGENTS.md](AGENTS.md), then `docs/`. Current state: **M0** (harness + walking skeleton) in [docs/milestones.md](docs/milestones.md).

## Setup

Requires Node 22 (`.nvmrc`) and Java 21.

```sh
nvm use            # Node 22
npm ci
npm run setup      # downloads the vanilla 1.21.4 server jar into .cache/
```

## Run

```sh
npm test                                   # unit tests (no server needed)
npm run build                              # type check
npm run eval -- --scenario m0 --n 10       # M0 batch on 10 fresh random seeds (scripted reasoner, 10 min limit)
npm run navbench -- --n 5                  # navigation benchmark (evaluation.md §6)
npm run inspect -- run <runId>             # one run: outcome, timeline, ground truth, bundles, last digest
npm run inspect -- batch <batchId>         # aggregates → runs/<batchId>/report.md
```

Options for `eval`: `--parallel N`, `--limit 10m`, `--reasoner none|scripted`, `--replay <runId,…>` (reuse private seeds for debugging, never for gates), `--keep-world`, `--label x`.

## Layout

`src/` follows architecture.md §11: `schema/`, `bot/` (entry point), `nav/` (the only pathfinder user), `observer/`, `skills/` (runner + `navigate`/`collect`/`craft`), `controller/`, `planner/` (policy, reasoner interface), `telemetry/`, `evaluation/` (server lifecycle, seeds, ground truth, batches, inspect). Run artifacts land in `runs/<batchId>/<runId>/` (evaluation.md §4); world dirs live in `.cache/worlds/` and are deleted after each run.

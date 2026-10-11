// npm run eval -- --scenario m0 --n 10 [--parallel 1] [--limit 10m] [--reasoner scripted|none] [--replay <runId,...>] [--keep-world] [--label x]
// npm run navbench -- --n 5 [--fixture kit]
// npm run eval -- --scenario a --n 20 (milestone A: 45 min limit, reasoner none)
// npm run eval -- --scenario b --n 20 (milestone B: 70 min limit, reasoner none) [--fixture bkit for development]
// npm run eval -- --scenario c --n 20 (milestone C: 120 min limit, reasoner none) [--fixture ckit for development]
// npm run eval -- --resume <batchId> (continue an interrupted batch from its private seed manifest)
//   B batches apply the predeclared early-fail rules (evaluation.md §1, early-fail rules); --no-early-stop disables them
// npm run inspect -- early-stop <batchId|runId> (replay the early-fail rules over finished runs)
// npm run inspect -- run <runId> | batch <batchId>
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { ScenarioS } from '../schema/index.js'
import { runBatch } from './batch.js'
import { inspectBatch, inspectRun } from './inspect.js'
import { inspectEarlyStop } from './early-stop-report.js'
import { FIXTURES, JAR, type FixtureName } from './run.js'

function parseDuration (s: string): number {
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/)
  if (!m) throw new Error(`bad duration ${s}`)
  const n = Number(m[1])
  return Math.round(n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 'ms' | 's' | 'm' | 'h'] ?? 60_000))
}

async function main (): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'inspect') {
    const [what, id] = rest
    if (!id || (what !== 'run' && what !== 'batch' && what !== 'early-stop')) throw new Error('usage: inspect run <runId> | inspect batch <batchId> | inspect early-stop <batchId|runId>')
    console.log(what === 'run' ? inspectRun(id) : what === 'batch' ? inspectBatch(id) : inspectEarlyStop(id))
    return
  }
  if (cmd !== 'eval') throw new Error('usage: cli.ts eval … | cli.ts inspect …')
  const { values } = parseArgs({
    args: rest,
    options: {
      scenario: { type: 'string', default: 'm0' },
      n: { type: 'string', default: '10' },
      parallel: { type: 'string', default: '1' },
      limit: { type: 'string' },
      reasoner: { type: 'string' },
      replay: { type: 'string' },
      'keep-world': { type: 'boolean', default: false },
      label: { type: 'string' },
      fixture: { type: 'string' },
      set: { type: 'string', default: 'heldout' },
      resume: { type: 'string' },
      'no-early-stop': { type: 'boolean', default: false },
    },
  })
  const scenario = ScenarioS.parse(values.scenario)
  if (!existsSync(JAR)) throw new Error(`server jar missing at ${JAR}; run: npm run setup`)
  const batchId = await runBatch({
    scenario,
    n: Number(values.n),
    parallel: Number(values.parallel),
    limitMs: parseDuration(values.limit ?? (scenario === 'navbench' ? '25m' : scenario === 'a' ? '45m' : scenario === 'b' ? '70m' : scenario === 'c' ? '120m' : '10m')),
    reasoner: (values.reasoner ?? (scenario === 'm0' ? 'scripted' : 'none')) as 'none' | 'scripted',
    set: values.replay ? 'replay' : values.set === 'dev' ? 'dev' : 'heldout',
    replay: values.replay?.split(','),
    keepWorld: values['keep-world'],
    label: values.label,
    resume: values.resume,
    earlyStop: values['no-early-stop'] ? false : undefined,
    fixture: values.fixture === undefined ? undefined : values.fixture in FIXTURES ? values.fixture as FixtureName : (() => { throw new Error(`unknown fixture ${values.fixture}`) })(),
  })
  console.log('\n' + inspectBatch(batchId))
  console.log(`\nbatch ${batchId} → runs/${batchId}/report.md`)
  process.exit(0)
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})

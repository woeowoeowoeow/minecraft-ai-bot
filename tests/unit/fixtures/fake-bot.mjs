// Fake bot process. Modes: success | crash | hang (ignores SIGTERM) | slow (finishes on SIGTERM)
import { writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
const mode = process.argv[2]
const cfg = JSON.parse(process.env.BOT_CONFIG)
writeFileSync(join(cfg.runDir, 'env.json'), JSON.stringify({ env: process.env, argv: process.argv }))
const result = (outcome) => ({
  outcome, reason: mode, elapsedS: 1, gameTicks: 20, milestones: { M0: outcome === 'goal_reached' ? 1 : null }, flags: {}, deaths: [],
  terminalFailure: null, failures: [], skills: {}, nav: { calls: 0, ok: 0, stuck: 0, unreachable: 0, hazard: 0, timeout: 0, cancelled: 0, stuckEvents: 0, blocksTravelled: 0, byProfile: {} },
  reasoner: { calls: 0, byKind: {}, fallbacks: 0, impl: 'none' }, physicsCorrections: 0,
})
for (const f of ['events.jsonl', 'trace.jsonl', 'state.jsonl']) appendFileSync(join(cfg.runDir, f), '{}\n')
if (mode === 'crash') process.exit(1)
if (mode === 'success') writeFileSync(join(cfg.runDir, 'bot_result.json'), JSON.stringify(result('goal_reached')))
if (mode === 'hang') process.on('SIGTERM', () => {})
if (mode === 'slow') process.on('SIGTERM', () => { writeFileSync(join(cfg.runDir, 'bot_result.json'), JSON.stringify(result('timeout'))); process.exit(0) })
if (mode === 'success') process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1000)

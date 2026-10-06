// Fake bot process. Modes: success | crash | hang (ignores SIGTERM) | slow (finishes on SIGTERM)
// | exhaust (logs one objective's recovery ladder exhausted twice with no alternate, one death; finishes on SIGTERM)
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
if (mode === 'exhaust') {
  const ev = (t, type, data) => appendFileSync(join(cfg.runDir, 'events.jsonl'), JSON.stringify({ t, tick: t * 20, type, sev: 'info', data }) + '\n')
  ev(1, 'objective', { id: 'wooden_pickaxe', skill: 'obtain' })
  for (const t of [10, 20]) {
    ev(t, 'recovery_step', { level: 'L3', action: 'suspend', objective: 'wooden_pickaxe', note: 'strategies exhausted for wooden_pickaxe', signature: 'SEARCH_EXHAUSTED|x' })
    ev(t + 1, 'recovery_step', { level: 'L3', action: 'suspend_skipped', objective: 'wooden_pickaxe', note: 'no other objective available; relocating instead' })
  }
  process.on('SIGTERM', () => { writeFileSync(join(cfg.runDir, 'bot_result.json'), JSON.stringify({ ...result('timeout'), deaths: [{ t: 5, dim: 'overworld', message: 'Bot was slain by Zombie' }] })); process.exit(0) })
}
setInterval(() => {}, 1000)

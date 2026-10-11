// Full skill runtime (milestones A–C) on a fixture bot: Observer, SkillRunner with
// every A skill, and the same SkillEnv the bot process builds (src/bot/main.ts).
import { mulberry32 } from '../../src/bot/rng.js'
import { Observer } from '../../src/observer/observer.js'
import type { SkillResult } from '../../src/schema/index.js'
import { registerCSkills } from '../../src/skills/registry.js'
import { SkillRunner } from '../../src/skills/runner.js'
import type { SkillEnv } from '../../src/skills/types.js'
import type { Fixture } from './harness.js'

export type Runtime = { obs: Observer; runner: SkillRunner; env: SkillEnv; run (skill: string, params: unknown): Promise<SkillResult>; inv (): Record<string, number> }

export function runtime (f: Fixture): Runtime {
  const obs = new Observer(f.bot, f.bus)
  obs.start()
  const env: SkillEnv = {
    bot: f.bot, nav: f.nav, bus: f.bus,
    state: () => obs.state(),
    memory: obs.memory,
    isBlacklisted: k => obs.isBlacklisted(k),
    blacklist: (k, r, s) => obs.blacklist(k, r, s),
    halt: () => { f.nav.stop(); f.bot.clearControlStates(); try { f.bot.stopDigging() } catch { /* ignore */ } },
    random: mulberry32(11),
    capture: () => {},
  }
  const runner = registerCSkills(new SkillRunner(env))
  return {
    obs, runner, env,
    run: async (skill, params) => {
      const r = await runner.run(skill, params)
      if (r.status !== 'success') {
        console.log('SKILL', skill, r.status, JSON.stringify(r.failure)?.slice(0, 600))
        for (const ev of f.events.slice(-30)) if (!['physics_correction', 'excavation_step', 'nav_start'].includes(ev.type)) console.log('  ev', ev.type, JSON.stringify(ev.data).slice(0, 260))
      }
      return r
    },
    inv: () => obs.inventory(),
  }
}

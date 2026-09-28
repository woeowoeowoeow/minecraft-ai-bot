import { collect } from './generic/collect.js'
import { craft } from './generic/craft.js'
import { navigate } from './generic/navigate.js'
import type { SkillRunner } from './runner.js'

/** M0 skill set. Later milestones register more here. */
export function registerM0Skills (runner: SkillRunner): SkillRunner {
  return runner.register(navigate).register(collect).register(craft)
}

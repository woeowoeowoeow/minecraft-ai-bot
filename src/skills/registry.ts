import { collect } from './generic/collect.js'
import { craft } from './generic/craft.js'
import { explore, relocate } from './generic/explore.js'
import { fillBucket } from './generic/fill.js'
import { hunt } from './generic/hunt.js'
import { mine } from './generic/mine.js'
import { navigate } from './generic/navigate.js'
import { obtain } from './generic/obtain.js'
import { recoverItems } from './generic/recover.js'
import { smelt } from './generic/smelt.js'
import { findLavaPool } from './progression/lava.js'
import { netherExcursion, usePortal } from './progression/nether.js'
import { buildNetherPortal } from './progression/portal.js'
import type { SkillRunner } from './runner.js'
import { defend, flee } from './survival/combat.js'
import { cover } from './survival/cover.js'
import { eat, equipGear, holdSafe, manageInventory, pickupDrops, rest, shelter } from './survival/maintenance.js'
import { escapeLava, escapeSuffocation, extinguish, surfaceForAir } from './survival/reflexes.js'

/** M0 skill set. */
export function registerM0Skills (runner: SkillRunner): SkillRunner {
  return runner.register(navigate).register(collect).register(craft)
}

/** Milestone A: generic acquisition (architecture §6.1) plus the survival skills behind P0–P2. */
export function registerASkills (runner: SkillRunner): SkillRunner {
  registerM0Skills(runner)
  for (const s of [explore, relocate, mine, smelt, hunt, fillBucket, obtain, recoverItems, findLavaPool, escapeLava, extinguish, surfaceForAir, escapeSuffocation, defend, flee, cover, eat, equipGear, manageInventory, pickupDrops, holdSafe, shelter, rest]) runner.register(s)
  return runner
}

/** Milestone B: everything in A plus the portal builder and the Nether trip (architecture §6.1 progression skills). */
export function registerBSkills (runner: SkillRunner): SkillRunner {
  registerASkills(runner)
  for (const s of [buildNetherPortal, usePortal, netherExcursion]) runner.register(s)
  return runner
}

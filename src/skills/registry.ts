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
import { barterPearls, huntEndermen } from './progression/barter.js'
import { collectBlazeRods } from './progression/blaze.js'
import { findFortress } from './progression/fortress.js'
import { bastionGold } from './progression/bastion.js'
import { setSpawnBed, stashKit, takeStash } from './progression/stash.js'
import type { SkillRunner } from './runner.js'
import { defend, flee } from './survival/combat.js'
import { cover } from './survival/cover.js'
import { deflect } from './survival/ghast.js'
import { eat, equipGear, holdSafe, manageInventory, pickupDrops, rest, shelter } from './survival/maintenance.js'
import { escapeLava, escapeSuffocation, escapeWater, extinguish, leavePortal, stepOffMagma, surfaceForAir } from './survival/reflexes.js'

/** M0 skill set. */
export function registerM0Skills (runner: SkillRunner): SkillRunner {
  return runner.register(navigate).register(collect).register(craft)
}

/** Milestone A: generic acquisition (architecture §6.1) plus the survival skills behind P0–P2. */
export function registerASkills (runner: SkillRunner): SkillRunner {
  registerM0Skills(runner)
  for (const s of [explore, relocate, mine, smelt, hunt, fillBucket, obtain, recoverItems, findLavaPool, escapeLava, extinguish, stepOffMagma, leavePortal, escapeWater, surfaceForAir, escapeSuffocation, defend, flee, cover, eat, equipGear, manageInventory, pickupDrops, holdSafe, shelter, rest]) runner.register(s)
  return runner
}

/** Milestone B: everything in A plus the portal builder and the Nether trip (architecture §6.1 progression skills). */
export function registerBSkills (runner: SkillRunner): SkillRunner {
  registerASkills(runner)
  // `deflect` (P0, ghast fire) only fires in the Nether.
  for (const s of [buildNetherPortal, usePortal, netherExcursion, deflect]) runner.register(s)
  return runner
}

/** Milestone C: everything in B plus the fortress search, blaze rods and pearls (architecture §6.1 progression skills). */
export function registerCSkills (runner: SkillRunner): SkillRunner {
  registerBSkills(runner)
  for (const s of [findFortress, collectBlazeRods, barterPearls, huntEndermen, bastionGold, stashKit, takeStash, setSpawnBed]) runner.register(s)
  return runner
}

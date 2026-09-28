// Collision epsilon for prismarine-physics (the client physics Mineflayer runs).
//
// prismarine-physics 1.11.1 resolves collisions with exact float comparisons. A bot
// pushed flush against a wall at x = 2 ends at pos.x = 2.3, so its box edge is
// 2.3 - 0.3 = 1.9999999999999998: "inside" the wall by 2e-16. From then on the wall
// no longer blocks horizontal motion (it only blocks boxes that start outside it),
// and it wrongly blocks vertical motion (the boxes "overlap"). The client drifts into
// the block, the server rejects every move and teleports it back, forever
// (M0: ~20 position corrections/s for minutes; also 1-wide staircases).
// Vanilla avoids this with a 1e-7 tolerance in its collision code; we do the same.
import { createRequire } from 'node:module'

const EPS = 1e-7

type Box = { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
type AabbProto = {
  computeOffsetX (this: Box, o: Box, d: number): number
  computeOffsetY (this: Box, o: Box, d: number): number
  computeOffsetZ (this: Box, o: Box, d: number): number
  __navEpsilon?: boolean
}

/** Idempotent. `this` is the obstacle, `o` the moving box, `d` the desired offset. */
export function installCollisionEpsilon (): void {
  const AABB = createRequire(import.meta.url)('prismarine-physics/lib/aabb.js') as { prototype: AabbProto }
  const p = AABB.prototype
  if (p.__navEpsilon) return
  p.computeOffsetX = function (o, d) {
    if (o.maxY > this.minY + EPS && o.minY < this.maxY - EPS && o.maxZ > this.minZ + EPS && o.minZ < this.maxZ - EPS) {
      if (d > 0 && o.maxX <= this.minX + EPS) d = Math.min(Math.max(0, this.minX - o.maxX), d)
      else if (d < 0 && o.minX >= this.maxX - EPS) d = Math.max(Math.min(0, this.maxX - o.minX), d)
    }
    return d
  }
  p.computeOffsetY = function (o, d) {
    if (o.maxX > this.minX + EPS && o.minX < this.maxX - EPS && o.maxZ > this.minZ + EPS && o.minZ < this.maxZ - EPS) {
      if (d > 0 && o.maxY <= this.minY + EPS) d = Math.min(Math.max(0, this.minY - o.maxY), d)
      else if (d < 0 && o.minY >= this.maxY - EPS) d = Math.max(Math.min(0, this.maxY - o.minY), d)
    }
    return d
  }
  p.computeOffsetZ = function (o, d) {
    if (o.maxX > this.minX + EPS && o.minX < this.maxX - EPS && o.maxY > this.minY + EPS && o.minY < this.maxY - EPS) {
      if (d > 0 && o.maxZ <= this.minZ + EPS) d = Math.min(Math.max(0, this.minZ - o.maxZ), d)
      else if (d < 0 && o.minZ >= this.maxZ - EPS) d = Math.max(Math.min(0, this.maxZ - o.minZ), d)
    }
    return d
  }
  p.__navEpsilon = true
}

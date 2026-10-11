// Nether structure census (architecture §14.2: "a structure census fixture must
// measure the typical search radius before any budget is tuned"). Evaluator-only
// development measurement: fresh random seeds, console `locate` from a grid of Nether
// positions. Nothing here is visible to the bot, and no result feeds back into src/
// except as documented, seed-independent game facts (region grid, distance statistics).
//
// npm run census -- --n 20 [--extent 1200] [--step 300]
import { join } from 'node:path'
import { rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { freePort, freshSeed, RUNS } from './batch.js'
import { resolveJava } from './java.js'
import { ProcessRegistry } from './procs.js'
import { JAR, ROOT, WORLDS } from './run.js'
import { ServerProcess } from './server.js'

type Found = { kind: 'fortress' | 'bastion'; x: number; z: number }

/** Region of a block coordinate on a structure grid of `spacing` chunks. */
export function regionOf (block: number, spacing = 27): { region: number; offset: number } {
  const c = Math.floor(block / 16)
  const region = Math.floor(c / spacing)
  return { region, offset: c - region * spacing }
}

const LOCATE_RE = /The nearest (\S+) is at \[(-?\d+), [^,]+, (-?\d+)\]/

async function censusSeed (seed: string, extent: number, step: number, registry: ProcessRegistry, javaBin: string): Promise<Found[]> {
  const worldDir = join(WORLDS, `census-${Date.now()}`)
  const port = await freePort()
  const server = new ServerProcess({ worldDir, port, seed, jarPath: JAR, javaBin, properties: { 'spawn-monsters': 'false', 'spawn-animals': 'false' } }, registry)
  const out = new Map<string, Found>()
  try {
    await server.start()
    for (let x = -extent; x <= extent; x += step) {
      for (let z = -extent; z <= extent; z += step) {
        for (const [kind, name] of [['fortress', 'fortress'], ['bastion', 'bastion_remnant']] as const) {
          const m = await server.query(`execute in minecraft:the_nether positioned ${x} 64 ${z} run locate ${name}`, LOCATE_RE, 20_000)
          if (!m) continue
          const f: Found = { kind, x: Number(m[2]), z: Number(m[3]) }
          out.set(`${kind}:${f.x},${f.z}`, f)
        }
      }
    }
  } finally {
    await server.stop().catch(() => {})
    rmSync(worldDir, { recursive: true, force: true })
  }
  return [...out.values()]
}

async function main (): Promise<void> {
  const { values } = parseArgs({ options: { n: { type: 'string', default: '20' }, extent: { type: 'string', default: '1200' }, step: { type: 'string', default: '300' } } })
  const registry = new ProcessRegistry(join(ROOT, '.cache', 'pids'))
  registry.installExitHandlers()
  const java = resolveJava(ROOT)
  const dir = join(RUNS, `census-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const rows: { seedIdx: number; found: Found[] }[] = []
  for (let i = 0; i < Number(values.n); i++) {
    const found = await censusSeed(freshSeed(), Number(values.extent), Number(values.step), registry, java.bin)
    rows.push({ seedIdx: i, found })
    console.log(`seed ${i + 1}: ${found.filter(f => f.kind === 'fortress').length} fortresses, ${found.filter(f => f.kind === 'bastion').length} bastions`)
    writeFileSync(join(dir, 'census.json'), JSON.stringify(rows, null, 1))
  }
  console.log(`census → ${dir}/census.json`)
  process.exit(0)
}

if (process.argv[1] && process.argv[1].endsWith('census.ts')) main().catch(e => { console.error(e); process.exit(1) })

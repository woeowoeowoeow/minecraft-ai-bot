import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { botEnv } from '../../src/evaluation/run.js'

const SRC = join(import.meta.dirname, '..', '..', 'src')
const BOT_SIDE = ['bot', 'nav', 'observer', 'skills', 'controller', 'planner', 'recovery', 'telemetry', 'schema']

function files (dir: string): string[] {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []
  })
}

describe('run-rule isolation (evaluation.md §2)', () => {
  const botFiles = BOT_SIDE.flatMap(d => files(join(SRC, d)))

  it('bot-side code never imports the evaluator', () => {
    for (const f of botFiles) expect(readFileSync(f, 'utf8'), f).not.toMatch(/from ['"][./]*\/evaluation\//)
  })

  it('bot-side code never touches seeds, server logs, world dirs or ground truth', () => {
    const banned = /seed\.txt|level-seed|server\.log|ground_truth|\/private\/|worlds\/|\.cache/
    for (const f of botFiles) expect(readFileSync(f, 'utf8'), f).not.toMatch(banned)
  })

  it('bot-side code sends no chat commands', () => {
    for (const f of botFiles) expect(readFileSync(f, 'utf8'), f).not.toMatch(/bot\.chat\(|\.chat\(\s*['"`]\//)
  })

  it('only src/nav/pathfinder.ts imports mineflayer-pathfinder', () => {
    const importers = files(SRC).filter(f => /from ['"]mineflayer-pathfinder['"]/.test(readFileSync(f, 'utf8')))
    expect(importers.map(f => f.slice(SRC.length + 1))).toEqual(['nav/pathfinder.ts'])
  })

  it('no numeric seed literals or hardcoded coordinates in config/', () => {
    const cfgDir = join(SRC, '..', 'config')
    for (const f of readdirSync(cfgDir, { recursive: true }) as string[]) {
      const p = join(cfgDir, f)
      if (statSync(p).isDirectory()) continue
      expect(readFileSync(p, 'utf8'), f).not.toMatch(/seed|-?\d{6,}/i)
    }
  })

  it('bot environment is a whitelist without the seed', () => {
    process.env.LEAKY_SEED = '123456789'
    const env = botEnv({ host: 'h', port: 1, username: 'Bot', runDir: '/r', scenario: 'm0', reasoner: 'none', limitMs: 1 }, 0)
    expect(Object.keys(env).sort()).toEqual(expect.arrayContaining(['BOT_CONFIG', 'BOT_LINGER_MS']))
    expect(JSON.stringify(env)).not.toContain('123456789')
    delete process.env.LEAKY_SEED
  })
})

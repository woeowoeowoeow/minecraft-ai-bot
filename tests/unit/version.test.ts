import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mcData from 'minecraft-data'
import { describe, expect, it } from 'vitest'
import { parseJavaMajor, resolveJava } from '../../src/evaluation/java.js'
import { SERVER_PROPERTIES } from '../../src/evaluation/server.js'
import { entityKind } from '../../src/observer/observer.js'
import { ENTITY_KIND_GAPS, MC_VERSION, OVERWORLD, UNDERGROUND } from '../../src/version.js'

/** A fake `java` that prints the given `-version` banner to stderr. */
function fakeJava (banner: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'java-'))
  const bin = join(dir, 'java')
  writeFileSync(bin, `#!/bin/sh\necho '${banner}' >&2\n`)
  chmodSync(bin, 0o755)
  return bin
}

describe('server Java runtime', () => {
  it('parses legacy and modern version banners', () => {
    expect(parseJavaMajor('openjdk version "1.8.0_504"')).toBe(8)
    expect(parseJavaMajor('openjdk version "21.0.2" 2024-01-16 LTS')).toBe(21)
    expect(parseJavaMajor('java version "11.0.17"')).toBe(11)
    expect(parseJavaMajor('garbage')).toBeNull()
  })

  it('accepts only Java 8 for the 1.16.1 server', () => {
    expect(resolveJava('/nonexistent', { MC_JAVA: fakeJava('openjdk version "1.8.0_504"') })).toMatchObject({ major: 8, version: '1.8.0_504' })
    expect(() => resolveJava('/nonexistent', { MC_JAVA: fakeJava('openjdk version "21.0.2"') })).toThrow(/Java 21; the server needs Java 8/)
    expect(() => resolveJava('/nonexistent', {})).toThrow(/no Java 8 runtime/)
  })
})

describe('1.16.1 version facts', () => {
  it('pins 1.16.1 and uses only properties the 1.16.1 server reads', () => {
    expect(MC_VERSION).toBe('1.16.1')
    expect(SERVER_PROPERTIES['level-type']).toBe('default')
    expect(SERVER_PROPERTIES).not.toHaveProperty('simulation-distance')
    expect(SERVER_PROPERTIES).not.toHaveProperty('enforce-secure-profile')
  })

  it('underground bands sit above the lava level and inside the world', () => {
    expect(UNDERGROUND.caveBand[0]).toBeGreaterThan(UNDERGROUND.lavaLevel)
    expect(UNDERGROUND.miningY).toBeGreaterThan(UNDERGROUND.lavaLevel)
    expect(UNDERGROUND.diamondY).toBeGreaterThan(UNDERGROUND.lavaLevel)
    expect(UNDERGROUND.caveBand[1]).toBeLessThan(OVERWORLD.seaLevel)
    expect(OVERWORLD.minY).toBe(0)
  })

  it('classifies entities by category, filling the 1.16.1 data gaps', () => {
    const d = mcData(MC_VERSION)
    const e = (name: string) => ({ name, type: d.entitiesByName[name]!.type, kind: d.entitiesByName[name]!.category })
    expect(d.entitiesByName.zombie!.type).toBe('mob') // 1.16.1 data: type does not separate hostile from passive
    expect(entityKind(e('zombie'))).toBe('hostile')
    expect(entityKind(e('cow'))).toBe('passive')
    expect(entityKind(e('piglin'))).toBe('hostile')
    expect(entityKind(e('zombified_piglin'))).toBe('passive')
    expect(entityKind({ name: 'item', type: 'mob', kind: 'Drops' })).toBe('item')
    expect(entityKind({ name: 'Bot', type: 'player', kind: 'UNKNOWN' })).toBe('player')
    for (const name of Object.keys(ENTITY_KIND_GAPS)) expect(d.entitiesByName[name], name).toBeDefined()
    expect(d.entitiesByName.piglin_brute).toBeUndefined() // added in 1.16.2
  })
})

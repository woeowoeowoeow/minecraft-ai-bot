// Java runtime for the vanilla server (evaluator-only). The 1.16.1 server runs on
// the Java major its Mojang manifest declares (8), invoked by explicit path, so the
// developer's global Java (and Node) are left alone.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { JAVA_MAJOR } from '../version.js'

/** Where `npm run setup` unpacks the Java 8 runtime. */
export function javaCacheDir (root: string): string {
  return join(root, '.cache', 'java')
}

/** `bin/java` inside an unpacked JRE/JDK archive (the Azul tarball nests a versioned dir; macOS bundles add Contents/Home). */
export function findJavaIn (dir: string): string | null {
  if (!existsSync(dir)) return null
  const candidates = [join(dir, 'bin', 'java')]
  for (const d of readdirSync(dir)) {
    candidates.push(join(dir, d, 'bin', 'java'), join(dir, d, 'Contents', 'Home', 'bin', 'java'), join(dir, d, 'zulu-8.jre', 'Contents', 'Home', 'bin', 'java'))
  }
  return candidates.find(p => existsSync(p)) ?? null
}

/** Major version from `java -version` output: "1.8.0_504" → 8, "21.0.2" → 21. */
export function parseJavaMajor (versionOutput: string): number | null {
  const m = versionOutput.match(/version "(\d+)(?:\.(\d+))?/)
  if (!m) return null
  const a = Number(m[1])
  return a === 1 ? Number(m[2]) : a
}

export type JavaRuntime = { bin: string; major: number; version: string }

/**
 * The server's Java: `MC_JAVA` (explicit path) or the runtime installed by
 * `npm run setup`. Throws unless it reports major version JAVA_MAJOR.
 */
export function resolveJava (root: string, env: NodeJS.ProcessEnv = process.env): JavaRuntime {
  const bin = env.MC_JAVA || findJavaIn(javaCacheDir(root))
  if (!bin) throw new Error(`no Java ${JAVA_MAJOR} runtime for the server: set MC_JAVA or run \`npm run setup\``)
  // `java -version` prints to stderr.
  const r = spawnSync(bin, ['-version'], { encoding: 'utf8' })
  const out = `${r.stderr ?? ''}${r.stdout ?? ''}`
  const major = parseJavaMajor(out)
  if (major !== JAVA_MAJOR) throw new Error(`${bin} is Java ${major ?? '?'}; the server needs Java ${JAVA_MAJOR} (set MC_JAVA or run \`npm run setup\`)`)
  const version = out.match(/version "([^"]+)"/)?.[1] ?? '?'
  return { bin, major, version }
}

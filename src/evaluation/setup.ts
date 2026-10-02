// Evaluator-only setup: the pinned vanilla server jar and a project-local Java 8
// runtime for it, both in .cache/. Never changes the global Java or Node.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as wrapNs from 'minecraft-wrap'
import { JAVA_MAJOR, MC_VERSION } from '../version.js'
import { javaCacheDir, resolveJava } from './java.js'
import { JAR, ROOT } from './run.js'

/** SHA-1 of the official 1.16.1 server jar, from Mojang's version manifest. */
const SERVER_SHA1 = 'a412fd69db1f81db3f511c1463fd304675244077'

type Wrap = { downloadServer (v: string, file: string, cb: (err: Error | null) => void): void }
const wrap = ((wrapNs as unknown as { default?: Wrap }).default ?? wrapNs) as unknown as Wrap

const sha = (algo: string, file: string) => createHash(algo).update(readFileSync(file)).digest('hex')

async function serverJar (): Promise<void> {
  mkdirSync(dirname(JAR), { recursive: true })
  try {
    if (sha('sha1', JAR) === SERVER_SHA1) { console.log(`server ${MC_VERSION}: ${JAR} (sha1 ok)`); return }
  } catch { /* missing */ }
  await new Promise<void>((resolve, reject) => wrap.downloadServer(MC_VERSION, JAR, err => (err ? reject(err) : resolve())))
  const got = sha('sha1', JAR)
  if (got !== SERVER_SHA1) throw new Error(`server jar sha1 ${got} ≠ manifest ${SERVER_SHA1}`)
  console.log(`server ${MC_VERSION} → ${JAR} (sha1 ok)`)
}

/** Azul Zulu JRE (GA, TCK-certified) for this host, verified by the SHA-256 Azul publishes. */
async function java (): Promise<void> {
  try {
    const j = resolveJava(ROOT)
    console.log(`java ${j.version} (major ${j.major}): ${j.bin}`)
    return
  } catch (e) {
    if (process.env.MC_JAVA) throw e
  }
  const os = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform as string]
  const arch = { arm64: 'aarch64', x64: 'x64' }[process.arch as string]
  if (!os || !arch) throw new Error(`no automatic Java ${JAVA_MAJOR} download for ${process.platform}/${process.arch}; install one and set MC_JAVA`)
  const q = new URLSearchParams({ java_version: String(JAVA_MAJOR), os, arch, archive_type: 'tar.gz', java_package_type: 'jre', javafx_bundled: 'false', latest: 'true', release_status: 'ga', availability_types: 'CA', certifications: 'tck', page_size: '1' })
  const list = await (await fetch(`https://api.azul.com/metadata/v1/zulu/packages/?${q}`)).json() as { package_uuid: string }[]
  if (!list[0]) throw new Error(`Azul has no Java ${JAVA_MAJOR} JRE for ${os}/${arch}; install one and set MC_JAVA`)
  const pkg = await (await fetch(`https://api.azul.com/metadata/v1/zulu/packages/${list[0].package_uuid}`)).json() as { name: string; download_url: string; sha256_hash: string }
  const dir = javaCacheDir(ROOT)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const archive = join(dir, pkg.name)
  console.log(`downloading ${pkg.name}`)
  writeFileSync(archive, Buffer.from(await (await fetch(pkg.download_url)).arrayBuffer()))
  const got = sha('sha256', archive)
  if (got !== pkg.sha256_hash) throw new Error(`${pkg.name}: sha256 ${got} ≠ published ${pkg.sha256_hash}`)
  execFileSync('tar', ['-xzf', archive, '-C', dir])
  rmSync(archive)
  const j = resolveJava(ROOT)
  console.log(`java ${j.version} (major ${j.major}) → ${j.bin}`)
}

serverJar().then(java).catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1) })

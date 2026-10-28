#!/usr/bin/env node
// Link this plugin package's harness imports (@deepseek-ai/*) to the running
// DeepSeek Harness profile's node_modules, so the loads use the EXACT module
// instances the harness process uses (single-copy instanceof safety for cordis,
// dsh-llm LlmError, schemastery schemas, …).
//
// pi-ai is intentionally NOT linked: the plugin ships its own pinned copy under
// node_modules/@earendil-works/pi-ai (a direct dependency), independent of the
// pi-ai version bundled with the harness. The plugin↔harness boundary passes
// plain data (GenerateOptions in, StreamChunks out; the pi-bridge layer never
// leaks pi-ai objects across it), so the two copies coexist safely.
//
// Layout after this script:
//   node_modules/@deepseek-ai/<pkg>   -> <harness root>/@deepseek-ai/<pkg>  (links)
//   node_modules/@earendil-works/…    =  real directories (plugin-owned, pinned)
//
// Usage: node scripts/link.mjs [profile-name]
//   profile-name defaults to "web".
//
// Two rules keep this from breaking a working install:
//   1. Resolve EVERY package before touching anything. A profile directory can
//      exist while holding only a couple of packages (pnpm hoists the rest to
//      the application root), so "the @deepseek-ai directory exists" is not
//      evidence that the package we want is there.
//   2. Never delete a working copy until its replacement has been verified to
//      exist. A dangling link is worse than no link: it hides the npm-installed
//      peer copy that would otherwise resolve.
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE = process.argv[2] || 'web'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

// Harness packages resolved from the harness install via link (single copy).
const PACKAGES = ['cordis', 'dsh-credentials', 'dsh-launch-environment', 'dsh-llm', 'dsh-settings', 'dsh-timeout', 'schemastery']

/** Windows needs junctions (or Developer Mode) to create directory links without elevation. */
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

/**
 * Places that may hold the harness's own @deepseek-ai packages, most specific
 * first. `profiles/<name>/node_modules` wins when it really has the packages
 * (standalone profile installs); otherwise the application root does (pnpm
 * hoists there, which is what a normal desktop install looks like).
 */
function candidateRoots() {
  const roots = [join(DSH_HOME, 'profiles', PROFILE, 'node_modules'), join(DSH_HOME, 'profiles', 'node_modules')]
  // DSH_HOME is normally <install>/data, so <install>/node_modules is one level up.
  roots.push(join(DSH_HOME, '..', 'node_modules'))
  if (process.env.DSH_INSTALL_ROOT) roots.push(join(process.env.DSH_INSTALL_ROOT, 'node_modules'))
  return roots
}

// Never treat the plugin's own node_modules as a harness source: DSH_HOME may sit
// inside the plugin checkout (tests do this), and join(DSH_HOME, '..') would then
// point at node_modules itself, producing self-referential links.
const OWN_MODULES = resolve(HERE, 'node_modules')
const ROOTS = candidateRoots()
  .map((root) => resolve(root))
  .filter((root) => root !== OWN_MODULES && !root.startsWith(OWN_MODULES + sep))

/** First root that actually contains this package, or null. */
function resolveSource(pkg) {
  for (const root of ROOTS) {
    const source = join(root, '@deepseek-ai', pkg)
    if (existsSync(join(source, 'package.json'))) return source
  }
  return null
}

/** Compare two paths, tolerating the Windows extended-length prefix junctions use. */
function samePath(left, right) {
  const normalise = (value) => resolve(value.replace(/^\\\\\?\\/, ''))
  return normalise(left).toLowerCase() === normalise(right).toLowerCase()
}

/** Remove a previous link without ever recursing into the link target. */
function removeLink(link) {
  let stats
  try {
    stats = lstatSync(link)
  } catch {
    return
  }
  if (stats.isSymbolicLink()) unlinkSync(link)
  else rmSync(link, { recursive: true, force: true })
}

// Resolve first: nothing below this point may delete a copy we cannot replace.
const plan = []
const unresolved = []
for (const pkg of PACKAGES) {
  const source = resolveSource(pkg)
  if (source === null) unresolved.push(pkg)
  else plan.push({ pkg, source })
}

// The plugin must ship its own pi-ai; restore it if node_modules was wiped.
if (!existsSync(join(HERE, 'node_modules', '@earendil-works', 'pi-ai', 'package.json'))) {
  console.error(`error: plugin-owned pi-ai missing under ${HERE}/node_modules/@earendil-works`)
  console.error("hint: run 'npm install' in the plugin root (pi-ai is a direct dependency)")
  process.exit(1)
}

if (plan.length === 0) {
  // Not an error: CI and other harness-less environments have no harness tree to
  // link against (their npm-installed peer copies are exactly what the offline
  // test suites need). Only a boot on a harness machine completes it.
  console.log(
    `skip: no harness @deepseek-ai packages found under ${ROOTS.join(' or ')} — leaving @deepseek-ai/* as installed (CI / harness-less environment)`,
  )
  process.exit(0)
}

mkdirSync(join(HERE, 'node_modules', '@deepseek-ai'), { recursive: true })

let linked = 0
for (const { pkg, source } of plan) {
  const link = join(HERE, 'node_modules', '@deepseek-ai', pkg)

  let existing = null
  try {
    existing = readlinkSync(link)
  } catch {
    // Not a link (missing, or a real directory from a previous npm install).
  }
  // Junctions read back with a \?\ prefix on Windows; normalise before comparing
  // so a second run is a no-op instead of re-creating every link.
  if (existing !== null && samePath(existing, source)) continue

  removeLink(link)
  symlinkSync(source, link, LINK_TYPE)
  console.log(`linked: node_modules/@deepseek-ai/${pkg} -> ${source}`)
  linked += 1
}

if (unresolved.length > 0) {
  // Keep whatever npm installed for these; a dangling link would be strictly worse.
  console.warn(`warn: no harness copy found for ${unresolved.join(', ')} — left the npm-installed copy in place`)
}

console.log(
  linked === 0
    ? 'node_modules ready: @deepseek-ai/* already linked to the harness, pi-ai pinned locally'
    : `node_modules ready: ${linked} @deepseek-ai/* package(s) linked to the harness, pi-ai pinned locally`,
)
console.log("note: node_modules is gitignored; 'pnpm install' re-creates everything (prepare runs this script).")

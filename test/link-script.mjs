// Tests for scripts/link.mjs — the prepare hook that wires @deepseek-ai/* to the
// harness. Runs entirely in a temp directory; never touches the real profile.
//
// The regression this locks in: the old bash implementation deleted the plugin's
// npm-installed @deepseek-ai copies before it knew whether the harness had a
// replacement. A profile directory that exists but holds only a couple of
// packages (pnpm hoists the rest to the application root) made it delete
// everything and then fail, leaving the plugin unable to resolve cordis at all.
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SCRIPT = fileURLToPath(new URL('../scripts/link.mjs', import.meta.url))
const PACKAGES = ['cordis', 'dsh-llm', 'schemastery']

/** Build a plugin checkout + a fake harness home. */
function sandbox({ harnessPackages = PACKAGES, npmPackages = PACKAGES, profile = 'web' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-link-'))
  const plugin = join(root, 'plugin')
  mkdirSync(join(plugin, 'scripts'), { recursive: true })
  cpSync(SCRIPT, join(plugin, 'scripts', 'link.mjs'))
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }))

  // The plugin always ships its own pinned pi-ai.
  mkdirSync(join(plugin, 'node_modules', '@earendil-works', 'pi-ai'), { recursive: true })
  writeFileSync(join(plugin, 'node_modules', '@earendil-works', 'pi-ai', 'package.json'), '{"name":"@earendil-works/pi-ai"}')

  // Peer copies npm installed into the plugin.
  for (const pkg of npmPackages) {
    mkdirSync(join(plugin, 'node_modules', '@deepseek-ai', pkg), { recursive: true })
    writeFileSync(join(plugin, 'node_modules', '@deepseek-ai', pkg, 'package.json'), JSON.stringify({ name: pkg, from: 'npm' }))
  }

  // The harness tree.
  const home = join(root, 'data')
  const harness = join(home, 'profiles', profile, 'node_modules', '@deepseek-ai')
  for (const pkg of harnessPackages) {
    mkdirSync(join(harness, pkg), { recursive: true })
    writeFileSync(join(harness, pkg, 'package.json'), JSON.stringify({ name: pkg, from: 'harness' }))
  }
  return { root, plugin, home, harness }
}

function run(plugin, home, profile = 'web') {
  const result = spawnSync(process.execPath, [join(plugin, 'scripts', 'link.mjs'), profile], {
    cwd: plugin,
    env: { ...process.env, DSH_HOME: home, DSH_INSTALL_ROOT: '' },
    encoding: 'utf8',
  })
  // Warnings belong on stderr, so join both streams: callers assert on wording,
  // not on which descriptor carried it.
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function from(plugin, pkg) {
  return JSON.parse(readFileSync(join(plugin, 'node_modules', '@deepseek-ai', pkg, 'package.json'), 'utf8')).from
}

test('links every package the harness provides and leaves npm copies otherwise intact', () => {
  const { plugin, home } = sandbox()
  try {
    const out = run(plugin, home).out
    assert.match(out, /node_modules ready/)
    for (const pkg of PACKAGES) assert.equal(from(plugin, pkg), 'harness', `${pkg} should resolve to the harness copy`)
  } finally {
    rmSync(plugin, { recursive: true, force: true })
  }
})

test('a package the harness lacks keeps its npm copy instead of becoming a dangling link', () => {
  const { plugin, home } = sandbox({ harnessPackages: ['cordis'] })
  try {
    const out = run(plugin, home).out
    assert.match(out, /warn: no harness copy found for .*dsh-llm.*schemastery/)
    assert.equal(from(plugin, 'cordis'), 'harness')
    // The two it could not replace must still be readable real directories.
    assert.equal(from(plugin, 'dsh-llm'), 'npm')
    assert.equal(from(plugin, 'schemastery'), 'npm')
  } finally {
    rmSync(plugin, { recursive: true, force: true })
  }
})

test('a dangling link is repaired rather than left in place', () => {
  const { plugin, home } = sandbox({ harnessPackages: ['cordis'] })
  try {
    rmSync(join(plugin, 'node_modules', '@deepseek-ai', 'cordis'), { recursive: true, force: true })
    symlinkSync(join(home, 'gone'), join(plugin, 'node_modules', '@deepseek-ai', 'cordis'), process.platform === 'win32' ? 'junction' : 'dir')
    run(plugin, home)
    assert.equal(from(plugin, 'cordis'), 'harness')
  } finally {
    rmSync(plugin, { recursive: true, force: true })
  }
})

test('a second run is a no-op', () => {
  const { plugin, home } = sandbox()
  try {
    run(plugin, home)
    const second = run(plugin, home).out
    assert.match(second, /already linked/)
    assert.doesNotMatch(second, /^linked:/m)
  } finally {
    rmSync(plugin, { recursive: true, force: true })
  }
})

test('a harness-less checkout skips cleanly instead of failing the install', () => {
  const { plugin, home } = sandbox({ harnessPackages: [] })
  try {
    const out = run(plugin, home).out
    assert.match(out, /skip: no harness @deepseek-ai packages found/)
    for (const pkg of PACKAGES) assert.equal(from(plugin, pkg), 'npm')
  } finally {
    rmSync(plugin, { recursive: true, force: true })
  }
})

test('a missing pi-ai still fails loudly', () => {
  const { plugin, home } = sandbox()
  try {
    rmSync(join(plugin, 'node_modules', '@earendil-works', 'pi-ai'), { recursive: true, force: true })
    const failed = run(plugin, home)
    assert.notEqual(failed.status, 0)
    assert.match(failed.stderr, /plugin-owned pi-ai missing/)
  } finally {
    rmSync(plugin, { recursive: true, force: true })
  }
})

#!/usr/bin/env node
/**
 * Port gates for the Hermes Studio local patch series on 0.7.26.
 *
 * Usage: node run-gates.mjs <mode>
 *   typecheck-client  vue-tsc -b                      (upstream build's client typecheck step)
 *   typecheck-server  tsc --noEmit -p packages/server (upstream build's server typecheck step)
 *   tests             vitest run (full suite; includes the required suites, see TEST_SUITES)
 *   build             openapi:generate && vite build && node scripts/build-server.mjs
 *                     (mirrors the upstream npm build script's artifact-producing steps:
 *                     'npm run build' = openapi:generate && vue-tsc -b && vite build &&
 *                     tsc --noEmit -p packages/server && node scripts/build-server.mjs';
 *                     the two typecheck steps have their own dedicated gate modes)
 *   markers           patch-content markers checked against dist artifacts (run after build)
 *
 * Exit code: 0 = pass, 1 = fail.
 *
 * Output policy: full tool output for each mode is written to
 *   .gates/logs/<mode>.log
 * (plus a timestamped copy for repeated runs). stdout/stderr only carry a
 * compact summary: the verdict, the log paths, and the tail (last 80 lines) of
 * the tool output when a step fails. The pass/fail logic is unchanged.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, linkSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)))
const GATES_LOG_DIR = join(ROOT, '.gates', 'logs')

// Spawn tools through the current node binary using their JS entry points —
// going through node_modules/.bin cmd shims depends on `node` being resolvable
// inside a fresh cmd.exe, which is not guaranteed here.
const TOOL_JS = {
  'vue-tsc': join(ROOT, 'node_modules', 'vue-tsc', 'bin', 'vue-tsc.js'),
  tsc: join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  vitest: join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
  vite: join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
}

// agent-bridge suites (and hermes-plugins-runtime) spawn `python`/`python3`
// child processes. This host has Python 3.12.9 at
// %LOCALAPPDATA%\Programs\Python\Python312 (resolvable as `python` once that
// dir is on PATH) and no `python3` command at all. The gate creates a
// python3.exe hardlink shim next to a temp dir (same C: volume) so both
// interpreter names resolve.
const PYTHON_DIR = process.env.HERMES_PYTHON_DIR
  || join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312')

function pythonShimDir() {
  const pythonExe = join(PYTHON_DIR, 'python.exe')
  if (!existsSync(pythonExe)) return null
  if (existsSync(join(PYTHON_DIR, 'python3.exe'))) return PYTHON_DIR
  const shimDir = join(process.env.TEMP || process.env.TMP || PYTHON_DIR, 'hermes-gate-py3shim')
  try {
    mkdirSync(shimDir, { recursive: true })
    const shim = join(shimDir, 'python3.exe')
    if (!existsSync(shim)) linkSync(pythonExe, shim)
    return shimDir
  } catch {
    return null
  }
}

function pythonPathEnv() {
  const dirs = [PYTHON_DIR]
  const shim = pythonShimDir()
  if (shim && shim !== PYTHON_DIR) dirs.unshift(shim)
  return `${dirs.join(';')}${process.env.PATH ? ';' + process.env.PATH : ''}`
}

// Required regression suites (asked-for minimum). The tests gate runs the full
// `vitest run` suite, which includes all of these:
//   tests/server/coding-agents-launch.test.ts         -> 0004 regression (array-of-table config.toml)
//   tests/server/group-chat-full-local-access.test.ts -> 0005 regression (fullLocalAccess guard)
//   group-chat-workspace suites                       -> tests/server/group-chat-workspace*.test.ts
//                                                        (workspace, workspace-diff, workspace-diff-context,
//                                                         workspace-files) + group-chat-agent-workspace.test.ts
//   agent-workspace suites                            -> 0.7.26 has no file literally named
//                                                        agent-workspace.test.ts; the agent-workspace
//                                                        behavior lives in
//                                                        tests/server/group-chat-agent-workspace.test.ts
//                                                        (plus workspace-manager / workspace-path suites)
// Upstream 0.7.26 keeps the vitest layout (tests/**/*.test.ts via vitest.config.ts), so
// no remapping was necessary; the e2e playwright spec tests/e2e/*.spec.ts is not part
// of `vitest run` (upstream runs it via `playwright test`).
const TEST_SUITES = [
  'tests/server/coding-agents-launch.test.ts',
  'tests/server/group-chat-full-local-access.test.ts',
  'tests/server/group-chat-workspace',
  'tests/server/group-chat-agent-workspace.test.ts',
]

// Patch-content markers. Derived from the patches actually applied to this tree:
//   0001 extra_headers/preserve_client_identity provider fields
//   0002 codex identity headers incl. codex_exec -> codex_cli_rs normalization
//   0003 local Headroom proxy on 127.0.0.1:8787 for CLI traffic
//   0005 group-chat fullLocalAccess (schema column, SELECT column, storage UPDATE,
//        owner guard, HTTP route, serialize)
//   0006 per-provider proxy_url egress + connect retry (proxy-fetch TLS codes)
//   0007 session_context_usage snapshot + model_call context boundaries
//   0009 Hermes Studio brand retention (client bundle carries the brand strings)
// The guard/serialize patterns are written against the esbuild-minified shapes
// (e.g. `r?.fullLocalAccess||0)`) because dist/server/index.js is minified.
const SERVER_MARKERS = [
  { label: '0005 fullLocalAccess schema column', pattern: /fullLocalAccess["']?\s*:\s*["']INTEGER NOT NULL DEFAULT 0/ },
  { label: '0005 fullLocalAccess SELECT column', pattern: /["']fullLocalAccess["']/ },
  { label: '0005 fullLocalAccess non-owner guard', pattern: /fullLocalAccess\|\|0\)/ },
  { label: '0005 fullLocalAccess storage UPDATE', pattern: /UPDATE gc_rooms SET fullLocalAccess = \?, sessionSeed = \? WHERE id = \?/ },
  { label: '0005 fullLocalAccess serialize', pattern: /Number\([a-zA-Z_$][\w$]*\.fullLocalAccess\|\|0\)/ },
  { label: '0005 full-local-access route path', pattern: /full-local-access/ },
  { label: '0002 codex_cli_rs UA normalization', pattern: /codex_cli_rs/ },
  { label: '0002 codex identity header set', pattern: /x-codex-window-id/ },
  { label: '0003 local proxy 127.0.0.1:8787', pattern: /127\.0\.0\.1:8787/ },
  { label: '0001 extra_headers provider field', pattern: /extra_headers/ },
  { label: '0001 preserve_client_identity provider field', pattern: /preserve_client_identity/ },
  { label: '0006 proxy_url provider field', pattern: /proxy_url/ },
  { label: '0006 proxy_url auto-retry (connect TLS code)', pattern: /ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE/ },
  { label: '0005/0007 session_context_usage table', pattern: /session_context_usage/ },
  { label: '0007 model_call context boundary SQL', pattern: /usage_scope = 'model_call'/ },
  { label: '0007 codex thread/tokenUsage/updated', pattern: /thread\/tokenUsage\/updated/ },
]
const CLIENT_MARKERS = [
  { label: '0005 fullLocalAccess room field (client)', pattern: /fullLocalAccess/ },
  { label: '0005 full-local-access API path (client)', pattern: /full-local-access/ },
  { label: '0007 contextUnknown label (client i18n)', pattern: /contextUnknown/ },
  { label: '0006 preserveClientIdentity toggle (client)', pattern: /preserveClientIdentity/ },
  { label: '0006 providerProxyUrl field (client)', pattern: /providerProxyUrl/ },
  { label: '0006 extra_headers editor (client)', pattern: /extra_headers \(JSON\)/ },
  { label: '0009 Hermes Studio brand (client)', pattern: /Hermes Studio/ },
]

const TAIL_LINES = 80

mkdirSync(GATES_LOG_DIR, { recursive: true })

function stripAnsi(text) {
  return String(text || '').replace(/\x1b\[[0-9;]*m/g, '')
}

function modeLogFile(name) {
  return join(GATES_LOG_DIR, `${name}.log`)
}

/** Append a chunk to the mode log; create it on first write. */
function logChunk(mode, chunk) {
  if (!chunk?.length) return
  appendFileSync(modeLogFile(mode), chunk, { encoding: 'utf8' })
}

/** Print a compact tail of the collected log for a failed step. */
function printTail(mode, label) {
  const file = modeLogFile(mode)
  if (!existsSync(file)) return
  const text = stripAnsi(readFileSync(file, 'utf8'))
  if (!text.trim()) return
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  const tail = lines.slice(-TAIL_LINES)
  console.error(`--- ${label}: last ${tail.length} line(s) of ${file} ---`)
  for (const line of tail) console.error(line)
}

function summarizeVitest(mode) {
  // Pull the summary lines (Test Files / Tests / Duration) out of the log.
  const file = modeLogFile(mode)
  if (!existsSync(file)) return
  const text = stripAnsi(readFileSync(file, 'utf8'))
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(Test Files|Tests|Duration|Errors)\s/.test(line)) console.log(line.trim())
  }
  const failed = [...text.matchAll(/FAIL\s+(tests\/\S+)/g)].map((m) => m[1])
  if (failed.length) {
    const unique = [...new Set(failed)]
    console.log(`failed test files (${unique.length}):`)
    for (const f of unique) console.log(`  - ${f}`)
  }
}

function run(mode, tool, args, { env } = {}) {
  const entry = TOOL_JS[tool]
  const res = spawnSync(process.execPath, [entry, ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    maxBuffer: 1 << 28,
  })
  logChunk(mode, res.stdout)
  logChunk(mode, res.stderr)
  return res
}

function listFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) listFiles(full, acc)
    else acc.push(full)
  }
  return acc
}

function checkMarkers(mode) {
  const serverBundle = join(ROOT, 'dist', 'server', 'index.js')
  const clientDir = join(ROOT, 'dist', 'client')
  if (!existsSync(serverBundle)) {
    console.error(`[markers] missing ${serverBundle} - run the build gate first`)
    return false
  }
  if (!existsSync(clientDir)) {
    console.error(`[markers] missing ${clientDir} - run the build gate first`)
    return false
  }
  const serverText = readFileSync(serverBundle, 'utf-8')
  const clientFiles = listFiles(clientDir).filter((f) => {
    const ext = extname(f)
    return ['.js', '.html', '.css', '.json', '.svg', '.webmanifest', '.txt'].includes(ext)
  })
  const clientText = clientFiles.map((f) => {
    try { return readFileSync(f, 'utf-8') } catch { return '' }
  }).join('\n')

  let missing = 0
  for (const marker of SERVER_MARKERS) {
    const found = marker.pattern.test(serverText)
    console.log(`[markers] server | ${found ? 'found  ' : 'MISSING'} | ${marker.label}`)
    if (!found) missing += 1
  }
  for (const marker of CLIENT_MARKERS) {
    const found = marker.pattern.test(clientText)
    console.log(`[markers] client | ${found ? 'found  ' : 'MISSING'} | ${marker.label}`)
    if (!found) missing += 1
  }
  console.log(`[markers] ${SERVER_MARKERS.length + CLIENT_MARKERS.length} markers, ${missing} missing`)
  return missing === 0
}

const mode = process.argv[2]
const modes = ['typecheck-client', 'typecheck-server', 'tests', 'build', 'markers']
if (!modes.includes(mode)) {
  console.error(`usage: node run-gates.mjs <mode>  (one of: ${modes.join(', ')})`)
  process.exit(1)
}

// Fresh log for this run.
writeFileSync(modeLogFile(mode), '', { encoding: 'utf8' })
console.log(`[gate] ${mode}: full log at ${modeLogFile(mode)}`)

let ok = false
if (mode === 'typecheck-client') {
  const res = run(mode, 'vue-tsc', ['-b'])
  ok = res.status === 0
  if (!ok) printTail(mode, 'vue-tsc -b failed')
} else if (mode === 'typecheck-server') {
  const res = run(mode, 'tsc', ['--noEmit', '-p', 'packages/server'])
  ok = res.status === 0
  if (!ok) printTail(mode, 'tsc --noEmit failed')
} else if (mode === 'tests') {
  // agent-bridge suites spawn `python`/`python3`; the gate prepares a PATH that
  // resolves both (see pythonPathEnv above).
  const res = run(mode, 'vitest', ['run'], { env: { PATH: pythonPathEnv() } })
  ok = res.status === 0
  summarizeVitest(mode)
  if (!ok) printTail(mode, 'vitest run failed')
} else if (mode === 'build') {
  // Upstream build order: openapi:generate runs FIRST, before vite build (the
  // generated docs/openapi.json is a build input). Mirror that and verify the
  // generated spec matches the committed one, so a stale spec fails the gate.
  const openapi = spawnSync(process.execPath, [join(ROOT, 'scripts', 'generate-openapi.mjs')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
    maxBuffer: 1 << 28,
  })
  logChunk(mode, openapi.stdout)
  logChunk(mode, openapi.stderr)
  if (openapi.status !== 0) {
    console.error('[build] openapi:generate failed')
    printTail(mode, 'openapi:generate failed')
    console.log(`[gate] ${mode}: FAIL`)
    process.exit(1)
  }
  const specStatus = spawnSync('git', ['diff', '--exit-code', '--stat', '--', 'docs/openapi.json'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (specStatus.status !== 0) {
    console.error('[build] docs/openapi.json differs from the committed spec after openapi:generate')
    console.error('[build] regenerate and commit the spec, or resolve the route/spec drift')
    printTail(mode, 'openapi spec drift')
    console.log(`[gate] ${mode}: FAIL`)
    process.exit(1)
  }
  const vite = run(mode, 'vite', ['build'])
  if (vite.status !== 0) {
    console.error('[build] vite build failed')
    printTail(mode, 'vite build failed')
    console.log(`[gate] ${mode}: FAIL`)
    process.exit(1)
  }
  const serverScript = join(ROOT, 'scripts', 'build-server.mjs')
  const server = spawnSync(process.execPath, [serverScript], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
    maxBuffer: 1 << 28,
  })
  logChunk(mode, server.stdout)
  logChunk(mode, server.stderr)
  ok = server.status === 0
  if (!ok) printTail(mode, 'build-server.mjs failed')
} else if (mode === 'markers') {
  ok = checkMarkers(mode)
}

console.log(`[gate] ${mode}: ${ok ? 'PASS' : 'FAIL'}`)
process.exit(ok ? 0 : 1)

import { spawnSync } from 'child_process'
import { existsSync } from 'fs'

const MIN_VERSION = '2.1.32'

export interface ClaudeLaunchSpec { command: string; args: string[] }
export type ClaudeBinaryResult =
  | { ok: true; path: string; command: string; args: string[]; version: string }
  | { ok: false; error: string }

// Turn a resolved claude path into a spawnable spec. On Windows a .cmd/.bat
// shim can't be spawned directly (Node >=18.20 rejects it with EINVAL unless a
// shell wraps it), and an extension-less shell script fails with ENOENT — so
// batch shims go through `cmd.exe /d /s /c` and .ps1 shims through powershell.
// A real .exe (or anything else) is spawned directly.
export function buildClaudeLaunch(resolvedPath: string, extraArgs: string[] = []): ClaudeLaunchSpec {
  const lower = resolvedPath.toLowerCase()
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', resolvedPath, ...extraArgs] }
  }
  if (lower.endsWith('.ps1')) {
    return { command: 'powershell.exe', args: ['-NoProfile', '-File', resolvedPath, ...extraArgs] }
  }
  return { command: resolvedPath, args: extraArgs }
}

// Parse a "x.y.z" semver out of arbitrary `claude --version` output.
function parseVersion(text: string): string | null {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/)
  return match ? match[0] : null
}

// Numeric semver comparison: returns true when a >= b (x.y.z only).
function gte(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10))
  const pb = b.split('.').map((n) => parseInt(n, 10))
  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0
    const db = pb[i] || 0
    if (da > db) return true
    if (da < db) return false
  }
  return true
}

// Extension-less shims can't be executed on Windows; prefer a sibling that has a
// runnable extension (.cmd/.exe/.ps1/.bat) when one exists next to the shim.
const RUNNABLE_EXTS = ['.cmd', '.exe', '.ps1', '.bat']
function resolveRunnable(candidate: string): string | null {
  const lower = candidate.toLowerCase()
  if (RUNNABLE_EXTS.some((ext) => lower.endsWith(ext))) return candidate
  for (const ext of RUNNABLE_EXTS) {
    if (existsSync(candidate + ext)) return candidate + ext
  }
  return null // extension-less script with no runnable sibling — unusable
}

// Run a candidate's `--version` through the same launch builder used to spawn it.
function runVersion(spec: ClaudeLaunchSpec): { status: number; stdout: string } {
  const res = spawnSync(spec.command, spec.args, { windowsHide: true, encoding: 'utf8' })
  return { status: res.status ?? 1, stdout: `${res.stdout || ''}${res.stderr || ''}` }
}

// Verify a usable `claude` CLI is on PATH and new enough to run agent teams.
// The System32 shim is a known-broken stub, so skip it. Candidates are tried in
// order; the first that reports a version >= MIN_VERSION wins. The returned
// command/args are ready to spawn (with extra args appended by the caller).
export function verifyClaudeBinary(): ClaudeBinaryResult {
  let candidates: string[] = []
  try {
    const where = spawnSync('where', ['claude'], { windowsHide: true, encoding: 'utf8' })
    if (where.status === 0) candidates = where.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  } catch { /* fall through to empty */ }
  candidates = candidates.filter((c) => !/[\\/]windows[\\/]system32[\\/]/i.test(c))
  if (!candidates.length) return { ok: false, error: 'Claude Code CLI was not found on PATH. Install it and ensure `claude` is available.' }
  let seenVersion: string | null = null
  for (const candidate of candidates) {
    const runnable = resolveRunnable(candidate)
    if (!runnable) continue
    const spec = buildClaudeLaunch(runnable, ['--version'])
    const res = runVersion(spec)
    if (res.status !== 0) continue
    const version = parseVersion(res.stdout)
    if (!version) continue
    seenVersion = version
    if (gte(version, MIN_VERSION)) { const launch = buildClaudeLaunch(runnable); return { ok: true, path: runnable, command: launch.command, args: launch.args, version } }
  }
  if (seenVersion) return { ok: false, error: `Claude Code CLI ${seenVersion} is too old for agent teams. Update to ${MIN_VERSION} or newer.` }
  return { ok: false, error: `Could not determine a working Claude Code CLI version (need ${MIN_VERSION}+).` }
}

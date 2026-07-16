import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { resolveShell } from './shells'
import type { CreateTerminalInput } from '../../shared/types'

const winDir = process.env.SystemRoot || 'C:\\Windows'
const cmdPath = join(winDir, 'System32', 'cmd.exe')

function make(partial: Partial<CreateTerminalInput>): CreateTerminalInput {
  return { workspaceId: 'w', name: 'n', kind: 'cmd', ...partial } as CreateTerminalInput
}

const isWin = process.platform === 'win32'

describe.runIf(isWin)('resolveShell (win32)', () => {
  it('powershell returns powershell.exe with -NoLogo', () => {
    const r = resolveShell(make({ kind: 'powershell' }))
    expect(r.shell.toLowerCase()).toContain('powershell.exe')
    expect(r.args).toEqual(['-NoLogo'])
  })

  it('cmd returns cmd.exe with no args', () => {
    const r = resolveShell(make({ kind: 'cmd' }))
    expect(r.shell).toBe(cmdPath)
    expect(r.args).toEqual([])
  })

  it('custom + startupCommand routes to cmd host', () => {
    const r = resolveShell(make({ kind: 'custom', startupCommand: 'echo hi' }))
    expect(r.shell).toBe(cmdPath)
    expect(r.args).toEqual([])
  })

  it('custom + shell uses the provided shell/args', () => {
    const r = resolveShell(make({ kind: 'custom', shell: 'C:\\my\\bin.exe', args: ['-x'] }))
    expect(r.shell).toBe('C:\\my\\bin.exe')
    expect(r.args).toEqual(['-x'])
  })

  it.each(['claude', 'codex', 'opencode', 'ollama', 'ssh'] as const)(
    'agent kind %s runs inside cmd host',
    (kind) => {
      const r = resolveShell(make({ kind }))
      expect(r.shell).toBe(cmdPath)
      expect(r.args).toEqual([])
    }
  )

  it('falls back to USERPROFILE/cwd when cwd not provided', () => {
    const r = resolveShell(make({ kind: 'cmd', cwd: undefined }))
    const expected = process.env.USERPROFILE || process.cwd()
    expect(r.cwd).toBe(expected)
  })

  it('uses provided cwd', () => {
    const r = resolveShell(make({ kind: 'cmd', cwd: 'C:\\projects' }))
    expect(r.cwd).toBe('C:\\projects')
  })

  it('merges process.env with input.env (input wins)', () => {
    const r = resolveShell(make({ kind: 'cmd', env: { TF_TEST_VAR: 'x1' } }))
    expect(r.env.TF_TEST_VAR).toBe('x1')
    // some inherited var still present
    expect(Object.keys(r.env).length).toBeGreaterThan(1)
  })
})

describe.runIf(!isWin)('resolveShell (posix)', () => {
  it('agent kinds run inside an interactive host shell', () => {
    for (const kind of ['claude', 'codex', 'opencode', 'ollama', 'ssh'] as const) {
      const r = resolveShell(make({ kind }))
      expect(r.args).toContain('-i')
      expect(r.shell.length).toBeGreaterThan(0)
    }
  })

  it('bash kind resolves to a bash binary with -i', () => {
    const r = resolveShell(make({ kind: 'bash' }))
    expect(r.args).toEqual(['-i'])
    expect(r.shell).toMatch(/bash|sh/)
  })

  it('custom + shell uses the provided shell/args', () => {
    const r = resolveShell(make({ kind: 'custom', shell: '/usr/bin/env', args: ['-x'] }))
    expect(r.shell).toBe('/usr/bin/env')
    expect(r.args).toEqual(['-x'])
  })

  it('falls back to HOME/cwd when cwd not provided', () => {
    const r = resolveShell(make({ kind: 'bash', cwd: undefined }))
    const expected = process.env.HOME || process.cwd()
    expect(r.cwd).toBe(expected)
  })

  it('windows-only kinds fall back to the host shell', () => {
    const r = resolveShell(make({ kind: 'powershell' }))
    expect(r.args).toEqual(['-i'])
    expect(r.shell.length).toBeGreaterThan(0)
  })
})

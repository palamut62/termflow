import { describe, expect, it } from 'vitest'
import { buildClaudeLaunch } from './ClaudeBinary'

describe('buildClaudeLaunch', () => {
  it('wraps a .cmd shim in cmd.exe (Node rejects spawning .cmd directly)', () => {
    const spec = buildClaudeLaunch('C:/Users/u/AppData/Roaming/npm/claude.cmd', ['--version'])
    expect(spec.command).toBe('cmd.exe')
    expect(spec.args).toEqual(['/d', '/s', '/c', 'C:/Users/u/AppData/Roaming/npm/claude.cmd', '--version'])
  })

  it('wraps a .bat shim in cmd.exe as well', () => {
    const spec = buildClaudeLaunch('C:/tools/claude.bat')
    expect(spec.command).toBe('cmd.exe')
    expect(spec.args).toEqual(['/d', '/s', '/c', 'C:/tools/claude.bat'])
  })

  it('launches a .ps1 shim through powershell -NoProfile -File', () => {
    const spec = buildClaudeLaunch('C:/tools/claude.ps1', ['--teammate-mode', 'in-process'])
    expect(spec.command).toBe('powershell.exe')
    expect(spec.args).toEqual(['-NoProfile', '-File', 'C:/tools/claude.ps1', '--teammate-mode', 'in-process'])
  })

  it('spawns a real .exe directly with no wrapper', () => {
    const spec = buildClaudeLaunch('C:/tools/claude.exe', ['--version'])
    expect(spec.command).toBe('C:/tools/claude.exe')
    expect(spec.args).toEqual(['--version'])
  })

  it('is case-insensitive on the extension', () => {
    expect(buildClaudeLaunch('C:/x/CLAUDE.CMD').command).toBe('cmd.exe')
  })
})

import { existsSync } from 'fs'
import { join } from 'path'
import type { CreateTerminalInput, ShellKind } from '../../shared/types'

export interface ResolvedShell {
  shell: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

interface ShellCandidate {
  kind: ShellKind
  label: string
  shell: string
  args: string[]
  available: boolean
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((p) => existsSync(p))
}

const winDir = process.env.SystemRoot || 'C:\\Windows'
const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
const localAppData = process.env['LOCALAPPDATA'] || ''

function powershellPath(): string {
  return join(winDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function pwshPath(): string | undefined {
  return firstExisting([
    join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    join(localAppData, 'Microsoft', 'PowerShell', '7', 'pwsh.exe')
  ])
}

function gitBashPath(): string | undefined {
  return firstExisting([
    join(programFiles, 'Git', 'bin', 'bash.exe'),
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
  ])
}

/** Discover which shells are available on this machine (PRD FR-010). */
export function discoverShells(): ShellCandidate[] {
  const pwsh = pwshPath()
  const gitBash = gitBashPath()
  const wsl = firstExisting([join(winDir, 'System32', 'wsl.exe')])
  return [
    {
      kind: 'powershell',
      label: 'PowerShell',
      shell: powershellPath(),
      args: [],
      available: true
    },
    { kind: 'pwsh', label: 'PowerShell Core', shell: pwsh ?? '', args: [], available: !!pwsh },
    { kind: 'cmd', label: 'CMD', shell: join(winDir, 'System32', 'cmd.exe'), args: [], available: true },
    { kind: 'wsl', label: 'WSL', shell: wsl ?? '', args: [], available: !!wsl },
    { kind: 'gitbash', label: 'Git Bash', shell: gitBash ?? '', args: ['--login', '-i'], available: !!gitBash }
  ]
}

/**
 * Resolve a terminal-creation request into a concrete shell + args.
 * AI tools (claude/codex/opencode/ollama) run inside a host shell so the CLI
 * is launched via the user's PATH. (PRD §18)
 */
export function resolveShell(input: CreateTerminalInput): ResolvedShell {
  const cwd = input.cwd || process.env.USERPROFILE || process.cwd()
  const env = { ...process.env, ...(input.env || {}) } as Record<string, string>

  const psPath = powershellPath()
  const cmdPath = join(winDir, 'System32', 'cmd.exe')

  // Explicit custom command / shell wins.
  if (input.kind === 'custom' && input.shell) {
    return { shell: input.shell, args: input.args ?? [], cwd, env }
  }

  const gitBash = gitBashPath()
  const pwsh = pwshPath()
  const wsl = join(winDir, 'System32', 'wsl.exe')

  // Interactive host shell for CLI agents. We use cmd.exe (not PowerShell) and
  // type the command as input rather than passing it via -Command. cmd.exe
  // resolves names via PATHEXT and skips extensionless PATH entries, so npm
  // shims like `claude.cmd`/`codex.cmd` launch correctly — PowerShell would
  // instead match an extensionless file (e.g. System32\claude) and pop the
  // Windows "Open with" dialog. Errors also stay visible in-terminal.
  const host = (): ResolvedShell => ({ shell: cmdPath, args: [], cwd, env })

  switch (input.kind) {
    case 'powershell':
      return { shell: psPath, args: ['-NoLogo'], cwd, env }
    case 'pwsh':
      return { shell: pwsh ?? psPath, args: ['-NoLogo'], cwd, env }
    case 'cmd':
      return { shell: cmdPath, args: [], cwd, env }
    case 'wsl':
      return { shell: wsl, args: input.args ?? [], cwd, env }
    case 'gitbash':
      return { shell: gitBash ?? psPath, args: gitBash ? ['--login', '-i'] : ['-NoLogo'], cwd, env }
    case 'ssh':
      return host()
    case 'claude':
    case 'codex':
    case 'opencode':
    case 'ollama':
      return host()
    default:
      return { shell: psPath, args: ['-NoLogo'], cwd, env }
  }
}

/** The set of shell kinds whose startup command must be typed into an
 *  interactive host shell rather than passed as a spawn argument. */
export const AGENT_KINDS = ['claude', 'codex', 'opencode', 'ollama', 'ssh'] as const

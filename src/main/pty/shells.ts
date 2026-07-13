import { existsSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
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

function sshPath(): string | undefined {
  return firstExisting([
    join(winDir, 'System32', 'OpenSSH', 'ssh.exe'),
    join(programFiles, 'Git', 'usr', 'bin', 'ssh.exe')
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

function expandEnvVars(value: string): string {
  return value.replace(/%([^%]+)%/g, (match, name) => {
    const found = process.env[name]
    return found !== undefined ? found : match
  })
}

function readRegPath(hive: 'HKLM' | 'HKCU'): string | undefined {
  const key =
    hive === 'HKLM'
      ? 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
      : 'HKCU\\Environment'
  const output = execSync(`reg query "${key}" /v Path`, { encoding: 'utf8', windowsHide: true })
  const match = output.match(/Path\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)/)
  if (!match) return undefined
  return expandEnvVars(match[2].trim())
}

let pathCache: { value: string | null; ts: number } | null = null
const PATH_CACHE_TTL_MS = 30_000

function freshPath(): string | null {
  const now = Date.now()
  if (pathCache && now - pathCache.ts < PATH_CACHE_TTL_MS) {
    return pathCache.value
  }
  try {
    const machine = readRegPath('HKLM')
    const user = readRegPath('HKCU')
    const combined = [machine, user].filter((v): v is string => !!v).join(';')
    const value = combined || null
    pathCache = { value, ts: now }
    return value
  } catch {
    pathCache = { value: null, ts: now }
    return null
  }
}

function mergePathValues(registryPath: string, currentPath: string): string {
  const registryEntries = registryPath.split(';').filter(Boolean)
  const seen = new Set(registryEntries.map((p) => p.toLowerCase()))
  const extra = currentPath
    .split(';')
    .filter((p) => p && !seen.has(p.toLowerCase()))
  return [...registryEntries, ...extra].join(';')
}

/**
 * Resolve a terminal-creation request into a concrete shell + args.
 * AI tools (claude/codex/opencode/ollama) run inside a host shell so the CLI
 * is launched via the user's PATH. (PRD §18)
 */
export function resolveShell(input: CreateTerminalInput): ResolvedShell {
  const cwd = input.cwd || process.env.USERPROFILE || process.cwd()
  const env = { ...process.env } as Record<string, string>

  if (input.cleanProviderEnv) {
    const providerPrefixes = ['ANTHROPIC_', 'CLAUDE_CODE_', 'OPENAI_', 'OPENROUTER_', 'DEEPSEEK_', 'OLLAMA_']
    for (const key of Object.keys(env)) {
      if (providerPrefixes.some((prefix) => key.toUpperCase().startsWith(prefix))) delete env[key]
    }
  }

  const registryPath = freshPath()
  if (registryPath) {
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path'
    const currentPath = env[pathKey] || ''
    env[pathKey] = mergePathValues(registryPath, currentPath)
  }

  // Embedded-terminal renk desteği: CLI'lar (claude/codex vb.) truecolor'ı
  // COLORTERM üzerinden algılar; ConPTY altında bu değişkenler yoksa 16 renge düşerler.
  // Advertise the capabilities xterm.js actually implements. The parent
  // process may carry TERM=dumb and NO_COLOR=1, which force AI TUIs into a
  // monochrome fallback even though this terminal supports truecolor.
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'TermFlow'
  env.TERM_PROGRAM_VERSION = process.env.npm_package_version || '0.1.0'
  delete env.WT_SESSION
  delete env.WT_PROFILE_ID
  delete env.NO_COLOR

  // The terminal advertises its actual color support through TERM/COLORTERM.
  // Do not force a CLI-specific color mode: Claude Code owns its own theme and
  // should not receive a fake Windows Terminal identity from an xterm.js host.
  // Explicit input.env is applied afterwards, so a workspace can still opt
  // into NO_COLOR deliberately without inheriting the launcher's global flag.
  Object.assign(env, input.env || {})

  const psPath = powershellPath()
  const cmdPath = join(winDir, 'System32', 'cmd.exe')

  // Explicit custom command / shell wins.
  if (input.kind === 'custom' && input.startupCommand) {
    return { shell: cmdPath, args: [], cwd, env }
  }

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
    case 'ssh': {
      const ssh = sshPath()
      if (!ssh) return host()
      return { shell: ssh, args: input.args ?? [], cwd, env }
    }
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

import type { ShellKind, NodeType } from '../../shared/types'

export interface ProfileDef {
  kind: ShellKind
  label: string
  nodeType: NodeType
  /** Optional command typed into the terminal once the shell is ready. */
  startupCommand?: string
  /** Extra flags appended when "launch with full permissions" is on. */
  bypassArgs?: string
  color: string
}

// Default profiles (PRD §10.7.2, §18). Every entry is just a shell plus an
// optional startup command — `claude` and `pwsh` have equal status here.
export const PROFILES: ProfileDef[] = [
  { kind: 'powershell', label: 'PowerShell', nodeType: 'terminal', color: '#2f80ff' },
  { kind: 'pwsh', label: 'PowerShell Core', nodeType: 'terminal', color: '#2f80ff' },
  { kind: 'cmd', label: 'CMD', nodeType: 'terminal', color: '#8892a6' },
  { kind: 'wsl', label: 'WSL', nodeType: 'terminal', color: '#f6c343' },
  { kind: 'gitbash', label: 'Git Bash', nodeType: 'terminal', color: '#f0803c' },
  {
    kind: 'claude',
    label: 'Claude Code',
    nodeType: 'terminal',
    startupCommand: 'claude',
    bypassArgs: '--dangerously-skip-permissions',
    color: '#d97757'
  },
  {
    kind: 'codex',
    label: 'Codex',
    nodeType: 'terminal',
    startupCommand: 'codex',
    bypassArgs: '--dangerously-bypass-approvals-and-sandbox',
    color: '#10a37f'
  },
  {
    kind: 'opencode',
    label: 'OpenCode',
    nodeType: 'terminal',
    startupCommand: 'opencode',
    color: '#3fb950'
  },
  {
    kind: 'ollama',
    label: 'Ollama Serve',
    nodeType: 'service',
    startupCommand: 'ollama serve',
    color: '#b48ead'
  },
  { kind: 'custom', label: 'Custom Command', nodeType: 'custom', color: '#a0a7b4' },
  { kind: 'ssh', label: 'SSH Connection', nodeType: 'terminal', color: '#7b68ee' }
]

export function profileFor(kind: ShellKind): ProfileDef {
  return PROFILES.find((p) => p.kind === kind) ?? PROFILES[0]
}

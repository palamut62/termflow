import type { ShellKind, NodeType, AgentType } from '../../shared/types'
import { DEFAULT_ROLE_PROMPTS } from '../../shared/types'

export interface ProfileDef {
  kind: ShellKind
  label: string
  nodeType: NodeType
  agentType?: AgentType
  startupCommand?: string
  /** Flag appended when "Launch AI agents with full permissions" is on (bypass perms). */
  bypassArgs?: string
  color: string
  group: 'shell' | 'agent' | 'service'
}

// Default profiles (PRD §10.7.2, §18)
export const PROFILES: ProfileDef[] = [
  { kind: 'powershell', label: 'PowerShell', nodeType: 'terminal', color: '#2f80ff', group: 'shell' },
  { kind: 'pwsh', label: 'PowerShell Core', nodeType: 'terminal', color: '#2f80ff', group: 'shell' },
  { kind: 'cmd', label: 'CMD', nodeType: 'terminal', color: '#8892a6', group: 'shell' },
  { kind: 'wsl', label: 'WSL', nodeType: 'terminal', color: '#f6c343', group: 'shell' },
  { kind: 'gitbash', label: 'Git Bash', nodeType: 'terminal', color: '#f0803c', group: 'shell' },
  {
    kind: 'claude',
    label: 'Claude Code',
    nodeType: 'agent',
    agentType: 'claude',
    startupCommand: 'claude',
    bypassArgs: '--dangerously-skip-permissions',
    color: '#d97757',
    group: 'agent'
  },
  {
    kind: 'codex',
    label: 'Codex',
    nodeType: 'agent',
    agentType: 'codex',
    startupCommand: 'codex',
    bypassArgs: '--dangerously-bypass-approvals-and-sandbox',
    color: '#10a37f',
    group: 'agent'
  },
  {
    kind: 'opencode',
    label: 'OpenCode',
    nodeType: 'agent',
    agentType: 'opencode',
    startupCommand: 'opencode',
    color: '#3fb950',
    group: 'agent'
  },
  {
    kind: 'ollama',
    label: 'Ollama Serve',
    nodeType: 'agent',
    agentType: 'ollama',
    startupCommand: 'ollama serve',
    color: '#b48ead',
    group: 'agent'
  },
  { kind: 'custom', label: 'Custom Command', nodeType: 'custom', color: '#a0a7b4', group: 'shell' },
  { kind: 'ssh', label: 'SSH Connection', nodeType: 'terminal', color: '#7b68ee', group: 'shell' }
]

export function profileFor(kind: ShellKind): ProfileDef {
  return PROFILES.find((p) => p.kind === kind) ?? PROFILES[0]
}

// Resolve the system prompt to send an agent node's CLI once it's ready:
// user override (settings.rolePrompts) first, else the built-in default for
// that role. Returns undefined for roles with no known template (custom).
export function rolePromptFor(role: string | undefined, overrides: Record<string, string>): string | undefined {
  if (!role) return undefined
  const override = overrides[role]
  if (override && override.trim()) return override
  return DEFAULT_ROLE_PROMPTS[role]
}

// Agent role node types (PRD §10.5.2). Each maps to a default backing CLI which
// the user can still change; the role is a semantic label shown on the node.
export interface AgentRoleDef {
  role: string
  label: string
  defaultKind: ShellKind
  color: string
}

export const AGENT_ROLES: AgentRoleDef[] = [
  { role: 'Planner', label: 'Planner Agent', defaultKind: 'claude', color: '#2f80ff' },
  { role: 'Coder', label: 'Coder Agent', defaultKind: 'codex', color: '#10a37f' },
  { role: 'Reviewer', label: 'Reviewer Agent', defaultKind: 'opencode', color: '#3fb950' },
  { role: 'Tester', label: 'Tester Agent', defaultKind: 'powershell', color: '#f6c343' },
  { role: 'Debugger', label: 'Debugger Agent', defaultKind: 'claude', color: '#ff4d4f' },
  { role: 'Git', label: 'Git Agent', defaultKind: 'gitbash', color: '#f0803c' },
  { role: 'Documentation', label: 'Documentation Agent', defaultKind: 'claude', color: '#a0a7b4' },
  { role: 'Research', label: 'Research Agent', defaultKind: 'claude', color: '#b48ead' },
  { role: 'Shell', label: 'Shell Agent', defaultKind: 'powershell', color: '#8892a6' },
  { role: 'Ollama Local', label: 'Ollama Local Agent', defaultKind: 'ollama', color: '#b48ead' }
]

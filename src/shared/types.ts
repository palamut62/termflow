// Shared data models between main and renderer (see PRD §14)

export type LayoutMode =
  | 'manual'
  | 'auto_fit'
  | 'grid'
  | 'columns'
  | 'rows'
  | 'focus'
  | 'agent_graph'
  | 'monitoring'
  | 'split_grid'

export type ShellKind =
  | 'powershell'
  | 'pwsh'
  | 'cmd'
  | 'wsl'
  | 'gitbash'
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'ollama'
  | 'custom'

export type NodeType = 'terminal' | 'agent' | 'service' | 'database' | 'test' | 'custom'
export type AgentType = 'claude' | 'codex' | 'opencode' | 'ollama' | 'custom'

export type TerminalStatus = 'running' | 'stopped' | 'error' | 'exited'
export type NodeStatus = 'idle' | 'running' | 'waiting' | 'error' | 'completed' | 'stopped'

export interface TerminalProfile {
  id: string
  name: string
  kind: ShellKind
  shell: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  startupCommand?: string
  icon?: string
  agentType?: AgentType
  color?: string
}

export interface Workspace {
  id: string
  name: string
  path: string
  description?: string
  icon?: string
  defaultLayoutMode: LayoutMode
  createdAt: string
  updatedAt: string
  lastOpenedAt?: string
}

export interface TerminalSession {
  id: string
  workspaceId: string
  name: string
  profileId?: string
  kind: ShellKind
  shell: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  pid?: number
  status: TerminalStatus
  createdAt: string
  updatedAt: string
}

export interface CanvasNode {
  id: string
  workspaceId: string
  terminalId: string
  title: string
  nodeType: NodeType
  agentType?: AgentType
  agentRole?: string
  position: { x: number; y: number }
  size: { width: number; height: number }
  zIndex: number
  isMinimized: boolean
  isMaximized: boolean
  status: NodeStatus
  showInfo: boolean
}

export type RenderMode = 'active' | 'passive' | 'buffer'

export interface ProcStats {
  cpu: number
  memory: number
}

export interface AppSettings {
  activeBorderColor: string
  scrollback: number
  passiveThrottleMs: number
  webgl: boolean
  snapToGrid: boolean
  agentAutoApprove: boolean
  minimap: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  activeBorderColor: '#f5e642',
  scrollback: 10000,
  passiveThrottleMs: 250,
  webgl: true,
  snapToGrid: false,
  agentAutoApprove: true,
  minimap: false
}

export type ConnectionType =
  | 'control'
  | 'data'
  | 'log'
  | 'error'
  | 'dependency'
  | 'parent_child'
  | 'manual'
  | 'trigger'

export interface AgentConnection {
  id: string
  workspaceId: string
  sourceNodeId: string
  targetNodeId: string
  connectionType: ConnectionType
  label?: string
  isActive: boolean
  status: 'idle' | 'active' | 'error' | 'disabled'
}

export interface CanvasViewport {
  zoom: number
  x: number
  y: number
}

export interface WorkspaceLayout {
  workspaceId: string
  nodes: CanvasNode[]
  connections: AgentConnection[]
  layoutMode: LayoutMode
  viewport: CanvasViewport
}

export interface CreateTerminalInput {
  workspaceId: string
  name: string
  kind: ShellKind
  shell?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  startupCommand?: string
  cols?: number
  rows?: number
}

// IPC channel names
export const IPC = {
  // pty
  PTY_CREATE: 'pty:create',
  PTY_WRITE: 'pty:write',
  PTY_RESIZE: 'pty:resize',
  PTY_KILL: 'pty:kill',
  PTY_RESTART: 'pty:restart',
  PTY_DATA: 'pty:data', // main -> renderer (batched)
  PTY_EXIT: 'pty:exit',
  PTY_BUFFER: 'pty:buffer', // request full buffer on attach
  PTY_MODE: 'pty:mode', // renderer -> main: set render mode (active/passive/buffer)
  PTY_ACTIVITY: 'pty:activity', // main -> renderer: error/activity signal
  PROC_STATS: 'proc:stats', // renderer -> main: get cpu/mem for pids
  // shells
  SHELLS_DISCOVER: 'shells:discover',
  // settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  // dialog
  DIALOG_OPEN_DIR: 'dialog:openDir',
  // workspaces
  WS_LIST: 'ws:list',
  WS_CREATE: 'ws:create',
  WS_UPDATE: 'ws:update',
  WS_DELETE: 'ws:delete',
  // layout
  LAYOUT_GET: 'layout:get',
  LAYOUT_SAVE: 'layout:save',
  // terminals persistence
  TERM_LIST: 'term:list',
  TERM_UPSERT: 'term:upsert',
  TERM_DELETE: 'term:delete'
} as const

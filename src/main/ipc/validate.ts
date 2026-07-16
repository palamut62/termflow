// IPC input validation (P0 security). All schemas mirror src/shared/types.ts.
// parseOrThrow() is used in ipcMain.handle (rejects renderer promise on failure);
// on() handlers should catch and silently return.
import { z } from 'zod'

export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const res = schema.safeParse(value)
  if (!res.success) throw new Error(`IPC validation failed: ${res.error.message}`)
  return res.data
}

// ---- primitives ----
export const idSchema = z.string().min(1).max(256)
export const posInt = z.number().int().positive()

const shellKind = z.enum([
  'powershell', 'pwsh', 'cmd', 'wsl', 'gitbash',
  'claude', 'codex', 'opencode', 'ollama', 'ssh', 'custom'
])
const layoutMode = z.enum([
  'manual', 'auto_fit', 'grid', 'columns', 'rows',
  'focus', 'agent_graph', 'monitoring', 'split_grid'
])
const nodeType = z.enum(['terminal', 'agent', 'service', 'database', 'test', 'custom'])
const agentType = z.enum(['claude', 'codex', 'opencode', 'ollama', 'custom'])
const renderModeSchema = z.enum(['active', 'passive', 'buffer'])

const stringRecord = z.record(z.string())

// ---- CreateTerminalInput ----
export const createTerminalInput = z.object({
  workspaceId: z.string().min(1),
  name: z.string(),
  kind: shellKind,
  shell: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: stringRecord.optional(),
  startupCommand: z.string().max(4096).optional(),
  cols: posInt.optional(),
  rows: posInt.optional()
}).passthrough()

// ---- Canvas / layout ----
const paneNode: z.ZodType<any> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('leaf'), terminalId: z.string(), title: z.string() }).passthrough(),
    z.object({
      type: z.literal('split'),
      dir: z.enum(['horizontal', 'vertical']),
      ratio: z.number(),
      a: paneNode,
      b: paneNode
    }).passthrough()
  ])
)

const canvasNode = z.object({
  id: z.string(),
  workspaceId: z.string(),
  terminalId: z.string().optional(),
  panes: paneNode.optional(),
  activePaneId: z.string().optional(),
  title: z.string(),
  nodeType,
  agentType: agentType.optional(),
  position: z.object({ x: z.number(), y: z.number() }),
  size: z.object({ width: z.number(), height: z.number() }),
  zIndex: z.number(),
  isMinimized: z.boolean(),
  isMaximized: z.boolean(),
  status: z.string(),
  showInfo: z.boolean()
}).passthrough()

const agentConnection = z.object({
  id: z.string(),
  workspaceId: z.string(),
  sourceNodeId: z.string(),
  targetNodeId: z.string(),
  connectionType: z.string(),
  isActive: z.boolean(),
  status: z.string()
}).passthrough()

const viewport = z.object({ zoom: z.number(), x: z.number(), y: z.number() })

export const workspaceLayout = z.object({
  workspaceId: z.string().min(1),
  nodes: z.array(canvasNode),
  connections: z.array(agentConnection),
  layoutMode,
  viewport,
  activeNodeId: z.string().optional()
}).passthrough()

// ---- TerminalSession (persist upsert) ----
export const terminalSession = z.object({
  id: z.string().min(1),
  workspaceId: z.string(),
  name: z.string(),
  profileId: z.string().optional(),
  kind: shellKind,
  shell: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  env: stringRecord.optional(),
  startupCommand: z.string().max(4096).optional(),
  pid: z.number().optional(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
}).passthrough()

// ---- Workspace create/update ----
export const workspaceCreate = z.object({
  name: z.string(),
  path: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  defaultLayoutMode: layoutMode
}).passthrough()
export const workspacePatch = workspaceCreate.partial().passthrough()

// ---- Snippet ----
export const snippetCreate = z.object({
  workspaceId: z.string().nullable(),
  name: z.string(),
  command: z.string(),
  params: z.array(z.string()),
  targetKind: shellKind.optional(),
  cwd: z.string().optional(),
  scope: z.enum(['workspace', 'global'])
}).passthrough()
export const snippetPatch = snippetCreate.partial().passthrough()

// ---- HighlightRule ----
export const highlightRuleCreate = z.object({
  workspaceId: z.string().nullable(),
  pattern: z.string(),
  flags: z.string(),
  color: z.string(),
  label: z.string().optional(),
  notifyOnMatch: z.boolean().optional()
}).passthrough()
export const highlightRulePatch = highlightRuleCreate.partial().passthrough()

// ---- SshProfile ----
export const sshProfileCreate = z.object({
  workspaceId: z.string(),
  name: z.string(),
  host: z.string(),
  port: z.number(),
  user: z.string(),
  authType: z.enum(['key', 'agent', 'password']),
  keyPath: z.string().optional(),
  jumpHost: z.string().optional()
}).passthrough()
export const sshProfilePatch = sshProfileCreate.partial().passthrough()

// ---- EnvEntry create/update ----
export const envCreate = z.object({
  workspaceId: z.string().min(1),
  key: z.string(),
  value: z.string(),
  masked: z.boolean()
}).passthrough()
export const envPatch = z.object({
  workspaceId: z.string().optional(),
  key: z.string().optional(),
  value: z.string().optional(),
  masked: z.boolean().optional()
}).passthrough()

// ---- Settings ----
export const settingsPatch = z.record(z.unknown())

// ---- Render mode / resize ----
export { renderModeSchema }

// ---- Agent routing ----
export const routingRules = z.array(z.object({}).passthrough())

// ---- WorkspaceExport (import) ----
const importTerminal = z.object({
  id: z.string(),
  startupCommand: z.string().max(4096).optional()
}).passthrough()

export const workspaceExport = z.object({
  schemaVersion: z.literal(1),
  exportedAt: z.string().optional(),
  termflowVersion: z.string().optional(),
  workspace: z.object({
    name: z.string(),
    path: z.string().optional(),
    description: z.string().optional(),
    defaultLayoutMode: layoutMode
  }).passthrough(),
  nodes: z.array(z.object({ id: z.string() }).passthrough()).optional().default([]),
  terminals: z.array(importTerminal).optional().default([]),
  connections: z.array(z.object({ id: z.string() }).passthrough()).optional().default([]),
  snippets: z.array(z.object({ id: z.string() }).passthrough()).optional().default([]),
  highlightRules: z.array(z.object({ id: z.string() }).passthrough()).optional().default([]),
  sshProfiles: z.array(z.object({ id: z.string() }).passthrough()).optional().default([]),
  envVars: z.array(z.object({ id: z.string() }).passthrough()).optional().default([]),
  viewport: viewport.optional()
}).passthrough()

// ---- Path (absolute) ----
export const absolutePath = z.string().min(1).refine(
  (p) => /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p),
  { message: 'path must be absolute' }
)

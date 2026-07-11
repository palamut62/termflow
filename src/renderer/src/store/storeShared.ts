import { nanoid } from 'nanoid'
import type {
  CanvasNode,
  TerminalSession,
  AgentConnection,
  AppSettings
} from '../../../shared/types'
import { getLeafTerminalIds, getActiveTerminalId } from '../paneUtils'

export const DEFAULT_SIZE = { width: 900, height: 520 } // PRD §10.3.4

export interface NewTerminalOpts {
  cwd?: string
  startupCommand?: string
  customShell?: string
  args?: string[]
  name?: string
  agentRole?: string
  env?: Record<string, string>
}

export interface AgentActivity {
  id: string
  terminalId: string
  nodeId?: string
  agentName: string
  kind: 'subagent' | 'task' | 'tool' | 'handoff' | 'status'
  message: string
  createdAt: string
}

// Per-connection timers that flip an active edge back to idle once data stops.
export const routeIdleTimers = new Map<string, ReturnType<typeof setTimeout>>()
export const ROUTE_ACTIVE_MS = 600

let systemThemeMql: MediaQueryList | null = null
let themeStore: { getState: () => { settings: AppSettings } } | null = null

// Late-bound reference to the assembled store so the system-theme media query
// listener can read the current theme without a circular import.
export function registerThemeStore(store: { getState: () => { settings: AppSettings } }): void {
  themeStore = store
}

const AGENT_PATTERNS: { kind: AgentActivity['kind']; re: RegExp; nameGroup?: number; messageGroup?: number }[] = [
  { kind: 'subagent', re: /\b(?:sub-?agent|agent team|team agent)\b[:\s-]*([A-Za-z0-9 _.-]+)?/i, nameGroup: 1 },
  { kind: 'task', re: /\b(?:Task|Todo|Plan|Delegating|Assigned)\b[:\s-]+(.+)/i, messageGroup: 1 },
  { kind: 'tool', re: /\b(?:Tool|Using tool|Running tool|Bash|Edit|Read|Write)\b[:\s-]+(.+)/i, messageGroup: 1 },
  { kind: 'handoff', re: /@@HANDOFF@@([\s\S]*?)@@END@@/i, messageGroup: 1 },
  { kind: 'status', re: /\b(?:started|completed|failed|reviewing|coding|testing|debugging)\b[:\s-]*(.+)?/i, messageGroup: 1 }
]

export function parseAgentActivities(
  terminalId: string,
  data: string,
  nodes: CanvasNode[],
  terminals: Record<string, TerminalSession>
): AgentActivity[] {
  const node = nodes.find((n) => n.terminalId === terminalId || (n.panes ? getLeafTerminalIds(n.panes).includes(terminalId) : false))
  const terminal = terminals[terminalId]
  if (!node?.agentType && !node?.agentRole) return []
  const sourceName = node?.agentRole || node?.title || terminal?.name || 'Agent'
  const lines = data
    .split(/\r?\n/)
    .map((line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim())
    .filter(Boolean)
  const events: AgentActivity[] = []

  for (const line of lines.slice(-40)) {
    if (line.startsWith('@@TERMFLOW_EVENT@@')) {
      try {
        const payload = JSON.parse(line.slice('@@TERMFLOW_EVENT@@'.length)) as { kind?: AgentActivity['kind']; name?: string; message?: string }
        if (payload.kind && ['subagent', 'task', 'tool', 'handoff', 'status'].includes(payload.kind)) {
          events.push({ id: nanoid(), terminalId, nodeId: node?.id, agentName: (payload.name || sourceName).slice(0, 60), kind: payload.kind, message: (payload.message || payload.kind).slice(0, 220), createdAt: new Date().toISOString() })
          continue
        }
      } catch {
        // Fall through to conservative text detection.
      }
    }
    if (!/\b(agent|subagent|team|task|todo|tool|handoff|delegat|assigned|started|completed|failed|review|coding|testing|debug)\b|@@HANDOFF@@/i.test(line)) {
      continue
    }
    for (const pattern of AGENT_PATTERNS) {
      const match = pattern.re.exec(line)
      if (!match) continue
      const name = (pattern.nameGroup ? match[pattern.nameGroup] : '')?.trim() || sourceName
      const message = (pattern.messageGroup ? match[pattern.messageGroup] : '')?.trim() || line
      events.push({
        id: nanoid(),
        terminalId,
        nodeId: node?.id,
        agentName: name.slice(0, 60),
        kind: pattern.kind,
        message: message.slice(0, 220),
        createdAt: new Date().toISOString()
      })
      break
    }
  }

  return events
}

// Apply light/dark/system theme by toggling the root data-theme attribute.
export function applyTheme(theme: AppSettings['theme'], transparency: number): void {
  const root = document.documentElement
  const systemDark = (): boolean =>
    window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : true
  const resolve = (): void => {
    const resolved = theme === 'system' ? (systemDark() ? 'mocha' : 'latte') : theme === 'dark' ? 'mocha' : theme === 'light' ? 'latte' : theme
    const isLight = resolved === 'latte' || resolved === 'matcha'
    root.setAttribute('data-theme', resolved)
    const opacity = Math.max(45, Math.min(100, transparency))
    root.toggleAttribute('data-transparency', opacity < 100)
    root.style.setProperty('--user-opacity', String(opacity / 100))
    // Keep the native Windows titlebar overlay (min/max/close) in sync.
    if (isLight) window.termflow.window.setOverlay('#eaedf3', '#4a5162')
    else window.termflow.window.setOverlay('#20242c', '#a0a7b4')
  }
  if (!systemThemeMql && window.matchMedia) {
    systemThemeMql = window.matchMedia('(prefers-color-scheme: dark)')
    systemThemeMql.addEventListener('change', () => {
      if (themeStore?.getState().settings.theme === 'system') resolve()
    })
  }
  resolve()
}

export function syncAgentRouting(nodes: CanvasNode[], connections: AgentConnection[]): void {
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const termIds = new Set<string>()
  const grouped = new Map<string, unknown[]>()

  for (const node of nodes) {
    const ids = node.panes ? getLeafTerminalIds(node.panes) : (node.terminalId ? [node.terminalId] : [])
    ids.forEach((id) => termIds.add(id))
  }

  const addRule = (sourceNodeId: string, targetNodeId: string, conn: AgentConnection): void => {
    const sourceNode = nodeById.get(sourceNodeId)
    const targetNode = nodeById.get(targetNodeId)
    if (!sourceNode || !targetNode) return
    const sourceTermId = getActiveTerminalId(sourceNode.activePaneId, sourceNode.panes, sourceNode.terminalId)
    const targetTermIds = targetNode.panes
      ? getLeafTerminalIds(targetNode.panes)
      : (targetNode.terminalId ? [targetNode.terminalId] : [])
    if (!sourceTermId || targetTermIds.length === 0) return
    const rules = grouped.get(sourceTermId) ?? []
    rules.push({
      connectionId: conn.id,
      targetTerminalIds: targetTermIds,
      triggerPattern: conn.triggerPattern || '@@HANDOFF@@([\\s\\S]*?)@@END@@',
      transform: conn.transform,
      routeBehavior: conn.routeBehavior
    })
    grouped.set(sourceTermId, rules)
  }

  for (const conn of connections) {
    if (!conn.isActive || !conn.routeBehavior || conn.routeBehavior === 'disabled') continue
    addRule(conn.sourceNodeId, conn.targetNodeId, conn)
    if (conn.routeDirection === 'bidirectional') addRule(conn.targetNodeId, conn.sourceNodeId, conn)
  }

  for (const id of termIds) window.termflow.agent.setRouting(id, grouped.get(id) ?? [])
}

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
  bypassArgs?: string
  customShell?: string
  args?: string[]
  name?: string
  agentRole?: string
  env?: Record<string, string>
  cleanProviderEnv?: boolean
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

// Known AI coding CLIs. If a terminal was launched with one of these (its
// startupCommand), we treat it as an agent session even when its node was never
// explicitly tagged with an agentRole — so the per-terminal agent panel works
// out of the box for every AI tool, not just pre-tagged Claude nodes.
const AI_CLI_RE = /\b(claude|codex|gemini|aider|opencode|crush|qwen|cursor-agent|copilot|goose|cline|amp|ollama\s+run)\b/i

// Output banners that reveal an AI CLI was started by hand inside a plain shell
// (so startupCommand is empty). Conservative — specific phrases only, to avoid
// flipping an ordinary terminal into "agent mode" on a stray keyword.
const AI_BANNER_RE = /welcome to claude code|claude code v|▐▛|welcome to codex|openai codex|gemini cli|aider v\d|opencode|goose session|╭─+ *codex/i

// Tool invocations as AI CLIs actually render them: a bullet (stripped upstream)
// followed by `ToolName(args)`. Deterministic and low false-positive.
const TOOL_NAMES = 'Bash|Read|Edit|Write|MultiEdit|Grep|Glob|WebFetch|WebSearch|NotebookEdit|TodoWrite|Update|LS|Search|Fetch|Move|Rename|Delete'
const TOOL_CALL_RE = new RegExp(`^(?:${TOOL_NAMES})\\(`)

// Terminals observed running an AI CLI this session (via startupCommand or a
// banner in the output). Module-level so detection persists across data chunks.
const aiToolTerminals = new Set<string>()

const AGENT_PATTERNS: { kind: AgentActivity['kind']; re: RegExp; nameGroup?: number; messageGroup?: number }[] = [
  // Structured / explicit sub-agent handoffs first (most reliable).
  { kind: 'handoff', re: /@@HANDOFF@@([\s\S]*?)@@END@@/i, messageGroup: 1 },
  // Claude Code Task tool = a sub-agent dispatch: `Task(description)`.
  { kind: 'subagent', re: /^Task\(([\s\S]{0,180}?)\)\s*$/, messageGroup: 1 },
  { kind: 'subagent', re: /\b(?:sub-?agent|agent team|team agent|dispatch(?:ing)? agent|spawn(?:ing)? agent)\b[:\s-]*([A-Za-z0-9 _.-]+)?/i, nameGroup: 1 },
  // Real tool-call render: `Bash(npm test)`, `Read(src/foo.ts)`, etc.
  { kind: 'tool', re: new RegExp(`^((?:${TOOL_NAMES})\\([\\s\\S]{0,180}?\\))`), messageGroup: 1 },
  { kind: 'task', re: /\b(?:Task|Todo|Plan|Delegating|Assigned)\b[:\s-]+(.+)/i, messageGroup: 1 },
  { kind: 'tool', re: /\b(?:Tool|Using tool|Running tool|Bash|Edit|Read|Write)\b[:\s-]+(.+)/i, messageGroup: 1 },
  { kind: 'status', re: /\b(?:started|completed|finished|failed|error|reviewing|coding|testing|debugging|thinking|running)\b[:\s-]*(.+)?/i, messageGroup: 1 }
]

export function parseAgentActivities(
  terminalId: string,
  data: string,
  nodes: CanvasNode[],
  terminals: Record<string, TerminalSession>
): AgentActivity[] {
  const node = nodes.find((n) => n.terminalId === terminalId || (n.panes ? getLeafTerminalIds(n.panes).includes(terminalId) : false))
  const terminal = terminals[terminalId]

  // Treat this terminal as an agent session if EITHER it was explicitly tagged
  // (agentType/agentRole), OR it runs a known AI CLI (detected from its launch
  // command or, for hand-typed sessions, from a banner in the output). Once
  // detected via a banner the flag sticks for the rest of the session.
  const startup = terminal?.startupCommand || ''
  if (AI_CLI_RE.test(startup)) aiToolTerminals.add(terminalId)
  if (!aiToolTerminals.has(terminalId) && AI_BANNER_RE.test(data)) aiToolTerminals.add(terminalId)
  const isAgentSession = !!(node?.agentType || node?.agentRole) || aiToolTerminals.has(terminalId)
  if (!isAgentSession) return []

  const sourceName = node?.agentRole || node?.title || terminal?.name || 'Agent'
  const lines = data
    .split(/\r?\n/)
    // TUI frames are full of chrome: CSI cursor moves (replaced with a space so
    // adjacent words don't fuse into "Run/inittocreate"), OSC sequences, and
    // box-drawing/block glyphs. A line that used box-drawing chars is frame
    // decoration (banners, borders), not an agent event — drop it entirely.
    .filter((line) => !/[─-╿]/.test(line))
    .map((line) =>
      line
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ' ')
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ' ')
        .replace(/[▀-▟■-◿⠀-⣿]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter((line) => line.length >= 4)
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
    if (
      !TOOL_CALL_RE.test(line) &&
      !/\b(agent|subagent|team|task|todo|tool|handoff|delegat|assigned|spawn|dispatch|started|completed|finished|failed|error|review|coding|testing|debug|thinking|running)\b|@@HANDOFF@@/i.test(line)
    ) {
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
  const LEGACY: Record<string, string> = {
    dark: 'vscode-dark',
    light: 'vscode-light',
    mocha: 'vscode-dark',
    latte: 'vscode-light',
    matcha: 'vscode-light',
    frappe: 'vscode-dark',
    macchiato: 'vscode-dark',
    kanagawa: 'tokyo-night',
    ayu: 'one-dark-pro',
    'rose-pine': 'tokyo-night'
  }
  const resolve = (): void => {
    const raw: string = theme === 'system' ? (systemDark() ? 'vscode-dark' : 'vscode-light') : theme
    const resolved = LEGACY[raw] ?? raw
    const isLight = resolved === 'vscode-light'
    root.setAttribute('data-theme', resolved)
    const opacity = Math.max(45, Math.min(100, transparency))
    root.toggleAttribute('data-transparency', opacity < 100)
    root.style.setProperty('--user-opacity', String(opacity / 100))
    // Keep the native Windows titlebar overlay (min/max/close) in sync with the
    // ACTIVE theme's real palette: read the computed CSS variables instead of
    // hardcoding two colorways, so every theme matches the toolbar.
    const css = getComputedStyle(root)
    const bg = css.getPropertyValue('--bg-panel').trim()
    const symbol = css.getPropertyValue('--text-secondary').trim()
    window.termflow.window.setOverlay(
      bg || (isLight ? '#eaedf3' : '#20242c'),
      symbol || (isLight ? '#4a5162' : '#a0a7b4')
    )
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

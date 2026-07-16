import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { writeFile, rename } from 'fs/promises'
import { nanoid } from 'nanoid'
import type {
  Workspace,
  TerminalSession,
  WorkspaceLayout,
  CanvasNode,
  AgentConnection,
  LayoutMode,
  AppSettings,
  Snippet,
  HighlightRule,
  SshProfile,
  EnvEntry,
  PaneNode
} from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/types'

/**
 * Lightweight JSON-file persistence for workspaces, terminals and canvas
 * layouts. The API mirrors a repository layer so the storage backend can be
 * swapped later without touching IPC.
 * Writes are atomic (temp file + rename). (PRD §15 — same schema, JSON shape.)
 */

interface StoreShape {
  workspaces: Workspace[]
  terminals: TerminalSession[]
  nodes: CanvasNode[]
  connections: AgentConnection[]
  viewports: Record<string, { layoutMode: LayoutMode; zoom: number; x: number; y: number; activeNodeId?: string }>
  settings: AppSettings
  snippets: Snippet[]
  highlightRules: HighlightRule[]
  sshProfiles: SshProfile[]
  envVars: EnvEntry[]
}

let store: StoreShape
let filePath: string

function empty(): StoreShape {
  return {
    workspaces: [], terminals: [], nodes: [], connections: [],
    viewports: {}, settings: { ...DEFAULT_SETTINGS },
    snippets: [], highlightRules: [], sshProfiles: [], envVars: []
  }
}

// ---- Settings ----

export function getSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...store.settings }
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  store.settings = { ...getSettings(), ...patch }
  persist()
  return store.settings
}

// ---- Persistence: debounced async writes with an in-flight lock ----
//
// persist() marks the store dirty and schedules a debounced async flush.
// A single-slot lock prevents overlapping writes: if more mutations arrive
// while a flush is running, one more flush runs when it completes.
// Writes stay atomic (temp file + rename). flushSync() forces a synchronous
// write on shutdown so nothing is lost.

const DEBOUNCE_MS = 150
let dirty = false
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushing = false

function serialize(): string {
  return JSON.stringify(store, null, 2)
}

async function flush(): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    while (dirty) {
      dirty = false
      const data = serialize()
      const tmp = filePath + '.tmp'
      try {
        await writeFile(tmp, data, 'utf-8')
        await rename(tmp, filePath)
      } catch (err) {
        console.error('[database] flush failed:', err)
      }
    }
  } finally {
    flushing = false
  }
}

function persist(): void {
  dirty = true
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, DEBOUNCE_MS)
}

/**
 * Cancel any pending debounce and write the store synchronously.
 * Call on app shutdown (before-quit / window-all-closed) to avoid data loss.
 */
export function flushSync(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (!dirty && !filePath) return
  dirty = false
  try {
    const tmp = filePath + '.tmp'
    writeFileSync(tmp, serialize(), 'utf-8')
    renameSync(tmp, filePath)
  } catch (err) {
    console.error('[database] flushSync failed:', err)
  }
}

function now(): string {
  return new Date().toISOString()
}

export function initDatabase(): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  filePath = join(dir, 'termflow.json')
  if (existsSync(filePath)) {
    try {
      store = { ...empty(), ...JSON.parse(readFileSync(filePath, 'utf-8')) }
    } catch {
      store = empty()
    }
  } else {
    store = empty()
  }
  if (store.workspaces.length === 0) {
    createWorkspace({
      name: 'Default',
      path: app.getPath('home'),
      description: 'Default workspace',
      defaultLayoutMode: 'manual'
    })
  } else {
    persist()
  }
}

// ---- Workspaces ----

export function listWorkspaces(): Workspace[] {
  return [...store.workspaces].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

export function createWorkspace(input: {
  name: string
  path: string
  description?: string
  icon?: string
  defaultLayoutMode?: LayoutMode
}): Workspace {
  const ts = now()
  const ws: Workspace = {
    id: nanoid(),
    name: input.name,
    path: input.path,
    description: input.description,
    icon: input.icon,
    defaultLayoutMode: input.defaultLayoutMode ?? 'manual',
    createdAt: ts,
    updatedAt: ts,
    lastOpenedAt: ts
  }
  store.workspaces.push(ws)
  store.viewports[ws.id] = { layoutMode: ws.defaultLayoutMode, zoom: 1, x: 0, y: 0 }
  persist()
  return ws
}

export function updateWorkspace(id: string, patch: Partial<Workspace>): void {
  const ws = store.workspaces.find((w) => w.id === id)
  if (!ws) return
  Object.assign(ws, patch, { updatedAt: now() })
  persist()
}

export function deleteWorkspace(id: string): void {
  store.workspaces = store.workspaces.filter((w) => w.id !== id)
  store.terminals = store.terminals.filter((t) => t.workspaceId !== id)
  store.nodes = store.nodes.filter((n) => n.workspaceId !== id)
  store.connections = store.connections.filter((c) => c.workspaceId !== id)
  delete store.viewports[id]
  persist()
}

// ---- Terminals ----

export function listTerminals(workspaceId: string): TerminalSession[] {
  return store.terminals
    .filter((t) => t.workspaceId === workspaceId)
    .map((t) => ({ ...t, status: 'stopped' as const }))
}

export function upsertTerminal(t: TerminalSession): void {
  const idx = store.terminals.findIndex((x) => x.id === t.id)
  const record = { ...t, updatedAt: now() }
  if (idx >= 0) store.terminals[idx] = record
  else store.terminals.push(record)
  persist()
}

export function deleteTerminal(id: string): void {
  store.terminals = store.terminals.filter((t) => t.id !== id)
  store.nodes = store.nodes.filter((n) => n.terminalId !== id && !paneHasTerminal(n.panes, id))
  persist()
}

// ---- Node migration: convert legacy single-terminal nodes to pane-tree ----
function migrateNode(node: CanvasNode): CanvasNode {
  if (!node.panes && node.terminalId) {
    return {
      ...node,
      panes: { type: 'leaf', terminalId: node.terminalId, title: node.title },
      activePaneId: node.terminalId
    }
  }
  return node
}

function paneHasTerminal(pane: PaneNode | undefined, terminalId: string): boolean {
  if (!pane) return false
  if (pane.type === 'leaf') return pane.terminalId === terminalId
  return paneHasTerminal(pane.a, terminalId) || paneHasTerminal(pane.b, terminalId)
}

export function remapPaneIds(
  pane: PaneNode | undefined,
  remap: (oldId: string) => string
): PaneNode | undefined {
  if (!pane) return undefined
  if (pane.type === 'leaf') return { ...pane, terminalId: remap(pane.terminalId) }
  return {
    ...pane,
    a: remapPaneIds(pane.a, remap)!,
    b: remapPaneIds(pane.b, remap)!
  }
}

// ---- Layout ----

export function getLayout(workspaceId: string): WorkspaceLayout {
  const nodes = store.nodes.filter((n) => n.workspaceId === workspaceId).map(migrateNode)
  const connections = store.connections.filter((c) => c.workspaceId === workspaceId)
  const vp = store.viewports[workspaceId] ?? { layoutMode: 'manual' as LayoutMode, zoom: 1, x: 0, y: 0 }
  return {
    workspaceId,
    nodes,
    connections,
    layoutMode: vp.layoutMode,
    viewport: { zoom: vp.zoom, x: vp.x, y: vp.y },
    activeNodeId: vp.activeNodeId
  }
}

// ---- Snippets ----

export function listSnippets(workspaceId?: string): Snippet[] {
  return store.snippets.filter((s) => !workspaceId || s.workspaceId === workspaceId || s.scope === 'global')
}

export function createSnippet(input: Omit<Snippet, 'id' | 'createdAt' | 'updatedAt'>): Snippet {
  const ts = now()
  const s: Snippet = { id: nanoid(), ...input, createdAt: ts, updatedAt: ts }
  store.snippets.push(s)
  persist()
  return s
}

export function updateSnippet(id: string, patch: Partial<Snippet>): void {
  const idx = store.snippets.findIndex((s) => s.id === id)
  if (idx < 0) return
  store.snippets[idx] = { ...store.snippets[idx], ...patch, updatedAt: now() }
  persist()
}

export function deleteSnippet(id: string): void {
  store.snippets = store.snippets.filter((s) => s.id !== id)
  persist()
}

// ---- Highlight Rules ----

export function listHighlightRules(workspaceId?: string): HighlightRule[] {
  return store.highlightRules.filter((r) => !workspaceId || !r.workspaceId || r.workspaceId === workspaceId)
}

export function createHighlightRule(input: Omit<HighlightRule, 'id'>): HighlightRule {
  const r: HighlightRule = { id: nanoid(), ...input }
  store.highlightRules.push(r)
  persist()
  return r
}

export function updateHighlightRule(id: string, patch: Partial<HighlightRule>): void {
  const idx = store.highlightRules.findIndex((r) => r.id === id)
  if (idx < 0) return
  store.highlightRules[idx] = { ...store.highlightRules[idx], ...patch }
  persist()
}

export function deleteHighlightRule(id: string): void {
  store.highlightRules = store.highlightRules.filter((r) => r.id !== id)
  persist()
}

// ---- SSH Profiles ----

export function listSshProfiles(workspaceId: string): SshProfile[] {
  return store.sshProfiles.filter((p) => p.workspaceId === workspaceId)
}

export function createSshProfile(input: Omit<SshProfile, 'id' | 'createdAt'>): SshProfile {
  const p: SshProfile = { id: nanoid(), ...input, createdAt: now() }
  store.sshProfiles.push(p)
  persist()
  return p
}

export function updateSshProfile(id: string, patch: Partial<SshProfile>): void {
  const idx = store.sshProfiles.findIndex((p) => p.id === id)
  if (idx < 0) return
  store.sshProfiles[idx] = { ...store.sshProfiles[idx], ...patch }
  persist()
}

export function deleteSshProfile(id: string): void {
  store.sshProfiles = store.sshProfiles.filter((p) => p.id !== id)
  persist()
}

// ---- Env Vars ----

export function listEnvVars(workspaceId: string): EnvEntry[] {
  return store.envVars.filter((e) => e.workspaceId === workspaceId)
}

export function getEnvVar(id: string): EnvEntry | undefined {
  return store.envVars.find((e) => e.id === id)
}

export function createEnvVar(input: Omit<EnvEntry, 'id'>): EnvEntry {
  const e: EnvEntry = { id: nanoid(), ...input }
  store.envVars.push(e)
  persist()
  return e
}

export function updateEnvVar(id: string, patch: Partial<EnvEntry>): void {
  const idx = store.envVars.findIndex((e) => e.id === id)
  if (idx < 0) return
  store.envVars[idx] = { ...store.envVars[idx], ...patch }
  persist()
}

export function deleteEnvVar(id: string): void {
  store.envVars = store.envVars.filter((e) => e.id !== id)
  persist()
}

// ---- Workspace Export/Import ----

export function exportWorkspaceData(workspaceId: string): {
  terminals: TerminalSession[]
  nodes: CanvasNode[]
  connections: AgentConnection[]
  snippets: Snippet[]
  highlightRules: HighlightRule[]
  sshProfiles: SshProfile[]
  envVars: EnvEntry[]
  viewport: { zoom: number; x: number; y: number } | null
} {
  return {
    terminals: store.terminals.filter((t) => t.workspaceId === workspaceId),
    nodes: store.nodes.filter((n) => n.workspaceId === workspaceId),
    connections: store.connections.filter((c) => c.workspaceId === workspaceId),
    snippets: store.snippets.filter((s) => s.workspaceId === workspaceId),
    highlightRules: store.highlightRules.filter((r) => r.workspaceId === workspaceId),
    sshProfiles: store.sshProfiles.filter((p) => p.workspaceId === workspaceId),
    envVars: store.envVars.filter((e) => e.workspaceId === workspaceId),
    viewport: store.viewports[workspaceId] ?? null
  }
}

export function importWorkspaceData(
  workspaceId: string,
  terminals: TerminalSession[],
  nodes: CanvasNode[],
  connections: AgentConnection[],
  snippets: Snippet[],
  highlightRules: HighlightRule[],
  sshProfiles: SshProfile[],
  envVars: EnvEntry[],
  viewport: { zoom: number; x: number; y: number }
): void {
  store.terminals = store.terminals.filter((t) => t.workspaceId !== workspaceId).concat(terminals)
  store.nodes = store.nodes.filter((n) => n.workspaceId !== workspaceId).concat(nodes)
  store.connections = store.connections.filter((c) => c.workspaceId !== workspaceId).concat(connections)
  store.snippets = store.snippets.filter((s) => s.workspaceId !== workspaceId).concat(snippets)
  store.highlightRules = store.highlightRules.filter((r) => r.workspaceId !== workspaceId).concat(highlightRules)
  store.sshProfiles = store.sshProfiles.filter((p) => p.workspaceId !== workspaceId).concat(sshProfiles)
  store.envVars = store.envVars.filter((e) => e.workspaceId !== workspaceId).concat(envVars)
  store.viewports[workspaceId] = { layoutMode: 'manual' as LayoutMode, ...viewport }
  persist()
}

export function saveLayout(layout: WorkspaceLayout): void {
  store.nodes = store.nodes.filter((n) => n.workspaceId !== layout.workspaceId).concat(layout.nodes)
  store.connections = store.connections
    .filter((c) => c.workspaceId !== layout.workspaceId)
    .concat(layout.connections)
  store.viewports[layout.workspaceId] = {
    layoutMode: layout.layoutMode,
    zoom: layout.viewport.zoom,
    x: layout.viewport.x,
    y: layout.viewport.y,
    activeNodeId: layout.activeNodeId
  }
  persist()
}

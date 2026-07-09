import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { nanoid } from 'nanoid'
import type {
  Workspace,
  TerminalSession,
  WorkspaceLayout,
  CanvasNode,
  AgentConnection,
  LayoutMode,
  AppSettings
} from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/types'

/**
 * Lightweight JSON-file persistence for workspaces, terminals and canvas
 * layouts. Chosen over better-sqlite3 because that package's bundled sqlite
 * requires the ClangCL toolset to build on this Windows host. The API mirrors a
 * repository layer so it can be swapped for SQLite later without touching IPC.
 * Writes are atomic (temp file + rename). (PRD §15 — same schema, JSON shape.)
 */

interface StoreShape {
  workspaces: Workspace[]
  terminals: TerminalSession[]
  nodes: CanvasNode[]
  connections: AgentConnection[]
  viewports: Record<string, { layoutMode: LayoutMode; zoom: number; x: number; y: number }>
  settings: AppSettings
}

let store: StoreShape
let filePath: string

function empty(): StoreShape {
  return { workspaces: [], terminals: [], nodes: [], connections: [], viewports: {}, settings: { ...DEFAULT_SETTINGS } }
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

function persist(): void {
  const tmp = filePath + '.tmp'
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8')
  renameSync(tmp, filePath)
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
      description: 'İlk workspace',
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
  store.nodes = store.nodes.filter((n) => n.terminalId !== id)
  persist()
}

// ---- Layout ----

export function getLayout(workspaceId: string): WorkspaceLayout {
  const nodes = store.nodes.filter((n) => n.workspaceId === workspaceId)
  const connections = store.connections.filter((c) => c.workspaceId === workspaceId)
  const vp = store.viewports[workspaceId] ?? { layoutMode: 'manual' as LayoutMode, zoom: 1, x: 0, y: 0 }
  return {
    workspaceId,
    nodes,
    connections,
    layoutMode: vp.layoutMode,
    viewport: { zoom: vp.zoom, x: vp.x, y: vp.y }
  }
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
    y: layout.viewport.y
  }
  persist()
}

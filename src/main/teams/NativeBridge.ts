import { existsSync, readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// Normalized view of a native Claude agent team, mapped from the experimental
// ~/.claude/teams/<name>/config.json + ~/.claude/tasks/<name>/*.json layout.
// The on-disk schema is experimental, so every field lookup is defensive.
export interface NativeMemberState {
  name: string
  id?: string
  status?: string
  lead?: boolean
}
export interface NativeTaskState {
  id?: string
  title: string
  description?: string
  status?: string
  owner?: string
  blockedBy?: string[]
}
export interface NativeTeamState {
  members: NativeMemberState[]
  tasks: NativeTaskState[]
  /** Whether the team directory exists on disk right now. */
  exists: boolean
  /** True only when the team config itself reports the team shut down/completed. */
  closed: boolean
  parseError?: boolean
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) if (obj[key] != null) return obj[key]
  return undefined
}

// Parse a native team config.json into members. Tolerant of unknown fields and
// of the array living under members/agents/teammates.
export function parseTeamConfig(raw: string): { members: NativeMemberState[]; closed: boolean } {
  const data = JSON.parse(raw) as Record<string, unknown>
  const arr = pick(data, ['members', 'agents', 'teammates'])
  const members: NativeMemberState[] = []
  if (Array.isArray(arr)) {
    for (const entry of arr) {
      if (!entry || typeof entry !== 'object') continue
      const rec = entry as Record<string, unknown>
      const name = str(pick(rec, ['name', 'id', 'agentId'])) || 'Teammate'
      const role = str(pick(rec, ['role', 'kind', 'type']))
      const lead = pick(rec, ['lead', 'isLead']) === true || role === 'lead'
      members.push({ name, id: str(pick(rec, ['id', 'agentId'])), status: str(pick(rec, ['status', 'state'])), lead })
    }
  }
  const closed = pick(data, ['closed', 'shutdown', 'completed']) === true || str(pick(data, ['status', 'state'])) === 'completed'
  return { members, closed }
}

// Parse a single native task file. Tolerant of unknown fields.
export function parseTaskFile(raw: string): NativeTaskState {
  const rec = JSON.parse(raw) as Record<string, unknown>
  return {
    id: str(pick(rec, ['id', 'taskId'])),
    title: str(pick(rec, ['subject', 'title', 'name'])) || str(pick(rec, ['description'])) || 'Task',
    description: str(pick(rec, ['description', 'details', 'body'])),
    status: str(pick(rec, ['status', 'state'])),
    owner: str(pick(rec, ['owner', 'assignee', 'assignedTo'])),
    blockedBy: Array.isArray(pick(rec, ['blockedBy', 'dependencies'])) ? (pick(rec, ['blockedBy', 'dependencies']) as unknown[]).map((v) => String(v)) : undefined
  }
}

function teamDir(teamName: string): string {
  return join(homedir(), '.claude', 'teams', teamName)
}
function tasksDir(teamName: string): string {
  return join(homedir(), '.claude', 'tasks', teamName)
}

// Read + normalize the current on-disk state for a native team. Never throws:
// a malformed config/task surfaces as parseError instead of crashing.
export function readNativeTeamState(teamName: string): NativeTeamState {
  const cfgPath = join(teamDir(teamName), 'config.json')
  const exists = existsSync(teamDir(teamName))
  let members: NativeMemberState[] = []
  let closed = false
  let parseError = false
  if (existsSync(cfgPath)) {
    try {
      const parsed = parseTeamConfig(readFileSync(cfgPath, 'utf8'))
      members = parsed.members
      closed = parsed.closed
    } catch { parseError = true }
  }
  const tasks: NativeTaskState[] = []
  const tdir = tasksDir(teamName)
  if (existsSync(tdir)) {
    try {
      for (const file of readdirSync(tdir)) {
        if (!file.toLowerCase().endsWith('.json')) continue
        try { tasks.push(parseTaskFile(readFileSync(join(tdir, file), 'utf8'))) } catch { parseError = true }
      }
    } catch { parseError = true }
  }
  return { members, tasks, exists, closed, parseError }
}

// Poll ~/.claude for a native team and invoke onState with each snapshot.
// fs.watch is unreliable on Windows, so we use a steady 2s interval.
export function watchTeam(teamName: string, onState: (state: NativeTeamState) => void, intervalMs = 2000): () => void {
  let stopped = false
  const tick = (): void => { if (!stopped) onState(readNativeTeamState(teamName)) }
  const timer = setInterval(tick, intervalMs)
  tick()
  return () => { stopped = true; clearInterval(timer) }
}

import { existsSync, readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// Normalized view of a native Claude agent team. Claude Code 2.1.x does NOT
// create ~/.claude/teams/<name>/; instead the live task list lives under
// ~/.claude/tasks/session-<hex>/ as <n>.json files (deleted once completed),
// alongside .highwatermark and .lock. The team-name -> session mapping is not
// known ahead of time, so we discover the new session dir by diffing a baseline
// snapshot taken just before the CLI starts. The legacy teams/ layout is still
// probed first for forward compatibility. Every field lookup is defensive.
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
  /** True once the legacy teams dir OR a session task dir has been discovered. */
  exists: boolean
  /** True only when a legacy team config reports the team shut down/completed. */
  closed: boolean
  /** The discovered ~/.claude/tasks/session-* dir name, if any. */
  sessionDir?: string
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

// Parse the completion sentinel the lead writes as its final step. Tolerant of
// unknown fields; always returns a summary string (possibly empty).
export function parseDoneSentinel(raw: string): { summary: string } {
  try {
    const rec = JSON.parse(raw) as Record<string, unknown>
    return { summary: str(pick(rec, ['summary', 'result', 'outcome'])) || '' }
  } catch {
    // The lead may write plain text instead of JSON — keep a trimmed snippet.
    return { summary: raw.trim().slice(0, 500) }
  }
}

function teamDir(teamName: string): string {
  return join(homedir(), '.claude', 'teams', teamName)
}
function tasksRoot(): string {
  return join(homedir(), '.claude', 'tasks')
}

// Snapshot the current set of session-* task dirs so a later diff can spot the
// one the lead creates for this run.
export function snapshotSessionDirs(): Set<string> {
  const root = tasksRoot()
  if (!existsSync(root)) return new Set()
  try {
    return new Set(readdirSync(root).filter((name) => /^session-/i.test(name)))
  } catch { return new Set() }
}

// First session-* dir not present in the baseline snapshot, or null.
export function findNewSessionDir(baseline: Set<string>): string | null {
  const root = tasksRoot()
  if (!existsSync(root)) return null
  try {
    for (const name of readdirSync(root)) {
      if (/^session-/i.test(name) && !baseline.has(name)) return name
    }
  } catch { /* ignore */ }
  return null
}

// Read the *.json task files in a session dir, skipping .lock/.highwatermark and
// any non-JSON control files. Sets a parse-error flag out-of-band via the caller.
export function readSessionTasks(dirName: string): { tasks: NativeTaskState[]; parseError: boolean } {
  const dir = join(tasksRoot(), dirName)
  const tasks: NativeTaskState[] = []
  let parseError = false
  if (!existsSync(dir)) return { tasks, parseError }
  try {
    for (const file of readdirSync(dir)) {
      const lower = file.toLowerCase()
      if (!lower.endsWith('.json') || lower.startsWith('.')) continue
      try { tasks.push(parseTaskFile(readFileSync(join(dir, file), 'utf8'))) } catch { parseError = true }
    }
  } catch { parseError = true }
  return { tasks, parseError }
}

// Read + normalize the current on-disk state. Never throws. `sessionDir` is the
// session-* dir already discovered for this run (from the watch closure); when
// absent, only the legacy teams/ layout is consulted.
export function readNativeTeamState(teamName: string, sessionDir?: string): NativeTeamState {
  const legacyDir = teamDir(teamName)
  const legacyExists = existsSync(legacyDir)
  let members: NativeMemberState[] = []
  let closed = false
  let parseError = false
  const tasks: NativeTaskState[] = []

  if (legacyExists) {
    const cfgPath = join(legacyDir, 'config.json')
    if (existsSync(cfgPath)) {
      try { const parsed = parseTeamConfig(readFileSync(cfgPath, 'utf8')); members = parsed.members; closed = parsed.closed }
      catch { parseError = true }
    }
    const legacyTasks = join(homedir(), '.claude', 'tasks', teamName)
    if (existsSync(legacyTasks)) {
      try {
        for (const file of readdirSync(legacyTasks)) {
          if (!file.toLowerCase().endsWith('.json')) continue
          try { tasks.push(parseTaskFile(readFileSync(join(legacyTasks, file), 'utf8'))) } catch { parseError = true }
        }
      } catch { parseError = true }
    }
  }

  if (!legacyExists && sessionDir) {
    const res = readSessionTasks(sessionDir)
    tasks.push(...res.tasks)
    if (res.parseError) parseError = true
  }

  const exists = legacyExists || !!sessionDir
  return { members, tasks, exists, closed, sessionDir, parseError }
}

// Poll ~/.claude for a native team and invoke onState with each snapshot. The
// session dir is discovered lazily by diffing against `baseline` (captured just
// before the CLI started). fs.watch is unreliable on Windows, so we poll at 2s.
export function watchTeam(teamName: string, baseline: Set<string>, onState: (state: NativeTeamState) => void, intervalMs = 2000): () => void {
  let stopped = false
  let sessionDir: string | undefined
  const tick = (): void => {
    if (stopped) return
    if (!sessionDir) { const found = findNewSessionDir(baseline); if (found) sessionDir = found }
    onState(readNativeTeamState(teamName, sessionDir))
  }
  const timer = setInterval(tick, intervalMs)
  tick()
  return () => { stopped = true; clearInterval(timer) }
}

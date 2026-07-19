import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { AgentTeamBundle, TeamMember, TeamPermissionPolicy, TeamTask } from '../../shared/types'

export interface RuntimeAdapter {
  id: TeamMember['provider']
  label: string
  structured: boolean
  build(prompt: string, policy: TeamPermissionPolicy): { command: string; args: string[] }
  parse(line: string): { type: 'tool' | 'message' | 'result'; message: string; sessionId?: string } | null
}

function jsonLine(line: string): Record<string, unknown> | null {
  try { const value = JSON.parse(line); return value && typeof value === 'object' ? value as Record<string, unknown> : null } catch { return null }
}

// Resolve a provider CLI from PATH instead of guessing at an npm-global path.
// `where <name>` returns the first match; cache it so we don't spawn per call.
const cliCache = new Map<string, string>()
function resolveCli(name: string): string {
  const cached = cliCache.get(name)
  if (cached) return cached
  let resolved = name
  try {
    const res = spawnSync('where', [name], { windowsHide: true, encoding: 'utf8' })
    const first = res.status === 0 ? res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] : ''
    if (first) resolved = first
  } catch { /* leave as name — let PATH resolve at spawn time */ }
  cliCache.set(name, resolved)
  return resolved
}

// Build a spawnable spec for a resolved CLI. A .ps1 must run through
// powershell.exe -File; .cmd/.exe/plain names spawn directly.
function cliLaunch(name: string, args: string[]): { command: string; args: string[] } {
  const resolved = resolveCli(name)
  if (resolved.toLowerCase().endsWith('.ps1')) return { command: 'powershell.exe', args: ['-NoProfile', '-File', resolved, ...args] }
  return { command: resolved, args }
}

// Per-provider secret hygiene: strips other providers' keys and common
// deployment/infra secrets so an agent only sees credentials for its own
// provider. opencode/generic are provider-agnostic, so every known provider
// prefix is preserved for them, but general secret patterns are still stripped.
const KEEP_PREFIXES: Record<TeamMember['provider'], string[]> = {
  claude: ['ANTHROPIC_', 'CLAUDE_CODE_'],
  codex: ['OPENAI_'],
  opencode: ['ANTHROPIC_', 'CLAUDE_CODE_', 'OPENAI_', 'OPENROUTER_', 'DEEPSEEK_', 'OLLAMA_'],
  generic: ['ANTHROPIC_', 'CLAUDE_CODE_', 'OPENAI_', 'OPENROUTER_', 'DEEPSEEK_', 'OLLAMA_']
}
const OTHER_PROVIDER_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_', 'OPENAI_', 'OPENROUTER_', 'DEEPSEEK_', 'OLLAMA_']
const SECRET_PREFIXES = ['AWS_', 'GITHUB_', 'GH_', 'GITLAB_', 'VERCEL_', 'NETLIFY_', 'CLOUDFLARE_', 'AZURE_', 'GOOGLE_', 'FIREBASE_', 'SUPABASE_', 'STRIPE_', 'TWILIO_', 'SENDGRID_', 'SLACK_', 'DISCORD_', 'TELEGRAM_', 'NPM_TOKEN', 'DATABASE_URL', 'REDIS_URL', 'MONGODB_']
const SECRET_SUFFIXES = ['_TOKEN', '_SECRET', '_PASSWORD', '_PRIVATE_KEY', '_ACCESS_KEY', '_API_KEY']
export function providerEnv(provider: TeamMember['provider']): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const keep = KEEP_PREFIXES[provider] ?? []
  for (const key of Object.keys(env)) {
    const up = key.toUpperCase()
    // Own-provider protection comes first: never strip a key we must keep.
    if (keep.some((p) => up.startsWith(p))) continue
    // Strip other providers' keys and common deployment/infra secret patterns.
    if (OTHER_PROVIDER_PREFIXES.some((p) => up.startsWith(p)) || SECRET_PREFIXES.some((p) => up.startsWith(p)) || SECRET_SUFFIXES.some((s) => up.endsWith(s))) delete env[key]
  }
  return env
}

export const ADAPTERS: Record<TeamMember['provider'], RuntimeAdapter> = {
  claude: {
    id: 'claude', label: 'Claude Code', structured: true,
    build: (prompt, policy) => cliLaunch('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', policy === 'review' ? 'plan' : policy === 'balanced' ? 'acceptEdits' : policy === 'full' ? 'bypassPermissions' : 'default']),
    parse: (line) => { const value = jsonLine(line); if (!value) return null; const type = String(value.type || ''); const sessionId = typeof value.session_id === 'string' ? value.session_id : undefined; if (type === 'result') return { type: 'result', message: String(value.result || 'Task completed.'), sessionId }; if (type === 'assistant') { const msg = value.message as Record<string, unknown> | undefined; const content = Array.isArray(msg?.content) ? (msg!.content as Array<Record<string, unknown>>) : []; const text = content.filter((c) => c.type === 'text').map((c) => String(c.text || '')).join('').trim(); return text ? { type: 'message', message: text.slice(0, 1000), sessionId } : null } return null }
  },
  codex: {
    id: 'codex', label: 'Codex', structured: true,
    // Codex defaults to asking for approval. 'review'/'controlled' (pre-approval)
    // run read-only; only 'full' gets the sandbox/approval bypass. 'balanced' and
    // approved 'controlled' (mapped to balanced upstream) run with normal approvals.
    build: (prompt, policy) => cliLaunch('codex', ['exec', '--json', ...(policy === 'review' || policy === 'controlled' ? ['--sandbox', 'read-only'] : []), ...(policy === 'full' ? ['--dangerously-bypass-approvals-and-sandbox'] : []), prompt]),
    parse: (line) => { const value = jsonLine(line); if (!value) return null; const item = value.item as Record<string, unknown> | undefined; const message = String(item?.text || value.message || ''); return message ? { type: String(value.type).includes('completed') ? 'result' : 'message', message: message.slice(0, 1000) } : null }
  },
  opencode: {
    id: 'opencode', label: 'OpenCode', structured: true,
    // opencode has no reliable read-only flag; policy read-only guarantees can't
    // be enforced here, so worktree isolation (prepareWorktree) is what keeps the
    // main workspace safe on every policy.
    build: (prompt) => cliLaunch('opencode', ['run', '--format', 'json', prompt]),
    parse: (line) => { const value = jsonLine(line); if (!value) return null; const message = String(value.text || value.message || ''); return message ? { type: 'message', message: message.slice(0, 1000) } : null }
  },
  generic: {
    id: 'generic', label: 'Claude (basic)', structured: false,
    // Legacy provider kept for backward-compatible records; it falls back to a
    // plain `claude -p` run with no policy flags. Isolation is provided by the
    // per-team git worktree (prepareWorktree), not by a CLI permission mode.
    build: (prompt) => cliLaunch('claude', ['-p', prompt]),
    parse: (line) => line.trim() ? { type: 'message', message: line.trim().slice(0, 1000) } : null
  }
}

export interface RuntimeCallbacks {
  getTeam(id: string): AgentTeamBundle | undefined
  workspacePath(workspaceId: string): string | undefined
  runtimeRoot(): string
  updateTeam(id: string, patch: Partial<Pick<AgentTeamBundle['team'], 'status' | 'worktreePath' | 'worktreeBranch' | 'baseCommit' | 'appliedAt' | 'nativeTeamName'>>): void
  updateMember(id: string, patch: Partial<Pick<TeamMember, 'status' | 'sessionId' | 'terminalId'>>): void
  updateTask(id: string, patch: Partial<Pick<TeamTask, 'status' | 'result'>>): void
  event(input: { teamId: string; memberId?: string; taskId?: string; type: 'member.started' | 'task.updated' | 'note' | 'runtime.lost'; message: string }): void
  /** Native-only: reconcile the DB model with a normalized native team state. */
  syncNativeState?(teamId: string, state: unknown): void
  /** Native-only: mark any still-open synced tasks completed (files are transient). */
  completeOpenNativeTasks?(teamId: string): void
}

// Isolate a team's work in a git worktree so no agent can touch the main
// workspace directly. Shared by the workflow and native runtimes; behavior is
// identical to the original TeamRuntime.prepareWorktree.
export function prepareTeamWorktree(bundle: AgentTeamBundle, workspace: string, callbacks: RuntimeCallbacks): string {
  const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: workspace, windowsHide: true, encoding: 'utf8' })
  if (probe.status !== 0) {
    const claudeOnlyReview = bundle.team.permissionPolicy === 'review' && bundle.members.every((m) => m.provider === 'claude')
    if (!claudeOnlyReview) throw new Error("This workspace is not a Git repository. Only a Claude-only 'Review only' team can run without worktree isolation.")
    return workspace
  }
  const root = join(callbacks.runtimeRoot(), 'team-worktrees')
  mkdirSync(root, { recursive: true })
  const target = join(root, bundle.team.id)
  if (existsSync(target)) {
    const branch = spawnSync('git', ['branch', '--show-current'], { cwd: target, windowsHide: true, encoding: 'utf8' }).stdout.trim()
    const base = bundle.team.baseCommit || spawnSync('git', ['merge-base', 'HEAD', bundle.team.worktreeBranch || branch], { cwd: workspace, windowsHide: true, encoding: 'utf8' }).stdout.trim()
    callbacks.updateTeam(bundle.team.id, { worktreePath: target, worktreeBranch: branch, baseCommit: base })
    return target
  }
  const branch = `termflow/team-${bundle.team.id.slice(0, 10)}`
  const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, windowsHide: true, encoding: 'utf8' }).stdout.trim()
  const result = spawnSync('git', ['worktree', 'add', '-b', branch, target, 'HEAD'], { cwd: workspace, windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Could not create an isolated Git worktree: ${(result.stderr || '').trim()}. The team was not started.`)
  callbacks.event({ teamId: bundle.team.id, type: 'note', message: `Team is working in an isolated Git worktree: ${target}` })
  callbacks.updateTeam(bundle.team.id, { worktreePath: target, worktreeBranch: branch, baseCommit: base })
  return target
}

const ROLE_PROMPTS: Record<TeamMember['role'], string> = {
  lead: 'Act as the team lead: synthesize outcomes and enforce quality gates.', researcher: 'Inspect the code and report the root cause and an actionable plan with evidence.', developer: 'Implement the assigned solution. Stay within scope and run the relevant validation.', tester: 'Test the change independently and report concrete evidence.', reviewer: 'Review the changes for correctness, security, and regressions.'
}

export class TeamRuntime {
  private processes = new Map<string, ChildProcessWithoutNullStreams>()
  private teamCwds = new Map<string, string>()
  private terminating = new Map<string, 'paused' | 'cancelled'>()
  constructor(private callbacks: RuntimeCallbacks) {}

  dispose(): void {
    for (const proc of this.processes.values()) proc.kill()
    this.processes.clear()
  }

  start(teamId: string): void {
    const bundle = this.callbacks.getTeam(teamId)
    if (!bundle) throw new Error('Team not found')
    // Idempotent: if the team is already running with at least one live process
    // for one of its tasks, a second start() is a no-op (no duplicate spawns).
    if (bundle.team.status === 'running' && bundle.tasks.some((task) => this.processes.has(task.id))) return
    const workspace = this.callbacks.workspacePath(bundle.team.workspaceId)
    if (!workspace) throw new Error('Workspace folder not found')
    this.teamCwds.set(teamId, this.prepareWorktree(bundle, workspace))
    this.callbacks.updateTeam(teamId, { status: 'running' })
    this.schedule(teamId)
  }

  private prepareWorktree(bundle: AgentTeamBundle, workspace: string): string {
    // Isolate every policy in a git worktree so no agent can touch the main
    // workspace directly; `apply` then works uniformly across all policies.
    return prepareTeamWorktree(bundle, workspace, this.callbacks)
  }

  apply(teamId: string): { changed: boolean; message: string } {
    const bundle = this.callbacks.getTeam(teamId)
    if (!bundle) throw new Error('Team not found')
    if (bundle.team.status !== 'completed') throw new Error('Only a completed team result can be applied.')
    const workspace = this.callbacks.workspacePath(bundle.team.workspaceId)
    const worktree = bundle.team.worktreePath
    const base = bundle.team.baseCommit
    if (!workspace || !worktree || !base) throw new Error('This team did not use an isolated worktree.')
    const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: workspace, windowsHide: true, encoding: 'utf8' })
    if (dirty.status !== 0 || dirty.stdout.trim()) throw new Error('The main workspace has uncommitted changes. Save or commit them first.')
    spawnSync('git', ['add', '-N', '.'], { cwd: worktree, windowsHide: true, encoding: 'utf8' })
    const diff = spawnSync('git', ['diff', '--binary', base], { cwd: worktree, windowsHide: true, encoding: 'buffer', maxBuffer: 100 * 1024 * 1024 })
    if (diff.status !== 0) throw new Error('Could not prepare the team changes.')
    if (!diff.stdout.length) return { changed: false, message: 'No file changes were found to apply.' }
    const applied = spawnSync('git', ['apply', '--3way', '-'], { cwd: workspace, windowsHide: true, input: diff.stdout, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 })
    if (applied.status !== 0) throw new Error(`Could not apply changes because of a conflict: ${applied.stderr.trim()}`)
    const appliedAt = new Date().toISOString()
    this.callbacks.updateTeam(teamId, { appliedAt })
    this.callbacks.event({ teamId, type: 'note', message: 'The team changes were applied to the main workspace.' })
    return { changed: true, message: 'Team changes were applied to the main workspace.' }
  }

  stop(teamId: string): void {
    for (const [taskId, proc] of this.processes) {
      const task = this.callbacks.getTeam(teamId)?.tasks.find((item) => item.id === taskId)
      if (!task) continue
      this.terminating.set(taskId, 'cancelled')
      proc.kill()
      this.processes.delete(taskId)
      this.callbacks.updateTask(taskId, { status: 'cancelled', result: 'Stopped by the user.' })
    }
    this.callbacks.updateTeam(teamId, { status: 'cancelled' })
  }

  pause(teamId: string): void {
    const bundle = this.callbacks.getTeam(teamId)
    if (!bundle || bundle.team.status !== 'running') return
    for (const [taskId, proc] of this.processes) {
      const task = bundle.tasks.find((item) => item.id === taskId)
      if (!task) continue
      this.terminating.set(taskId, 'paused')
      proc.kill()
      this.processes.delete(taskId)
      this.callbacks.updateTask(taskId, { status: 'ready', result: 'Task paused; it will restart when the team resumes.' })
      if (task.assigneeId) this.callbacks.updateMember(task.assigneeId, { status: 'idle' })
    }
    this.callbacks.updateTeam(teamId, { status: 'paused' })
    this.callbacks.event({ teamId, type: 'note', message: 'The team and its active tasks were paused.' })
  }

  private schedule(teamId: string): void {
    const bundle = this.callbacks.getTeam(teamId)
    if (!bundle || bundle.team.status !== 'running') return
    const completed = new Set(bundle.tasks.filter((task) => task.status === 'completed').map((task) => task.id))
    const ready = bundle.tasks.filter((task) => task.status === 'ready' && task.dependencies.every((id) => completed.has(id)))
    for (const task of ready) {
      if (bundle.team.permissionPolicy === 'controlled' && ['Implement the solution', 'Çözümü uygula'].includes(task.title) && !task.approved) {
        this.callbacks.updateTask(task.id, { status: 'approval', result: 'User approval is required before changing code.' })
        this.callbacks.event({ teamId, taskId: task.id, type: 'note', message: 'The implementation plan is ready. Waiting for approval to change code.' })
        continue
      }
      this.runTask(bundle, task)
    }
    if (ready.length) return
    // A task waiting on approval is still active work — don't finalize the team
    // while one is pending, or an approval-gated run finishes prematurely.
    const pendingActive = bundle.tasks.some((task) => task.status === 'working' || task.status === 'approval')
    if (!pendingActive) {
      const failed = bundle.tasks.some((task) => task.status === 'failed' || task.status === 'blocked')
      this.callbacks.updateTeam(teamId, { status: failed ? 'failed' : 'completed' })
    }
  }

  private runTask(bundle: AgentTeamBundle, task: TeamTask): void {
    // Idempotent guard: never spawn a second process for a task already running.
    if (this.processes.has(task.id)) return
    const member = bundle.members.find((item) => item.id === task.assigneeId) ?? bundle.members[0]
    const cwd = this.teamCwds.get(bundle.team.id) ?? this.callbacks.workspacePath(bundle.team.workspaceId)
    if (!member || !cwd) { this.callbacks.updateTask(task.id, { status: 'failed', result: 'Team member or workspace folder not found.' }); return }
    const context = task.dependencies.map((id) => bundle.tasks.find((item) => item.id === id)?.result).filter(Boolean).join('\n')
    const prompt = `${ROLE_PROMPTS[member.role]}\n\nTeam objective: ${bundle.team.objective}\n\nTask: ${task.title}\n${task.description}\n\nAcceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}\n${context ? `\nPrevious task results:\n${context}` : ''}`
    const adapter = ADAPTERS[member.provider]
    const effectivePolicy = task.approved && bundle.team.permissionPolicy === 'controlled' ? 'balanced' : bundle.team.permissionPolicy
    const spec = adapter.build(prompt, effectivePolicy)
    const proc = spawn(spec.command, spec.args, { cwd, windowsHide: true, env: providerEnv(member.provider) })
    this.processes.set(task.id, proc)
    this.callbacks.updateTask(task.id, { status: 'working' })
    this.callbacks.updateMember(member.id, { status: 'working' })
    this.callbacks.event({ teamId: bundle.team.id, memberId: member.id, taskId: task.id, type: 'member.started', message: `${member.name} started: ${task.title}.` })
    let output = ''
    let pending = ''
    const consume = (chunk: Buffer): void => { pending += chunk.toString('utf8'); const lines = pending.split(/\r?\n/); pending = lines.pop() || ''; for (const line of lines) { const event = adapter.parse(line); if (!event) continue; output = `${output}\n${event.message}`.slice(-12000); if (event.sessionId) this.callbacks.updateMember(member.id, { sessionId: event.sessionId }); this.callbacks.event({ teamId: bundle.team.id, memberId: member.id, taskId: task.id, type: 'note', message: event.message.slice(0, 500) }) } }
    proc.stdout.on('data', consume)
    proc.stderr.on('data', (chunk: Buffer) => { output = `${output}\n${chunk.toString('utf8')}`.slice(-12000) })
    proc.on('error', (error) => { output = error.message })
    proc.on('close', (code) => {
      this.processes.delete(task.id)
      const termination = this.terminating.get(task.id)
      this.terminating.delete(task.id)
      if (termination) return
      const ok = code === 0
      this.callbacks.updateTask(task.id, { status: ok ? 'completed' : 'failed', result: output.trim() || (ok ? 'Task completed.' : `Process exited with code ${code}.`) })
      this.callbacks.updateMember(member.id, { status: ok ? 'completed' : 'failed' })
      this.callbacks.event({ teamId: bundle.team.id, memberId: member.id, taskId: task.id, type: 'task.updated', message: `${task.title}: ${ok ? 'completed' : 'failed'}` })
      this.schedule(bundle.team.id)
    })
  }
}

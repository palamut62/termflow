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

export const ADAPTERS: Record<TeamMember['provider'], RuntimeAdapter> = {
  claude: {
    id: 'claude', label: 'Claude Code', structured: true,
    build: (prompt, policy) => ({ command: 'claude', args: ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', policy === 'review' ? 'plan' : policy === 'balanced' ? 'acceptEdits' : policy === 'full' ? 'bypassPermissions' : 'default'] }),
    parse: (line) => { const value = jsonLine(line); if (!value) return null; const type = String(value.type || ''); const sessionId = typeof value.session_id === 'string' ? value.session_id : undefined; if (type === 'result') return { type: 'result', message: String(value.result || 'Görev tamamlandı.'), sessionId }; if (type === 'assistant') return { type: 'message', message: JSON.stringify(value.message || '').slice(0, 1000), sessionId }; return null }
  },
  codex: {
    id: 'codex', label: 'Codex', structured: true,
    build: (prompt, policy) => ({ command: 'powershell.exe', args: ['-NoProfile', '-File', `${process.env.APPDATA}\\npm\\codex.ps1`, 'exec', '--json', ...(policy === 'full' ? ['--dangerously-bypass-approvals-and-sandbox'] : []), prompt] }),
    parse: (line) => { const value = jsonLine(line); if (!value) return null; const item = value.item as Record<string, unknown> | undefined; const message = String(item?.text || value.message || ''); return message ? { type: String(value.type).includes('completed') ? 'result' : 'message', message: message.slice(0, 1000) } : null }
  },
  opencode: {
    id: 'opencode', label: 'OpenCode', structured: true,
    build: (prompt) => ({ command: 'powershell.exe', args: ['-NoProfile', '-File', `${process.env.APPDATA}\\npm\\opencode.ps1`, 'run', '--format', 'json', prompt] }),
    parse: (line) => { const value = jsonLine(line); if (!value) return null; const message = String(value.text || value.message || ''); return message ? { type: 'message', message: message.slice(0, 1000) } : null }
  },
  generic: {
    id: 'generic', label: 'Generic CLI', structured: false,
    build: (prompt) => ({ command: 'claude', args: ['-p', prompt] }),
    parse: (line) => line.trim() ? { type: 'message', message: line.trim().slice(0, 1000) } : null
  }
}

interface RuntimeCallbacks {
  getTeam(id: string): AgentTeamBundle | undefined
  workspacePath(workspaceId: string): string | undefined
  runtimeRoot(): string
  updateTeam(id: string, status: 'running' | 'completed' | 'failed' | 'cancelled'): void
  updateMember(id: string, patch: Partial<Pick<TeamMember, 'status' | 'sessionId'>>): void
  updateTask(id: string, patch: Partial<Pick<TeamTask, 'status' | 'result'>>): void
  event(input: { teamId: string; memberId?: string; taskId?: string; type: 'member.started' | 'task.updated' | 'note'; message: string }): void
}

const ROLE_PROMPTS: Record<TeamMember['role'], string> = {
  lead: 'Takım lideri olarak sonuçları sentezle ve kalite kapılarını denetle.', researcher: 'Kodu incele, kök nedeni ve uygulanabilir planı kanıtlarla bildir.', developer: 'Atanan çözümü uygula. Kapsam dışına çıkma ve ilgili doğrulamayı çalıştır.', tester: 'Değişikliği bağımsız test et ve somut test kanıtı bildir.', reviewer: 'Değişiklikleri doğruluk, güvenlik ve regresyon açısından incele.'
}

export class TeamRuntime {
  private processes = new Map<string, ChildProcessWithoutNullStreams>()
  private teamCwds = new Map<string, string>()
  constructor(private callbacks: RuntimeCallbacks) {}

  dispose(): void {
    for (const proc of this.processes.values()) proc.kill()
    this.processes.clear()
  }

  start(teamId: string): void {
    const bundle = this.callbacks.getTeam(teamId)
    if (!bundle) throw new Error('Takım bulunamadı')
    const workspace = this.callbacks.workspacePath(bundle.team.workspaceId)
    if (!workspace) throw new Error('Çalışma klasörü bulunamadı')
    this.teamCwds.set(teamId, this.prepareWorktree(bundle, workspace))
    this.callbacks.updateTeam(teamId, 'running')
    this.schedule(teamId)
  }

  private prepareWorktree(bundle: AgentTeamBundle, workspace: string): string {
    if (bundle.team.permissionPolicy === 'review') return workspace
    const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: workspace, windowsHide: true, encoding: 'utf8' })
    if (probe.status !== 0) return workspace
    const root = join(this.callbacks.runtimeRoot(), 'team-worktrees')
    mkdirSync(root, { recursive: true })
    const target = join(root, bundle.team.id)
    if (existsSync(target)) return target
    const branch = `termflow/team-${bundle.team.id.slice(0, 10)}`
    const result = spawnSync('git', ['worktree', 'add', '-b', branch, target, 'HEAD'], { cwd: workspace, windowsHide: true, encoding: 'utf8' })
    if (result.status !== 0) {
      this.callbacks.event({ teamId: bundle.team.id, type: 'note', message: 'İzole worktree oluşturulamadı; takım ana çalışma klasöründe devam ediyor.' })
      return workspace
    }
    this.callbacks.event({ teamId: bundle.team.id, type: 'note', message: `Takım izole Git worktree üzerinde çalışıyor: ${target}` })
    return target
  }

  stop(teamId: string): void {
    for (const [taskId, proc] of this.processes) {
      const task = this.callbacks.getTeam(teamId)?.tasks.find((item) => item.id === taskId)
      if (!task) continue
      proc.kill()
      this.processes.delete(taskId)
      this.callbacks.updateTask(taskId, { status: 'cancelled', result: 'Kullanıcı tarafından durduruldu.' })
    }
    this.callbacks.updateTeam(teamId, 'cancelled')
  }

  private schedule(teamId: string): void {
    const bundle = this.callbacks.getTeam(teamId)
    if (!bundle || bundle.team.status !== 'running') return
    const completed = new Set(bundle.tasks.filter((task) => task.status === 'completed').map((task) => task.id))
    const ready = bundle.tasks.filter((task) => task.status === 'ready' && task.dependencies.every((id) => completed.has(id)))
    for (const task of ready) {
      if (bundle.team.permissionPolicy === 'controlled' && task.title === 'Çözümü uygula' && !task.approved) {
        this.callbacks.updateTask(task.id, { status: 'approval', result: 'Kod değişikliğine başlamadan önce kullanıcı onayı gerekiyor.' })
        this.callbacks.event({ teamId, taskId: task.id, type: 'note', message: 'Uygulama planı hazır. Kod değişikliği için kullanıcı onayı bekleniyor.' })
        continue
      }
      this.runTask(bundle, task)
    }
    if (ready.length) return
    if (!ready.length && !bundle.tasks.some((task) => task.status === 'working')) {
      const failed = bundle.tasks.some((task) => task.status === 'failed' || task.status === 'blocked')
      this.callbacks.updateTeam(teamId, failed ? 'failed' : 'completed')
    }
  }

  private runTask(bundle: AgentTeamBundle, task: TeamTask): void {
    const member = bundle.members.find((item) => item.id === task.assigneeId) ?? bundle.members[0]
    const cwd = this.teamCwds.get(bundle.team.id) ?? this.callbacks.workspacePath(bundle.team.workspaceId)
    if (!member || !cwd) { this.callbacks.updateTask(task.id, { status: 'failed', result: 'Üye veya çalışma klasörü bulunamadı.' }); return }
    const context = task.dependencies.map((id) => bundle.tasks.find((item) => item.id === id)?.result).filter(Boolean).join('\n')
    const prompt = `${ROLE_PROMPTS[member.role]}\n\nTakım hedefi: ${bundle.team.objective}\n\nGörev: ${task.title}\n${task.description}\n\nKabul kriterleri:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}\n${context ? `\nÖnceki görev sonuçları:\n${context}` : ''}`
    const adapter = ADAPTERS[member.provider]
    const effectivePolicy = task.approved && bundle.team.permissionPolicy === 'controlled' ? 'balanced' : bundle.team.permissionPolicy
    const spec = adapter.build(prompt, effectivePolicy)
    const proc = spawn(spec.command, spec.args, { cwd, windowsHide: true, env: process.env })
    this.processes.set(task.id, proc)
    this.callbacks.updateTask(task.id, { status: 'working' })
    this.callbacks.updateMember(member.id, { status: 'working' })
    this.callbacks.event({ teamId: bundle.team.id, memberId: member.id, taskId: task.id, type: 'member.started', message: `${member.name}, ${task.title} görevine başladı.` })
    let output = ''
    let pending = ''
    const consume = (chunk: Buffer): void => { pending += chunk.toString('utf8'); const lines = pending.split(/\r?\n/); pending = lines.pop() || ''; for (const line of lines) { const event = adapter.parse(line); if (!event) continue; output = `${output}\n${event.message}`.slice(-12000); if (event.sessionId) this.callbacks.updateMember(member.id, { sessionId: event.sessionId }); this.callbacks.event({ teamId: bundle.team.id, memberId: member.id, taskId: task.id, type: 'note', message: event.message.slice(0, 500) }) } }
    proc.stdout.on('data', consume)
    proc.stderr.on('data', (chunk: Buffer) => { output = `${output}\n${chunk.toString('utf8')}`.slice(-12000) })
    proc.on('error', (error) => { output = error.message })
    proc.on('close', (code) => {
      this.processes.delete(task.id)
      const ok = code === 0
      this.callbacks.updateTask(task.id, { status: ok ? 'completed' : 'failed', result: output.trim() || (ok ? 'Görev tamamlandı.' : `Süreç ${code} koduyla kapandı.`) })
      this.callbacks.updateMember(member.id, { status: ok ? 'completed' : 'failed' })
      this.callbacks.event({ teamId: bundle.team.id, memberId: member.id, taskId: task.id, type: 'task.updated', message: `${task.title}: ${ok ? 'tamamlandı' : 'başarısız'}` })
      this.schedule(bundle.team.id)
    })
  }
}

import { useEffect, useMemo, useState } from 'react'
import { Bot, CheckCircle2, Circle, Layers3, Pause, Play, Plus, Square, Trash2, Users, X } from 'lucide-react'
import type { AgentTeamBundle, TeamMember, TeamPermissionPolicy, TeamTaskStatus } from '../../../shared/types'
import { AGENT_TEAM_TEMPLATES } from '../../../shared/agentTeamTemplates'
import { useAppStore } from '../store/appStore'
import { useModalClose } from '../hooks/useModalClose'
import ConfirmModal from './ConfirmModal'

const POLICY_LABELS: Record<TeamPermissionPolicy, string> = {
  review: 'Review only', controlled: 'Ask before changes', balanced: 'Apply safe changes', full: 'Full access'
}

const STATUS_LABELS: Record<TeamTaskStatus, string> = {
  ready: 'Ready', working: 'Working', approval: 'Awaiting approval', blocked: 'Blocked', review: 'In review', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled'
}

const BUILTIN_TOOLS = [
  { id: 'builtin:claude', name: 'Claude Code', provider: 'claude' },
  { id: 'builtin:codex', name: 'Codex', provider: 'codex' },
  { id: 'builtin:opencode', name: 'OpenCode', provider: 'opencode' }
] as const

function providerForCommand(command: string): TeamMember['provider'] {
  const executable = command.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  if (executable.includes('codex')) return 'codex'
  if (executable.includes('opencode')) return 'opencode'
  if (executable.includes('claude')) return 'claude'
  return 'generic'
}

export default function AgentTeamsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const workspaceId = useAppStore((s) => s.activeWorkspaceId)
  const syncTeamCanvas = useAppStore((s) => s.syncTeamCanvas)
  const clearTeamCanvas = useAppStore((s) => s.clearTeamCanvas)
  const providerProfiles = useAppStore((s) => s.settings.providerProfiles)
  const customAgents = useAppStore((s) => s.settings.customAgents)
  const [teams, setTeams] = useState<AgentTeamBundle[]>([])
  const [pendingDelete, setPendingDelete] = useState<AgentTeamBundle | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [objective, setObjective] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [permissionPolicy, setPermissionPolicy] = useState<TeamPermissionPolicy>('controlled')
  const [teamSize, setTeamSize] = useState<3 | 4 | 5>(4)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  useModalClose(onClose)

  const selected = useMemo(() => teams.find((item) => item.team.id === selectedId) ?? teams[0], [teams, selectedId])
  const selectedTemplate = useMemo(() => AGENT_TEAM_TEMPLATES.find((item) => item.id === templateId), [templateId])
  const toolOptions = useMemo(() => [
    ...BUILTIN_TOOLS,
    ...providerProfiles.map((profile) => ({ id: `provider:${profile.id}`, name: `${profile.name} - ${profile.command || 'not configured'}`, provider: providerForCommand(profile.command) })),
    ...customAgents.map((agent) => ({ id: `custom:${agent.id}`, name: agent.name, provider: providerForCommand(agent.command) }))
  ], [providerProfiles, customAgents])
  const toolLabel = (member: TeamMember): string => toolOptions.find((item) => item.id === (member.executionProfileId ?? `builtin:${member.provider}`))?.name ?? member.provider
  const reload = async (preferId?: string): Promise<void> => {
    if (!workspaceId) return
    const items = await window.termflow.teams.list(workspaceId)
    setTeams(items)
    if (preferId) setSelectedId(preferId)
    else if (!selectedId && items[0]) setSelectedId(items[0].team.id)
  }

  useEffect(() => { void reload() }, [workspaceId])
  useEffect(() => {
    if (!selected || !['running', 'paused'].includes(selected.team.status)) return
    const timer = setInterval(() => { void reload(selected.team.id) }, 1000)
    return () => clearInterval(timer)
  }, [selected?.team.id, selected?.team.status])

  const createTeam = async (): Promise<void> => {
    if (!workspaceId || !objective.trim()) return
    setBusy(true)
    setError(null)
    try {
      const bundle = await window.termflow.teams.create({ workspaceId, objective, permissionPolicy, teamSize, templateId })
      setObjective('')
      setTemplateId('')
      setCreating(false)
      await reload(bundle.team.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the team')
    } finally {
      setBusy(false)
    }
  }

  const startTeam = async (bundle: AgentTeamBundle): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.termflow.teams.start(bundle.team.id)
      await reload(bundle.team.id)
      // Seed the canvas immediately and spread the member nodes for readability.
      const fresh = (await window.termflow.teams.list(bundle.team.workspaceId)).find((b) => b.team.id === bundle.team.id)
      if (fresh) syncTeamCanvas(fresh)
      const store = useAppStore.getState()
      store.setLayoutMode('agent_graph', store.canvasSize)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the team')
    } finally {
      setBusy(false)
    }
  }

  const setTeamStatus = async (status: 'paused' | 'cancelled'): Promise<void> => {
    if (!selected) return
    if (status === 'cancelled') await window.termflow.teams.stop(selected.team.id)
    else await window.termflow.teams.update(selected.team.id, { status })
    await reload(selected.team.id)
  }

  const setTaskStatus = async (taskId: string, status: TeamTaskStatus): Promise<void> => {
    await window.termflow.teams.updateTask(taskId, { status })
    if (selected) await reload(selected.team.id)
  }

  const approveTask = async (taskId: string): Promise<void> => {
    if (!selected) return
    await window.termflow.teams.updateTask(taskId, { approved: true, status: 'ready' })
    await window.termflow.teams.start(selected.team.id)
    await reload(selected.team.id)
  }

  const requestDelete = (bundle: AgentTeamBundle, event: React.MouseEvent): void => {
    event.stopPropagation()
    if (bundle.team.status === 'running') return
    setPendingDelete(bundle)
  }

  const deleteTeam = async (bundle: AgentTeamBundle): Promise<void> => {
    setError(null)
    try {
      await window.termflow.teams.remove(bundle.team.id)
      clearTeamCanvas(bundle.team.id)
      if (selectedId === bundle.team.id) setSelectedId(null)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the team')
    }
  }

  const applyResult = async (): Promise<void> => {
    if (!selected) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.termflow.teams.apply(selected.team.id)
      setNotice(result.message)
      await reload(selected.team.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply the team result')
    } finally {
      setBusy(false)
    }
  }

  const chooseTemplate = (id: string): void => {
    const template = AGENT_TEAM_TEMPLATES.find((item) => item.id === id)
    if (!template) return
    setTemplateId(id)
    setPermissionPolicy(template.recommendedPolicy)
    setTeamSize(Math.min(5, Math.max(3, template.members.length)) as 3 | 4 | 5)
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="modal agent-teams" onMouseDown={(event) => event.stopPropagation()}>
        <header className="team-head">
          <div><h3><Users size={18} /> Agent Teams</h3><p>Describe your goal. TermFlow will prepare the roles, tasks, and real coding-agent sessions.</p></div>
          <button className="hbtn" title="Close" onClick={onClose}><X size={16} /></button>
        </header>
        {error && <div className="side-error" role="alert">{error}</div>}
        {notice && <div className="side-success" role="status">{notice}</div>}
        <div className="team-layout">
          <aside className="team-list">
            <button className="btn primary" disabled={!workspaceId} onClick={() => { setTemplateId(''); setObjective(''); setCreating(true) }}><Plus size={14} /> New agent team</button>
            {teams.map((item) => <div key={item.team.id} role="button" tabIndex={0} className={selected?.team.id === item.team.id ? 'active' : ''} onClick={() => { setSelectedId(item.team.id); setCreating(false) }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(item.team.id); setCreating(false) } }}><strong>{item.team.name}</strong><span>{item.members.length} members · {item.tasks.length} tasks</span><em>{item.team.status}</em><button className="team-del" title={item.team.status === 'running' ? 'Stop the team first' : 'Delete team'} disabled={item.team.status === 'running'} onClick={(event) => requestDelete(item, event)}><Trash2 size={12} /></button></div>)}
          </aside>
          <main className="team-main">
            {creating ? (
              <section className="team-wizard">
                {!selectedTemplate ? <>
                  <span className="team-kicker">Professional team templates</span><h2>Choose a specialist team</h2>
                  <p className="team-wizard-intro">Each template includes expert roles, provider assignments, specialist instructions, task dependencies, and quality gates.</p>
                  <div className="team-template-grid">
                    {AGENT_TEAM_TEMPLATES.map((template) => <button key={template.id} onClick={() => chooseTemplate(template.id)}><Layers3 size={15} /><strong>{template.name}</strong><span>{template.summary}</span><em>{template.members.length} specialists · {POLICY_LABELS[template.recommendedPolicy]}</em></button>)}
                  </div>
                  <div className="modal-actions"><button className="btn" onClick={() => setCreating(false)}>Cancel</button></div>
                </> : <>
                  <button className="team-template-back" onClick={() => setTemplateId('')}>← All templates</button>
                  <span className="team-kicker">Ready-to-run professional team</span><h2>{selectedTemplate.name}</h2>
                  <p className="team-wizard-intro">{selectedTemplate.summary}</p>
                  <div className="team-template-meta"><span>{selectedTemplate.members.length} specialist roles</span><span>{selectedTemplate.tasks.length} sequenced tasks</span><span>{POLICY_LABELS[selectedTemplate.recommendedPolicy]}</span></div>
                  <h3>Prepared specialists and instructions</h3>
                  <div className="team-template-members">{selectedTemplate.members.map((member) => <article key={member.role}><Bot size={15} /><div><strong>{member.name}</strong><span>{member.provider === 'claude' ? 'Claude Code' : member.provider === 'codex' ? 'Codex' : 'OpenCode'} · {member.role}</span><p>{member.instructions}</p></div></article>)}</div>
                  <h3>Prepared workflow</h3>
                  <div className="team-template-tasks">{selectedTemplate.tasks.map((task, index) => <article key={task.key}><em>{index + 1}</em><div><strong>{task.title}</strong><p>{task.description}</p><span>{task.acceptanceCriteria.length} quality gates</span></div></article>)}</div>
                  <h3>What should this team accomplish?</h3>
                  <textarea autoFocus value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Describe the exact outcome you want this professional team to deliver." />
                  <div className="modal-actions"><button className="btn" onClick={() => setTemplateId('')}>Back</button><button className="btn primary" disabled={busy || !objective.trim()} onClick={() => void createTeam()}>{busy ? 'Preparing professional team...' : 'Create prepared team'}</button></div>
                </>}
              </section>
            ) : selected ? (
              <>
                <section className="team-summary"><div><span className="team-kicker">{selected.team.templateId ? AGENT_TEAM_TEMPLATES.find((item) => item.id === selected.team.templateId)?.name : POLICY_LABELS[selected.team.permissionPolicy]}</span><h2>{selected.team.name}</h2><p>{selected.team.objective}</p></div><div className="team-actions">{selected.team.status === 'draft' && <button className="btn primary" disabled={busy} onClick={() => void startTeam(selected)}><Play size={14} /> Start team</button>}{selected.team.status === 'paused' && <button className="btn primary" disabled={busy} onClick={() => void startTeam(selected)}><Play size={14} /> Resume</button>}{selected.team.status === 'failed' && <button className="btn primary" disabled={busy} onClick={() => void startTeam(selected)}><Play size={14} /> Retry failed tasks</button>}{selected.team.status === 'running' && <button className="btn" onClick={() => void setTeamStatus('paused')}><Pause size={14} /> Pause</button>}{selected.team.status === 'completed' && selected.team.worktreePath && !selected.team.appliedAt && <button className="btn primary" disabled={busy} onClick={() => void applyResult()}><CheckCircle2 size={14} /> Apply results</button>}{selected.team.appliedAt && <span className="team-applied"><CheckCircle2 size={14} /> Applied to project</span>}{['draft', 'running', 'paused'].includes(selected.team.status) && <button className="btn danger" onClick={() => void setTeamStatus('cancelled')}><Square size={13} /> Stop</button>}</div></section>
                <section className="team-runtime-overview"><div><span>Active agent</span><strong>{selected.members.find((member) => member.status === 'working')?.name ?? 'No agent running'}</strong></div><div><span>Current stage</span><strong>{selected.tasks.findIndex((task) => ['working', 'approval', 'review'].includes(task.status)) + 1 || selected.tasks.filter((task) => task.status === 'completed').length}/{selected.tasks.length}</strong></div><div><span>Progress</span><strong>{Math.round((selected.tasks.filter((task) => task.status === 'completed').length / Math.max(1, selected.tasks.length)) * 100)}%</strong></div></section>
                <section className="team-members">{selected.members.map((member) => <article key={member.id} title={member.instructions}><Bot size={16} /><div><strong>{member.name}</strong>{selected.team.status === 'draft' ? <select aria-label={`Tool for ${member.name}`} value={member.executionProfileId ?? `builtin:${member.provider}`} onChange={async (event) => { const option = toolOptions.find((item) => item.id === event.target.value); if (!option) return; await window.termflow.teams.updateMember(member.id, { provider: option.provider, executionProfileId: option.id.startsWith('builtin:') ? undefined : option.id }); await reload(selected.team.id) }}>{toolOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select> : <span>{toolLabel(member)}</span>}{member.instructions && <p>{member.instructions}</p>}</div><em className={`team-status ${member.status}`}>{member.status}</em></article>)}</section>
                <section className="team-tasks"><header><h4>Tasks</h4><span>{selected.tasks.filter((task) => task.status === 'completed').length}/{selected.tasks.length} completed</span></header>{selected.tasks.map((task) => { const member = selected.members.find((item) => item.id === task.assigneeId); const lockTask = task.status === 'working' || selected.team.status === 'running'; return <article key={task.id}><button className="task-check" disabled={lockTask} title={lockTask ? 'Cannot change task status while the team is running' : 'Change status'} onClick={() => void setTaskStatus(task.id, task.status === 'completed' ? 'ready' : 'completed')}>{task.status === 'completed' ? <CheckCircle2 size={18} /> : <Circle size={18} />}</button><div><strong>{task.title}</strong><p>{task.description}</p><span>{member?.name ?? 'Unassigned'} · {STATUS_LABELS[task.status]}</span>{task.status === 'approval' && <button className="btn primary" onClick={() => void approveTask(task.id)}>Approve plan and apply</button>}</div></article> })}</section>
                <section className="team-events"><header><h4>Live activity</h4><span>{selected.events.length} events</span></header>{selected.events.slice(-30).reverse().map((event) => <article key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString()}</time><p>{event.message}</p></article>)}</section>
              </>
            ) : <div className="team-empty"><Users size={38} /><strong>Create your first agent team</strong><span>No technical setup required. Just describe your goal in plain language.</span></div>}
          </main>
        </div>
      </div>
      {pendingDelete && (
        <ConfirmModal
          title="Delete agent team?"
          message={`${pendingDelete.team.name} and its tasks, members, and isolated worktree will be removed.`}
          confirmLabel="Delete team"
          tone="danger"
          onConfirm={() => void deleteTeam(pendingDelete)}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { Bot, CheckCircle2, Circle, Copy, Layers3, LayoutTemplate, Pause, Play, Plus, Sparkles, Square, Trash2, Users, X } from 'lucide-react'
import type { AgentTeamBundle, AgentTeamTemplate, TeamMember, TeamPermissionPolicy, TeamTaskStatus } from '../../../shared/types'
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

function blankTemplate(): AgentTeamTemplate {
  const ts = new Date().toISOString()
  return { id: '', name: '', description: '', permissionPolicy: 'controlled', members: [{ name: '', role: '', instructions: '' }], tasks: [], createdAt: ts, updatedAt: ts }
}

export default function AgentTeamsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const workspaceId = useAppStore((s) => s.activeWorkspaceId)
  const syncTeamCanvas = useAppStore((s) => s.syncTeamCanvas)
  const clearTeamCanvas = useAppStore((s) => s.clearTeamCanvas)
  const providerProfiles = useAppStore((s) => s.settings.providerProfiles)
  const customAgents = useAppStore((s) => s.settings.customAgents)
  const aiProvider = useAppStore((s) => s.settings.aiProvider)
  const [teams, setTeams] = useState<AgentTeamBundle[]>([])
  const [templates, setTemplates] = useState<AgentTeamTemplate[]>([])
  const [pendingDelete, setPendingDelete] = useState<AgentTeamBundle | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<'teams' | 'templates'>('teams')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<AgentTeamTemplate | null>(null)
  const [objective, setObjective] = useState('')
  const [templateId, setTemplateId] = useState('')
  // A custom/AI template selected to build a team from (bypasses the built-in wizard).
  const [pendingTemplate, setPendingTemplate] = useState<AgentTeamTemplate | null>(null)
  const [permissionPolicy, setPermissionPolicy] = useState<TeamPermissionPolicy>('controlled')
  const [teamSize, setTeamSize] = useState<3 | 4 | 5>(4)
  const [busy, setBusy] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
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
  const reloadTemplates = async (): Promise<void> => {
    try { setTemplates(await window.termflow.teamTemplates.list()) } catch { /* ignore */ }
  }

  useEffect(() => { void reload() }, [workspaceId])
  useEffect(() => { void reloadTemplates() }, [])
  useEffect(() => {
    const off = window.termflow.teams.onEvent(({ bundle }) => {
      if (bundle.team.workspaceId !== workspaceId) return
      setTeams((current) => {
        const index = current.findIndex((item) => item.team.id === bundle.team.id)
        if (index < 0) return [bundle, ...current]
        const next = [...current]
        next[index] = bundle
        return next
      })
    })
    return () => off()
  }, [workspaceId])

  const createTeam = async (): Promise<void> => {
    if (!workspaceId || !objective.trim()) return
    setBusy(true)
    setError(null)
    try {
      const bundle = await window.termflow.teams.create(
        pendingTemplate
          ? { workspaceId, objective, permissionPolicy, teamSize, template: pendingTemplate }
          : { workspaceId, objective, permissionPolicy, teamSize, templateId }
      )
      setObjective('')
      setTemplateId('')
      setPendingTemplate(null)
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

  // ---- Custom / AI templates ----
  const openWizardWithTemplate = (tpl: AgentTeamTemplate): void => {
    setPendingTemplate(tpl)
    setTemplateId('')
    setPermissionPolicy(tpl.permissionPolicy)
    setObjective('')
    setView('teams')
    setCreating(true)
    setEditing(null)
  }

  const saveTemplate = async (): Promise<void> => {
    if (!editing || !editing.name.trim()) { setError('Template name cannot be empty'); return }
    setBusy(true)
    setError(null)
    try {
      await window.termflow.teamTemplates.save(editing)
      await reloadTemplates()
      setEditing(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the template')
    } finally {
      setBusy(false)
    }
  }

  const deleteTemplate = async (id: string): Promise<void> => {
    await window.termflow.teamTemplates.delete(id)
    await reloadTemplates()
  }

  const runAiGenerate = async (): Promise<void> => {
    if (!objective.trim()) return
    if (aiProvider === 'none') {
      setError('No AI provider configured. Choose a provider and model under Settings → AI Provider.')
      return
    }
    setAiBusy(true)
    setError(null)
    try {
      const tpl = await window.termflow.ai.generateTeam(objective.trim(), teamSize)
      setPendingTemplate(null)
      setCreating(false)
      setView('templates')
      setEditing(tpl)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate the AI team')
    } finally {
      setAiBusy(false)
    }
  }

  // ---- Template editor field helpers ----
  const patchEditing = (patch: Partial<AgentTeamTemplate>): void => setEditing((prev) => (prev ? { ...prev, ...patch } : prev))
  const patchMember = (idx: number, patch: Partial<AgentTeamTemplate['members'][number]>): void =>
    setEditing((prev) => (prev ? { ...prev, members: prev.members.map((m, i) => (i === idx ? { ...m, ...patch } : m)) } : prev))
  const patchTask = (idx: number, patch: Partial<AgentTeamTemplate['tasks'][number]>): void =>
    setEditing((prev) => (prev ? { ...prev, tasks: prev.tasks.map((t, i) => (i === idx ? { ...t, ...patch } : t)) } : prev))

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
            <div className="team-tabs">
              <button className={view === 'teams' ? 'active' : ''} onClick={() => { setView('teams'); setEditing(null) }}><Users size={13} /> Teams</button>
              <button className={view === 'templates' ? 'active' : ''} onClick={() => { setView('templates'); setCreating(false) }}><LayoutTemplate size={13} /> Templates</button>
            </div>
            {view === 'teams' ? (
              <>
                <button className="btn primary" disabled={!workspaceId} onClick={() => { setTemplateId(''); setObjective(''); setPendingTemplate(null); setCreating(true) }}><Plus size={14} /> New agent team</button>
                {teams.map((item) => <div key={item.team.id} role="button" tabIndex={0} className={selected?.team.id === item.team.id ? 'active' : ''} onClick={() => { setSelectedId(item.team.id); setCreating(false) }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(item.team.id); setCreating(false) } }}><strong>{item.team.name}</strong><span>{item.members.length} members · {item.tasks.length} tasks</span><em>{item.team.status}</em><button className="team-del" title={item.team.status === 'running' ? 'Stop the team first' : 'Delete team'} disabled={item.team.status === 'running'} onClick={(event) => requestDelete(item, event)}><Trash2 size={12} /></button></div>)}
              </>
            ) : (
              <>
                <button className="btn primary" onClick={() => setEditing(blankTemplate())}><Plus size={14} /> New template</button>
                {templates.map((tpl) => (
                  <button key={tpl.id} className={editing?.id === tpl.id ? 'active' : ''} onClick={() => setEditing(tpl)}>
                    <strong>{tpl.name}{tpl.builtin ? ' ·' : ''}</strong>
                    <span>{tpl.members.length} members · {tpl.tasks.length} tasks{tpl.builtin ? ' · built-in' : ''}</span>
                  </button>
                ))}
                {templates.length === 0 && <span style={{ padding: 8, color: 'var(--text-muted)', fontSize: 10 }}>No templates yet.</span>}
              </>
            )}
          </aside>
          <main className="team-main">
            {view === 'templates' && editing ? (
              <TemplateEditor
                template={editing}
                busy={busy}
                onChange={patchEditing}
                onMemberChange={patchMember}
                onAddMember={() => patchEditing({ members: [...editing.members, { name: '', role: '', instructions: '' }] })}
                onRemoveMember={(i) => patchEditing({ members: editing.members.filter((_, idx) => idx !== i) })}
                onTaskChange={patchTask}
                onAddTask={() => patchEditing({ tasks: [...editing.tasks, { title: '', description: '', assigneeIndex: 0, acceptanceCriteria: [] }] })}
                onRemoveTask={(i) => patchEditing({ tasks: editing.tasks.filter((_, idx) => idx !== i) })}
                onSave={() => void saveTemplate()}
                onCancel={() => setEditing(null)}
                onBuild={() => openWizardWithTemplate(editing)}
                onCopy={() => setEditing({ ...editing, id: '', builtin: false, name: `${editing.name} (Copy)` })}
                onDelete={editing.id ? () => { void deleteTemplate(editing.id); setEditing(null) } : undefined}
              />
            ) : view === 'templates' ? (
              <div className="team-empty"><LayoutTemplate size={38} /><strong>Team templates</strong><span>Select a template or create a new one. Build a team from a template with one click.</span></div>
            ) : creating ? (
              pendingTemplate ? (
                <section className="team-wizard">
                  <span className="team-kicker">New team from template</span><h2>What should this team accomplish?</h2>
                  <div className="team-tpl-banner"><LayoutTemplate size={13} /> Template: <strong>{pendingTemplate.name}</strong><button className="hbtn" title="Remove template" onClick={() => setPendingTemplate(null)}><X size={12} /></button></div>
                  <textarea autoFocus value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Describe the exact outcome you want this team to deliver." />
                  <div className="team-options">
                    <label>Permission level<select value={permissionPolicy} onChange={(event) => setPermissionPolicy(event.target.value as TeamPermissionPolicy)}>{Object.entries(POLICY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                    <label>Team size<select value={teamSize} onChange={(event) => setTeamSize(Number(event.target.value) as 3 | 4 | 5)}><option value={3}>3 members</option><option value={4}>4 members (recommended)</option><option value={5}>5 members</option></select></label>
                  </div>
                  <div className="modal-actions">
                    <button className="btn" onClick={() => { setCreating(false); setPendingTemplate(null) }}>Cancel</button>
                    <button className="btn primary" disabled={busy || !objective.trim()} onClick={() => void createTeam()}>{busy ? 'Preparing team...' : 'Create prepared team'}</button>
                  </div>
                </section>
              ) : (
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
                    <div className="modal-actions"><button className="btn" onClick={() => setTemplateId('')}>Back</button><button className="btn" disabled={aiBusy || !objective.trim()} onClick={() => void runAiGenerate()}><Sparkles size={13} /> {aiBusy ? 'Generating...' : 'Generate with AI'}</button><button className="btn primary" disabled={busy || !objective.trim()} onClick={() => void createTeam()}>{busy ? 'Preparing professional team...' : 'Create prepared team'}</button></div>
                  </>}
                </section>
              )
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

interface EditorProps {
  template: AgentTeamTemplate
  busy: boolean
  onChange: (patch: Partial<AgentTeamTemplate>) => void
  onMemberChange: (idx: number, patch: Partial<AgentTeamTemplate['members'][number]>) => void
  onAddMember: () => void
  onRemoveMember: (idx: number) => void
  onTaskChange: (idx: number, patch: Partial<AgentTeamTemplate['tasks'][number]>) => void
  onAddTask: () => void
  onRemoveTask: (idx: number) => void
  onSave: () => void
  onCancel: () => void
  onBuild: () => void
  onCopy: () => void
  onDelete?: () => void
}

function TemplateEditor(props: EditorProps): React.JSX.Element {
  const { template: t } = props
  return (
    <section className="team-tpl-editor">
      <header className="team-tpl-head">
        <div><span className="team-kicker">{t.builtin ? 'Built-in template (saved as a copy)' : t.id ? 'Edit template' : 'New template'}</span><h2>{t.name || 'Untitled template'}</h2></div>
        <div className="team-actions">
          <button className="btn" onClick={props.onBuild}><Play size={13} /> Build team</button>
          <button className="btn" onClick={props.onCopy}><Copy size={13} /> Copy</button>
          {props.onDelete && !t.builtin && <button className="btn danger" onClick={props.onDelete}><Trash2 size={13} /> Delete</button>}
        </div>
      </header>
      <div className="team-tpl-body">
        <label className="team-tpl-field">Name<input value={t.name} onChange={(e) => props.onChange({ name: e.target.value })} placeholder="e.g. Full-Stack Development Team" /></label>
        <label className="team-tpl-field">Description<input value={t.description} onChange={(e) => props.onChange({ description: e.target.value })} placeholder="What this team is for" /></label>
        <label className="team-tpl-field">Permission level<select value={t.permissionPolicy} onChange={(e) => props.onChange({ permissionPolicy: e.target.value as TeamPermissionPolicy })}>{Object.entries(POLICY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>

        <div className="team-tpl-section">
          <div className="team-tpl-section-head"><h4>Members ({t.members.length})</h4><button className="btn" onClick={props.onAddMember}><Plus size={12} /> Add member</button></div>
          {t.members.map((m, i) => (
            <div key={i} className="team-tpl-member">
              <div className="team-tpl-row2">
                <input value={m.name} onChange={(e) => props.onMemberChange(i, { name: e.target.value })} placeholder="Member name" />
                <input value={m.role} onChange={(e) => props.onMemberChange(i, { role: e.target.value })} placeholder="Role (e.g. developer)" />
                <button className="hbtn danger" title="Remove member" disabled={t.members.length <= 1} onClick={() => props.onRemoveMember(i)}><X size={13} /></button>
              </div>
              <textarea value={m.instructions} onChange={(e) => props.onMemberChange(i, { instructions: e.target.value })} placeholder="Full system instruction for this agent (responsibility, method, quality gates)..." />
            </div>
          ))}
        </div>

        <div className="team-tpl-section">
          <div className="team-tpl-section-head"><h4>Tasks ({t.tasks.length})</h4><button className="btn" onClick={props.onAddTask}><Plus size={12} /> Add task</button></div>
          {t.tasks.map((task, i) => (
            <div key={i} className="team-tpl-member">
              <div className="team-tpl-row2">
                <input value={task.title} onChange={(e) => props.onTaskChange(i, { title: e.target.value })} placeholder="Task title" />
                <select value={task.assigneeIndex} onChange={(e) => props.onTaskChange(i, { assigneeIndex: Number(e.target.value) })}>{t.members.map((m, mi) => <option key={mi} value={mi}>{m.name || `Member ${mi + 1}`}</option>)}</select>
                <button className="hbtn danger" title="Remove task" onClick={() => props.onRemoveTask(i)}><X size={13} /></button>
              </div>
              <textarea value={task.description} onChange={(e) => props.onTaskChange(i, { description: e.target.value })} placeholder="Task description" />
            </div>
          ))}
          {t.tasks.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>No tasks — members work freely toward the objective.</span>}
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={props.onCancel}>Cancel</button>
        <button className="btn primary" disabled={props.busy || !t.name.trim()} onClick={props.onSave}>{props.busy ? 'Saving...' : t.builtin ? 'Save as copy' : 'Save template'}</button>
      </div>
    </section>
  )
}

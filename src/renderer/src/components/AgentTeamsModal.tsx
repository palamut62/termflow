import { useEffect, useMemo, useState } from 'react'
import { Bot, CheckCircle2, Circle, Pause, Play, Plus, Send, Square, Users, X } from 'lucide-react'
import type { AgentTeamBundle, TeamPermissionPolicy, TeamRuntimeType, TeamTaskStatus } from '../../../shared/types'
import { useAppStore } from '../store/appStore'
import { useModalClose } from '../hooks/useModalClose'

const POLICY_LABELS: Record<TeamPermissionPolicy, string> = {
  review: 'Review only', controlled: 'Ask before changes', balanced: 'Apply safe changes', full: 'Full access'
}

const STATUS_LABELS: Record<TeamTaskStatus, string> = {
  ready: 'Ready', working: 'Working', approval: 'Awaiting approval', blocked: 'Blocked', review: 'In review', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled'
}

export default function AgentTeamsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const workspaceId = useAppStore((s) => s.activeWorkspaceId)
  const syncTeamCanvas = useAppStore((s) => s.syncTeamCanvas)
  const [teams, setTeams] = useState<AgentTeamBundle[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [objective, setObjective] = useState('')
  const [permissionPolicy, setPermissionPolicy] = useState<TeamPermissionPolicy>('controlled')
  const [teamSize, setTeamSize] = useState<3 | 4 | 5>(4)
  const [runtimeType, setRuntimeType] = useState<TeamRuntimeType>('workflow')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  useModalClose(onClose)

  const selected = useMemo(() => teams.find((item) => item.team.id === selectedId) ?? teams[0], [teams, selectedId])
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
      const bundle = await window.termflow.teams.create({ workspaceId, objective, permissionPolicy, teamSize, runtimeType })
      setObjective('')
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

  const sendMessage = async (): Promise<void> => {
    if (!selected || !message.trim()) return
    const text = message.trim()
    setMessage('')
    setError(null)
    try {
      await window.termflow.teams.message(selected.team.id, text)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the message')
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
            <button className="btn primary" disabled={!workspaceId} onClick={() => setCreating(true)}><Plus size={14} /> New agent team</button>
            {teams.map((item) => <button key={item.team.id} className={selected?.team.id === item.team.id ? 'active' : ''} onClick={() => { setSelectedId(item.team.id); setCreating(false) }}><strong>{item.team.name}{item.team.runtimeType === 'native' && <span className="team-badge">Native</span>}</strong><span>{item.members.length} members · {item.tasks.length} tasks</span><em>{item.team.status}</em></button>)}
          </aside>
          <main className="team-main">
            {creating ? (
              <section className="team-wizard">
                <span className="team-kicker">New team</span><h2>What should the team accomplish?</h2>
                <textarea autoFocus value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Example: Investigate, fix, and test the sign-in issue." />
                <div className="team-options">
                  <label>Runtime<select value={runtimeType} onChange={(event) => setRuntimeType(event.target.value as TeamRuntimeType)}><option value="workflow">Multi-provider Workflow</option><option value="native">Native Claude Team</option></select></label>
                  {runtimeType === 'workflow' && <label>Permission level<select value={permissionPolicy} onChange={(event) => setPermissionPolicy(event.target.value as TeamPermissionPolicy)}>{Object.entries(POLICY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
                  {runtimeType === 'workflow' && <label>Team size<select value={teamSize} onChange={(event) => setTeamSize(Number(event.target.value) as 3 | 4 | 5)}><option value={3}>3 members</option><option value={4}>4 members (recommended)</option><option value={5}>5 members</option></select></label>}
                </div>
                {runtimeType === 'native' && <p className="team-hint">Claude plans the team, spawns teammates, and coordinates tasks itself.</p>}
                <div className="modal-actions"><button className="btn" onClick={() => setCreating(false)}>Cancel</button><button className="btn primary" disabled={busy || !objective.trim()} onClick={() => void createTeam()}>{busy ? 'Preparing...' : 'Create team'}</button></div>
              </section>
            ) : selected ? (
              <>
                <section className="team-summary"><div><span className="team-kicker">{POLICY_LABELS[selected.team.permissionPolicy]}</span><h2>{selected.team.name}</h2><p>{selected.team.objective}</p></div><div className="team-actions">{selected.team.status === 'draft' && <button className="btn primary" disabled={busy} onClick={() => void startTeam(selected)}><Play size={14} /> Start team</button>}{selected.team.status === 'paused' && <button className="btn primary" disabled={busy} onClick={() => void startTeam(selected)}><Play size={14} /> Resume</button>}{selected.team.status === 'running' && selected.team.runtimeType !== 'native' && <button className="btn" onClick={() => void setTeamStatus('paused')}><Pause size={14} /> Pause</button>}{selected.team.status === 'completed' && selected.team.worktreePath && !selected.team.appliedAt && <button className="btn primary" disabled={busy} onClick={() => void applyResult()}><CheckCircle2 size={14} /> Apply results</button>}{selected.team.appliedAt && <span className="team-applied"><CheckCircle2 size={14} /> Applied to project</span>}{['draft', 'running', 'paused'].includes(selected.team.status) && <button className="btn danger" onClick={() => void setTeamStatus('cancelled')}><Square size={13} /> Stop</button>}</div></section>
                <section className="team-members">{selected.members.map((member) => <article key={member.id}><Bot size={16} /><div><strong>{member.name}</strong>{selected.team.status === 'draft' ? <select value={member.provider} onChange={async (event) => { await window.termflow.teams.updateMember(member.id, { provider: event.target.value as typeof member.provider }); await reload(selected.team.id) }}><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="opencode">OpenCode</option></select> : <span>{member.provider}</span>}</div><em className={`team-status ${member.status}`}>{member.status}</em></article>)}</section>
                <section className="team-tasks"><header><h4>Tasks</h4><span>{selected.tasks.filter((task) => task.status === 'completed').length}/{selected.tasks.length} completed</span></header>{selected.tasks.map((task) => { const member = selected.members.find((item) => item.id === task.assigneeId); const lockTask = task.status === 'working' || selected.team.status === 'running'; return <article key={task.id}><button className="task-check" disabled={lockTask} title={lockTask ? 'Cannot change task status while the team is running' : 'Change status'} onClick={() => void setTaskStatus(task.id, task.status === 'completed' ? 'ready' : 'completed')}>{task.status === 'completed' ? <CheckCircle2 size={18} /> : <Circle size={18} />}</button><div><strong>{task.title}</strong><p>{task.description}</p><span>{member?.name ?? 'Unassigned'} · {STATUS_LABELS[task.status]}</span>{task.status === 'approval' && <button className="btn primary" onClick={() => void approveTask(task.id)}>Approve plan and apply</button>}</div></article> })}</section>
                <section className="team-events"><header><h4>Live activity</h4><span>{selected.events.length} events</span></header>{selected.events.slice(-30).reverse().map((event) => <article key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString()}</time><p>{event.message}</p></article>)}</section>
                {selected.team.runtimeType === 'native' && selected.team.status === 'running' && <section className="team-message"><input value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void sendMessage() }} placeholder="Message the team lead (use @name to reach a teammate)" /><button className="btn primary" disabled={!message.trim()} onClick={() => void sendMessage()}><Send size={14} /> Send</button></section>}
              </>
            ) : <div className="team-empty"><Users size={38} /><strong>Create your first agent team</strong><span>No technical setup required. Just describe your goal in plain language.</span></div>}
          </main>
        </div>
      </div>
    </div>
  )
}

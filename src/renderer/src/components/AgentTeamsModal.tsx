import { useEffect, useMemo, useState } from 'react'
import { Bot, CheckCircle2, Circle, Pause, Play, Plus, Square, Users, X } from 'lucide-react'
import type { AgentTeamBundle, TeamPermissionPolicy, TeamTaskStatus } from '../../../shared/types'
import { useAppStore } from '../store/appStore'
import { useModalClose } from '../hooks/useModalClose'

const POLICY_LABELS: Record<TeamPermissionPolicy, string> = {
  review: 'Sadece incele', controlled: 'Değişikliklerden önce sor', balanced: 'Güvenli değişiklikleri yap', full: 'Tam yetki'
}

const STATUS_LABELS: Record<TeamTaskStatus, string> = {
  ready: 'Hazır', working: 'Çalışıyor', approval: 'Onay bekliyor', blocked: 'Engellendi', review: 'İncelemede', completed: 'Tamamlandı', failed: 'Başarısız', cancelled: 'İptal edildi'
}

export default function AgentTeamsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const workspaceId = useAppStore((s) => s.activeWorkspaceId)
  const [teams, setTeams] = useState<AgentTeamBundle[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [objective, setObjective] = useState('')
  const [permissionPolicy, setPermissionPolicy] = useState<TeamPermissionPolicy>('controlled')
  const [teamSize, setTeamSize] = useState<3 | 4 | 5>(4)
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
      const bundle = await window.termflow.teams.create({ workspaceId, objective, permissionPolicy, teamSize })
      setObjective('')
      setCreating(false)
      await reload(bundle.team.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Takım oluşturulamadı')
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Takım başlatılamadı')
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
      setError(err instanceof Error ? err.message : 'Takım sonucu uygulanamadı')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="modal agent-teams" onMouseDown={(event) => event.stopPropagation()}>
        <header className="team-head">
          <div><h3><Users size={18} /> Agent Teams</h3><p>Hedefini yaz. TermFlow rolleri, görevleri ve gerçek Claude Code oturumlarını hazırlasın.</p></div>
          <button className="hbtn" title="Kapat" onClick={onClose}><X size={16} /></button>
        </header>
        {error && <div className="side-error" role="alert">{error}</div>}
        {notice && <div className="side-success" role="status">{notice}</div>}
        <div className="team-layout">
          <aside className="team-list">
            <button className="btn primary" disabled={!workspaceId} onClick={() => setCreating(true)}><Plus size={14} /> Yeni Agent Team</button>
            {teams.map((item) => <button key={item.team.id} className={selected?.team.id === item.team.id ? 'active' : ''} onClick={() => { setSelectedId(item.team.id); setCreating(false) }}><strong>{item.team.name}</strong><span>{item.members.length} üye · {item.tasks.length} görev</span><em>{item.team.status}</em></button>)}
          </aside>
          <main className="team-main">
            {creating ? (
              <section className="team-wizard">
                <span className="team-kicker">Yeni takım</span><h2>Takım ne yapacak?</h2>
                <textarea autoFocus value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Örnek: Giriş sistemindeki hatayı araştır, düzelt ve test et." />
                <div className="team-options">
                  <label>Yetki seviyesi<select value={permissionPolicy} onChange={(event) => setPermissionPolicy(event.target.value as TeamPermissionPolicy)}>{Object.entries(POLICY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                  <label>Takım boyutu<select value={teamSize} onChange={(event) => setTeamSize(Number(event.target.value) as 3 | 4 | 5)}><option value={3}>3 üye</option><option value={4}>4 üye (önerilen)</option><option value={5}>5 üye</option></select></label>
                </div>
                <div className="modal-actions"><button className="btn" onClick={() => setCreating(false)}>Vazgeç</button><button className="btn primary" disabled={busy || !objective.trim()} onClick={() => void createTeam()}>{busy ? 'Hazırlanıyor...' : 'Takımı hazırla'}</button></div>
              </section>
            ) : selected ? (
              <>
                <section className="team-summary"><div><span className="team-kicker">{POLICY_LABELS[selected.team.permissionPolicy]}</span><h2>{selected.team.name}</h2><p>{selected.team.objective}</p></div><div className="team-actions">{selected.team.status === 'draft' && <button className="btn primary" disabled={busy} onClick={() => void startTeam(selected)}><Play size={14} /> Takımı başlat</button>}{selected.team.status === 'running' && <button className="btn" onClick={() => void setTeamStatus('paused')}><Pause size={14} /> Duraklat</button>}{selected.team.status === 'completed' && selected.team.worktreePath && !selected.team.appliedAt && <button className="btn primary" disabled={busy} onClick={() => void applyResult()}><CheckCircle2 size={14} /> Sonucu projeye uygula</button>}{selected.team.appliedAt && <span className="team-applied"><CheckCircle2 size={14} /> Projeye uygulandı</span>}{['draft', 'running', 'paused'].includes(selected.team.status) && <button className="btn danger" onClick={() => void setTeamStatus('cancelled')}><Square size={13} /> Durdur</button>}</div></section>
                <section className="team-members">{selected.members.map((member) => <article key={member.id}><Bot size={16} /><div><strong>{member.name}</strong>{selected.team.status === 'draft' ? <select value={member.provider} onChange={async (event) => { await window.termflow.teams.updateMember(member.id, { provider: event.target.value as typeof member.provider }); await reload(selected.team.id) }}><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="opencode">OpenCode</option><option value="generic">Generic CLI</option></select> : <span>{member.provider}</span>}</div><em className={`team-status ${member.status}`}>{member.status}</em></article>)}</section>
                <section className="team-tasks"><header><h4>Görevler</h4><span>{selected.tasks.filter((task) => task.status === 'completed').length}/{selected.tasks.length} tamamlandı</span></header>{selected.tasks.map((task) => { const member = selected.members.find((item) => item.id === task.assigneeId); return <article key={task.id}><button className="task-check" title="Durumu değiştir" onClick={() => void setTaskStatus(task.id, task.status === 'completed' ? 'ready' : 'completed')}>{task.status === 'completed' ? <CheckCircle2 size={18} /> : <Circle size={18} />}</button><div><strong>{task.title}</strong><p>{task.description}</p><span>{member?.name ?? 'Atanmadı'} · {STATUS_LABELS[task.status]}</span>{task.status === 'approval' && <button className="btn primary" onClick={() => void approveTask(task.id)}>Planı onayla ve uygula</button>}</div></article> })}</section>
                <section className="team-events"><header><h4>Canlı çalışma akışı</h4><span>{selected.events.length} olay</span></header>{selected.events.slice(-30).reverse().map((event) => <article key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString()}</time><p>{event.message}</p></article>)}</section>
              </>
            ) : <div className="team-empty"><Users size={38} /><strong>İlk agent team'ini oluştur</strong><span>Teknik ayar gerekmez. Hedefini doğal dille yazman yeterli.</span></div>}
          </main>
        </div>
      </div>
    </div>
  )
}

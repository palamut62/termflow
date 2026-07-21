import { useEffect, useMemo, useState } from 'react'
import { Bot, CheckCircle2, Circle, Copy, LayoutTemplate, Pause, Pencil, Play, Plus, Sparkles, Square, Trash2, Users, X } from 'lucide-react'
import type { AgentTeamBundle, AgentTeamTemplate, TeamPermissionPolicy, TeamTaskStatus } from '../../../shared/types'
import { useAppStore } from '../store/appStore'
import { getActiveTerminalId } from '../paneUtils'
import { useModalClose } from '../hooks/useModalClose'

const ROLE_INSTRUCTIONS: Record<string, string> = {
  lead: 'Takımın liderisin. Hedefi takip et, üyelerin görevlerini koordine et, sonuçları sentezle ve kalite kapıları geçmeden işi tamamlandı sayma.',
  researcher: 'Araştırmacısın. Önce gerçek kodu incele, riskleri ve kök nedeni bul. Kod değiştirmeden uygulanabilir bir plan ve kanıt sun.',
  developer: 'Geliştiricisin. Yalnızca atanan uygulama görevini yap. İlgili kodu önce oku, değişikliği hedefle sınırlı tut ve derleme sonucunu bildir.',
  tester: 'Test uzmanısın. Değişikliği bağımsız doğrula. İlgili testleri çalıştır, kullanıcı davranışını kontrol et ve somut kanıt raporla.',
  reviewer: 'Kod inceleyicisin. Değişiklikleri doğruluk, güvenlik, regresyon ve test kapsamı açısından incele. Engelleyici bulguları açıkça bildir.'
}

const POLICY_LABELS: Record<TeamPermissionPolicy, string> = {
  review: 'Sadece incele', controlled: 'Değişikliklerden önce sor', balanced: 'Güvenli değişiklikleri yap', full: 'Tam yetki'
}

const STATUS_LABELS: Record<TeamTaskStatus, string> = {
  ready: 'Hazır', working: 'Çalışıyor', approval: 'Onay bekliyor', blocked: 'Engellendi', review: 'İncelemede', completed: 'Tamamlandı', failed: 'Başarısız', cancelled: 'İptal edildi'
}

const STARTUP_BY_POLICY: Record<TeamPermissionPolicy, string> = {
  review: 'claude --permission-mode plan',
  controlled: 'claude',
  balanced: 'claude --permission-mode acceptEdits',
  full: 'claude --dangerously-skip-permissions'
}

function blankTemplate(): AgentTeamTemplate {
  const ts = new Date().toISOString()
  return { id: '', name: '', description: '', permissionPolicy: 'controlled', members: [{ name: '', role: '', instructions: '' }], tasks: [], createdAt: ts, updatedAt: ts }
}

async function waitForAgentReady(terminalId: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const output = await window.termflow.pty.buffer(terminalId)
    if (/claude code|how can i help|welcome/i.test(output)) return
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
}

export default function AgentTeamsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const workspaceId = useAppStore((s) => s.activeWorkspaceId)
  const addTerminal = useAppStore((s) => s.addTerminal)
  const settings = useAppStore((s) => s.settings)
  const [teams, setTeams] = useState<AgentTeamBundle[]>([])
  const [templates, setTemplates] = useState<AgentTeamTemplate[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<'teams' | 'templates'>('teams')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<AgentTeamTemplate | null>(null)
  const [pendingTemplate, setPendingTemplate] = useState<AgentTeamTemplate | null>(null)
  const [objective, setObjective] = useState('')
  const [permissionPolicy, setPermissionPolicy] = useState<TeamPermissionPolicy>('controlled')
  const [teamSize, setTeamSize] = useState<3 | 4 | 5>(4)
  const [busy, setBusy] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useModalClose(onClose)

  const selected = useMemo(() => teams.find((item) => item.team.id === selectedId) ?? teams[0], [teams, selectedId])
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

  const createTeam = async (): Promise<void> => {
    if (!workspaceId || !objective.trim()) return
    setBusy(true)
    setError(null)
    try {
      const bundle = await window.termflow.teams.create({ workspaceId, objective, permissionPolicy, teamSize, template: pendingTemplate ?? undefined })
      setObjective('')
      setCreating(false)
      setPendingTemplate(null)
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
      await window.termflow.teams.update(bundle.team.id, { status: 'running' })
      for (const member of bundle.members) {
        const tasks = bundle.tasks.filter((task) => task.assigneeId === member.id)
        await addTerminal('claude', { name: member.name, agentRole: member.name, startupCommand: STARTUP_BY_POLICY[bundle.team.permissionPolicy] })
        const state = useAppStore.getState()
        const node = state.nodes.find((item) => item.id === state.activeNodeId)
        const terminalId = node ? getActiveTerminalId(node.activePaneId, node.panes, node.terminalId) : undefined
        if (!terminalId) continue
        await window.termflow.teams.updateMember(member.id, { status: 'working', terminalId })
        const taskText = tasks.length ? tasks.map((task) => `- ${task.title}: ${task.description}`).join('\n') : '- Takımın ilerlemesini izle ve sonuçları sentezle.'
        const roleInstruction = member.instructions?.trim() || ROLE_INSTRUCTIONS[member.role] || `${member.name} rolündesin.`
        const prompt = `${roleInstruction}\n\nTakım hedefi: ${bundle.team.objective}\n\nSana atanan görevler:\n${taskText}\n\nÇalışma klasörünün dışına çıkma. Başlamadan önce ilgili kodu incele. İlerlemeni ve sonucunu sade Türkçe ile bildir.`
        await waitForAgentReady(terminalId)
        window.termflow.pty.write(terminalId, `${prompt}\r`)
      }
      await reload(bundle.team.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Takım başlatılamadı')
    } finally {
      setBusy(false)
    }
  }

  const setTeamStatus = async (status: 'paused' | 'cancelled'): Promise<void> => {
    if (!selected) return
    if (status === 'cancelled') {
      for (const member of selected.members) if (member.terminalId) window.termflow.pty.kill(member.terminalId)
    }
    await window.termflow.teams.update(selected.team.id, { status })
    await reload(selected.team.id)
  }

  const setTaskStatus = async (taskId: string, status: TeamTaskStatus): Promise<void> => {
    await window.termflow.teams.updateTask(taskId, { status })
    if (selected) await reload(selected.team.id)
  }

  // ---- Templates ----
  const openWizardWithTemplate = (tpl: AgentTeamTemplate): void => {
    setPendingTemplate(tpl)
    setPermissionPolicy(tpl.permissionPolicy)
    setView('teams')
    setCreating(true)
    setEditing(null)
  }

  const saveTemplate = async (): Promise<void> => {
    if (!editing || !editing.name.trim()) { setError('Şablon adı boş olamaz'); return }
    setBusy(true)
    setError(null)
    try {
      await window.termflow.teamTemplates.save(editing)
      await reloadTemplates()
      setEditing(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Şablon kaydedilemedi')
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
    if (settings.aiProvider === 'none') {
      setError('AI sağlayıcı ayarlı değil. Ayarlar → AI Sağlayıcı bölümünden bir sağlayıcı ve model seçin.')
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
      setError(err instanceof Error ? err.message : 'AI takımı üretilemedi')
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

  const buildTeamFromEditing = async (): Promise<void> => {
    if (!editing) return
    openWizardWithTemplate(editing)
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="modal agent-teams" onMouseDown={(event) => event.stopPropagation()}>
        <header className="team-head">
          <div><h3><Users size={18} /> Agent Teams</h3><p>Hedefini yaz. TermFlow rolleri, görevleri ve gerçek Claude Code oturumlarını hazırlasın.</p></div>
          <button className="hbtn" title="Kapat" onClick={onClose}><X size={16} /></button>
        </header>
        {error && <div className="side-error" role="alert">{error}</div>}
        <div className="team-layout">
          <aside className="team-list">
            <div className="team-tabs">
              <button className={view === 'teams' ? 'active' : ''} onClick={() => { setView('teams'); setEditing(null) }}><Users size={13} /> Takımlar</button>
              <button className={view === 'templates' ? 'active' : ''} onClick={() => { setView('templates'); setCreating(false) }}><LayoutTemplate size={13} /> Şablonlar</button>
            </div>
            {view === 'teams' ? (
              <>
                <button className="btn primary" disabled={!workspaceId} onClick={() => { setCreating(true); setPendingTemplate(null) }}><Plus size={14} /> Yeni Agent Team</button>
                {teams.map((item) => <button key={item.team.id} className={selected?.team.id === item.team.id ? 'active' : ''} onClick={() => { setSelectedId(item.team.id); setCreating(false) }}><strong>{item.team.name}</strong><span>{item.members.length} üye · {item.tasks.length} görev</span><em>{item.team.status}</em></button>)}
              </>
            ) : (
              <>
                <button className="btn primary" onClick={() => setEditing(blankTemplate())}><Plus size={14} /> Yeni Şablon</button>
                {templates.map((tpl) => (
                  <button key={tpl.id} className={editing?.id === tpl.id ? 'active' : ''} onClick={() => setEditing(tpl)}>
                    <strong>{tpl.name}{tpl.builtin ? ' ·' : ''}</strong>
                    <span>{tpl.members.length} üye · {tpl.tasks.length} görev{tpl.builtin ? ' · hazır' : ''}</span>
                  </button>
                ))}
                {templates.length === 0 && <span style={{ padding: 8, color: 'var(--text-muted)', fontSize: 10 }}>Henüz şablon yok.</span>}
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
                onBuild={() => void buildTeamFromEditing()}
                onCopy={() => setEditing({ ...editing, id: '', builtin: false, name: `${editing.name} (Kopya)` })}
                onDelete={editing.id ? () => { void deleteTemplate(editing.id); setEditing(null) } : undefined}
              />
            ) : view === 'templates' ? (
              <div className="team-empty"><LayoutTemplate size={38} /><strong>Takım şablonları</strong><span>Bir şablon seç veya yeni oluştur. Şablondan tek tıkla takım kurabilirsin.</span></div>
            ) : creating ? (
              <section className="team-wizard">
                <span className="team-kicker">Yeni takım</span><h2>Takım ne yapacak?</h2>
                {pendingTemplate && <div className="team-tpl-banner"><LayoutTemplate size={13} /> Şablon: <strong>{pendingTemplate.name}</strong><button className="hbtn" title="Şablonu kaldır" onClick={() => setPendingTemplate(null)}><X size={12} /></button></div>}
                <textarea autoFocus value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Örnek: Giriş sistemindeki hatayı araştır, düzelt ve test et." />
                <div className="team-options">
                  <label>Yetki seviyesi<select value={permissionPolicy} onChange={(event) => setPermissionPolicy(event.target.value as TeamPermissionPolicy)}>{Object.entries(POLICY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                  <label>Takım boyutu<select value={teamSize} onChange={(event) => setTeamSize(Number(event.target.value) as 3 | 4 | 5)}><option value={3}>3 üye</option><option value={4}>4 üye (önerilen)</option><option value={5}>5 üye</option></select></label>
                </div>
                <div className="modal-actions">
                  <button className="btn" onClick={() => { setCreating(false); setPendingTemplate(null) }}>Vazgeç</button>
                  {!pendingTemplate && <button className="btn" disabled={aiBusy || !objective.trim()} onClick={() => void runAiGenerate()}><Sparkles size={13} /> {aiBusy ? 'AI üretiyor...' : 'AI ile oluştur'}</button>}
                  <button className="btn primary" disabled={busy || !objective.trim()} onClick={() => void createTeam()}>{busy ? 'Hazırlanıyor...' : 'Takımı hazırla'}</button>
                </div>
              </section>
            ) : selected ? (
              <>
                <section className="team-summary"><div><span className="team-kicker">{POLICY_LABELS[selected.team.permissionPolicy]}</span><h2>{selected.team.name}</h2><p>{selected.team.objective}</p></div><div className="team-actions">{selected.team.status === 'draft' && <button className="btn primary" disabled={busy} onClick={() => void startTeam(selected)}><Play size={14} /> Takımı başlat</button>}{selected.team.status === 'running' && <button className="btn" onClick={() => void setTeamStatus('paused')}><Pause size={14} /> Duraklat</button>}<button className="btn danger" onClick={() => void setTeamStatus('cancelled')}><Square size={13} /> Durdur</button></div></section>
                <section className="team-members">{selected.members.map((member) => <article key={member.id}><Bot size={16} /><div><strong>{member.name}</strong><span>Claude Code</span></div><em className={`team-status ${member.status}`}>{member.status}</em></article>)}</section>
                <section className="team-tasks"><header><h4>Görevler</h4><span>{selected.tasks.filter((task) => task.status === 'completed').length}/{selected.tasks.length} tamamlandı</span></header>{selected.tasks.map((task) => { const member = selected.members.find((item) => item.id === task.assigneeId); return <article key={task.id}><button className="task-check" title="Durumu değiştir" onClick={() => void setTaskStatus(task.id, task.status === 'completed' ? 'ready' : 'completed')}>{task.status === 'completed' ? <CheckCircle2 size={18} /> : <Circle size={18} />}</button><div><strong>{task.title}</strong><p>{task.description}</p><span>{member?.name ?? 'Atanmadı'} · {STATUS_LABELS[task.status]}</span></div></article> })}</section>
              </>
            ) : <div className="team-empty"><Users size={38} /><strong>İlk agent team'ini oluştur</strong><span>Teknik ayar gerekmez. Hedefini doğal dille yazman yeterli.</span></div>}
          </main>
        </div>
      </div>
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
        <div><span className="team-kicker">{t.builtin ? 'Hazır şablon (kopya olarak kaydedilir)' : t.id ? 'Şablonu düzenle' : 'Yeni şablon'}</span><h2>{t.name || 'Adsız şablon'}</h2></div>
        <div className="team-actions">
          <button className="btn" onClick={props.onBuild}><Play size={13} /> Takımı kur</button>
          <button className="btn" onClick={props.onCopy}><Copy size={13} /> Kopyala</button>
          {props.onDelete && !t.builtin && <button className="btn danger" onClick={props.onDelete}><Trash2 size={13} /> Sil</button>}
        </div>
      </header>
      <div className="team-tpl-body">
        <label className="team-tpl-field">İsim<input value={t.name} onChange={(e) => props.onChange({ name: e.target.value })} placeholder="Örn: Full-Stack Geliştirme Takımı" /></label>
        <label className="team-tpl-field">Açıklama<input value={t.description} onChange={(e) => props.onChange({ description: e.target.value })} placeholder="Takımın amacı" /></label>
        <label className="team-tpl-field">Yetki seviyesi<select value={t.permissionPolicy} onChange={(e) => props.onChange({ permissionPolicy: e.target.value as TeamPermissionPolicy })}>{Object.entries(POLICY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>

        <div className="team-tpl-section">
          <div className="team-tpl-section-head"><h4>Üyeler ({t.members.length})</h4><button className="btn" onClick={props.onAddMember}><Plus size={12} /> Üye ekle</button></div>
          {t.members.map((m, i) => (
            <div key={i} className="team-tpl-member">
              <div className="team-tpl-row2">
                <input value={m.name} onChange={(e) => props.onMemberChange(i, { name: e.target.value })} placeholder="Üye adı" />
                <input value={m.role} onChange={(e) => props.onMemberChange(i, { role: e.target.value })} placeholder="Rol (örn: developer)" />
                <button className="hbtn danger" title="Üyeyi kaldır" disabled={t.members.length <= 1} onClick={() => props.onRemoveMember(i)}><X size={13} /></button>
              </div>
              <textarea value={m.instructions} onChange={(e) => props.onMemberChange(i, { instructions: e.target.value })} placeholder="Bu ajanın tam sistem talimatı (sorumluluk, yöntem, kalite kapıları)..." />
            </div>
          ))}
        </div>

        <div className="team-tpl-section">
          <div className="team-tpl-section-head"><h4>Görevler ({t.tasks.length})</h4><button className="btn" onClick={props.onAddTask}><Plus size={12} /> Görev ekle</button></div>
          {t.tasks.map((task, i) => (
            <div key={i} className="team-tpl-member">
              <div className="team-tpl-row2">
                <input value={task.title} onChange={(e) => props.onTaskChange(i, { title: e.target.value })} placeholder="Görev başlığı" />
                <select value={task.assigneeIndex} onChange={(e) => props.onTaskChange(i, { assigneeIndex: Number(e.target.value) })}>{t.members.map((m, mi) => <option key={mi} value={mi}>{m.name || `Üye ${mi + 1}`}</option>)}</select>
                <button className="hbtn danger" title="Görevi kaldır" onClick={() => props.onRemoveTask(i)}><X size={13} /></button>
              </div>
              <textarea value={task.description} onChange={(e) => props.onTaskChange(i, { description: e.target.value })} placeholder="Görev açıklaması" />
            </div>
          ))}
          {t.tasks.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>Görev yok — üyeler hedefe göre serbest çalışır.</span>}
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={props.onCancel}>Vazgeç</button>
        <button className="btn primary" disabled={props.busy || !t.name.trim()} onClick={props.onSave}>{props.busy ? 'Kaydediliyor...' : t.builtin ? 'Kopya olarak kaydet' : 'Şablonu kaydet'}</button>
      </div>
    </section>
  )
}

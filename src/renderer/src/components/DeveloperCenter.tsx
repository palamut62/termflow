import { Activity, CheckCircle2, Download, Play, RefreshCw, TriangleAlert, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { WorkspaceHealthCheck } from '../../../shared/types'
import { useAppStore } from '../store/appStore'

export default function DeveloperCenter(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [checks, setChecks] = useState<WorkspaceHealthCheck[]>([])
  const [loading, setLoading] = useState(false)
  const workspaceId = useAppStore((s) => s.activeWorkspaceId)
  const manifest = useAppStore((s) => s.projectManifest)
  const runTask = useAppStore((s) => s.runManifestTask)

  const refresh = async (): Promise<void> => {
    if (!workspaceId) return
    setLoading(true)
    try { setChecks(await window.termflow.workspaces.health(workspaceId)) } finally { setLoading(false) }
  }
  useEffect(() => { if (open) void refresh() }, [open, workspaceId])
  if (!workspaceId) return null
  if (!open) return <button className="developer-trigger" onClick={() => setOpen(true)}><Activity size={13} /> Developer Center</button>

  return (
    <aside className="developer-center">
      <div className="aap-head">
        <div><strong>Developer Center</strong><span>Tasks, runtimes and workspace health</span></div>
        <button className="hbtn" title="Close Developer Center" aria-label="Close Developer Center" onClick={() => setOpen(false)}><XCircle size={15} /></button>
      </div>
      {(manifest?.tasks?.length ?? 0) > 0 && <div className="dev-section">
        <div className="dev-section-title">Project tasks</div>
        {manifest!.tasks!.map((task) => <button className="dev-task" key={task.name} onClick={() => runTask(task.name)}><Play size={12} /><span>{task.name}</span><em>{task.command}</em></button>)}
      </div>}
      <div className="dev-section">
        <div className="dev-section-title"><span>Workspace health</span><button className="hbtn" title="Refresh workspace health" aria-label="Refresh workspace health" disabled={loading} onClick={() => refresh()}><RefreshCw className={loading ? 'spin' : ''} size={14} /></button></div>
        {checks.map((check) => <div className={`health-row ${check.status}`} key={check.id}>{check.status === 'ok' ? <CheckCircle2 size={13} /> : <TriangleAlert size={13} />}<span>{check.label}</span><em title={check.detail}>{check.detail}</em></div>)}
      </div>
      <div className="dev-footer"><button className="btn" onClick={() => window.termflow.diagnostics.export(workspaceId)}><Download size={13} /> Export Diagnostics</button></div>
    </aside>
  )
}

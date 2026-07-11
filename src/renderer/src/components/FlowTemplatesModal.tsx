import { useEffect, useState } from 'react'
import { Trash2, Workflow } from 'lucide-react'
import { useAppStore } from '../store/appStore'
import type { FlowTemplate } from '../../../shared/types'
import PromptModal, { type PromptField } from './PromptModal'

interface Props {
  onClose: () => void
}

// Agent flow templates: apply a ready-made multi-agent pipeline (nodes +
// typed/routed connections) onto the canvas in one click, or save the
// currently-open agent nodes/connections as a reusable template.
// (feature: agent flow templates)
export default function FlowTemplatesModal({ onClose }: Props): React.JSX.Element {
  const applyFlowTemplate = useAppStore((s) => s.applyFlowTemplate)
  const saveFlowTemplate = useAppStore((s) => s.saveFlowTemplate)
  const [templates, setTemplates] = useState<FlowTemplate[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSave, setShowSave] = useState(false)

  const reload = async (): Promise<void> => setTemplates(await window.termflow.flowTemplates.list())

  useEffect(() => {
    reload()
  }, [])

  const apply = async (t: FlowTemplate): Promise<void> => {
    setError(null)
    setBusyId(t.id)
    try {
      await applyFlowTemplate(t)
      onClose()
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (t: FlowTemplate): Promise<void> => {
    await window.termflow.flowTemplates.remove(t.id)
    await reload()
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => { e.stopPropagation(); onClose() }}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} style={{ width: 480 }}>
        <h3>Agent Flow Templates</h3>
        {error && <div className="side-error" role="alert">{error}</div>}
        {templates.map((t) => (
          <div key={t.id} style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0',
            borderBottom: '1px solid var(--border-soft)'
          }}>
            <Workflow size={15} />
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {t.nodes.map((n) => n.title).join(' → ')}
              </div>
            </div>
            <button className="btn primary" disabled={busyId === t.id} onClick={() => apply(t)}>
              {busyId === t.id ? 'Applying…' : 'Apply'}
            </button>
            {!t.builtin && (
              <button className="hbtn" title="Delete template" onClick={() => remove(t)} style={{ color: 'var(--danger)' }}>
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
        <div className="modal-actions">
          <button className="btn" onClick={() => setShowSave(true)}>Save current flow as template</button>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
      {showSave && (
        <PromptModal
          title="Save agent flow as template"
          submitLabel="Save"
          fields={[{ key: 'name', label: 'Template name', required: true } as PromptField]}
          onSubmit={async (values) => {
            const res = await saveFlowTemplate(values.name)
            if (res.error) setError(res.error)
            else await reload()
          }}
          onClose={() => setShowSave(false)}
        />
      )}
    </div>
  )
}

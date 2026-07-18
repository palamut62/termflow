import { Bot, Plus } from 'lucide-react'
import { useAppStore } from '../store/appStore'
import { useModalClose } from '../hooks/useModalClose'

interface Props {
  sourceNodeId: string
  onClose: () => void
}

// AI log summary: pick an agent (existing or a fresh one) to receive the
// source terminal's recent output for a "what happened / error / suggestion"
// summary. (feature: AI log summary)
export default function LogSummaryModal({ sourceNodeId, onClose }: Props): React.JSX.Element {
  const nodes = useAppStore((s) => s.nodes)
  const sendLogToAgent = useAppStore((s) => s.sendLogToAgent)
  const agentNodes = nodes.filter((n) => n.nodeType === 'agent' && n.id !== sourceNodeId)
  useModalClose(onClose)

  const pick = (targetId: string | 'new'): void => {
    sendLogToAgent(sourceNodeId, targetId)
    onClose()
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onMouseDown={(e) => { e.stopPropagation(); onClose() }}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} style={{ width: 380 }}>
        <h3>Send log to an agent for summary</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflowY: 'auto' }}>
          <div className="menu-item" onClick={() => pick('new')}>
            <Plus size={14} color="var(--accent)" /> New Claude agent
          </div>
          {agentNodes.length > 0 && <div className="menu-sep" />}
          {agentNodes.map((n) => (
            <div key={n.id} className="menu-item" onClick={() => pick(n.id)}>
              <Bot size={14} /> {n.title}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

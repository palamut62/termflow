import { useState } from 'react'
import type { ConnectionType } from '../../../shared/types'

interface Props {
  onSubmit: (type: ConnectionType, label?: string) => void
  onClose: () => void
}

const TYPES: { value: ConnectionType; label: string }[] = [
  { value: 'control', label: 'Control Flow' },
  { value: 'data', label: 'Data Flow' },
  { value: 'log', label: 'Log Flow' },
  { value: 'error', label: 'Error Flow' },
  { value: 'dependency', label: 'Dependency' },
  { value: 'parent_child', label: 'Parent / Child' },
  { value: 'trigger', label: 'Trigger' },
  { value: 'manual', label: 'Manual Link' }
]

export default function ConnectionModal({ onSubmit, onClose }: Props): React.JSX.Element {
  const [type, setType] = useState<ConnectionType>('control')
  const [label, setLabel] = useState('')

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Bağlantı Oluştur</h3>
        <div className="field">
          <label>Bağlantı tipi</label>
          <select value={type} onChange={(e) => setType(e.target.value as ConnectionType)}>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Etiket (opsiyonel)</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ör. TASK_READY" autoFocus />
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            İptal
          </button>
          <button className="btn primary" onClick={() => onSubmit(type, label || undefined)}>
            Bağla
          </button>
        </div>
      </div>
    </div>
  )
}

import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'

interface Props {
  onSubmit: (command: string) => void
  onClose: () => void
}

// Dangerous command patterns (PRD §19.1)
const DANGER_RE = /\b(rm\s+-rf|del\s+\/s|format\b|Invoke-Expression|-EncodedCommand)\b|\|\s*(powershell|iex)/i

export default function CustomCommandModal({ onSubmit, onClose }: Props): React.JSX.Element {
  const [cmd, setCmd] = useState('')
  const danger = DANGER_RE.test(cmd)

  const submit = (): void => {
    if (!cmd.trim()) return
    if (danger && !window.confirm('Bu komut tehlikeli görünüyor. Yine de çalıştırılsın mı?')) return
    onSubmit(cmd.trim())
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Custom Command</h3>
        <div className="field">
          <label>Çalıştırılacak komut</label>
          <input
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            placeholder="ör. python agent.py"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </div>
        {danger && (
          <div style={{ display: 'flex', gap: 8, color: 'var(--warning)', fontSize: 12, marginTop: -6 }}>
            <AlertTriangle size={15} /> Tehlikeli komut kalıbı algılandı.
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            İptal
          </button>
          <button className="btn primary" disabled={!cmd.trim()} onClick={submit}>
            Aç
          </button>
        </div>
      </div>
    </div>
  )
}

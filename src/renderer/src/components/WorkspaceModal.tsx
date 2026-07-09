import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { useAppStore } from '../store/appStore'

interface Props {
  onClose: () => void
}

export default function WorkspaceModal({ onClose }: Props): React.JSX.Element {
  const createWorkspace = useAppStore((s) => s.createWorkspace)
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)

  const pick = async (): Promise<void> => {
    const dir = await window.termflow.dialog.openDir()
    if (dir) {
      setPath(dir)
      if (!name) setName(dir.split(/[\\/]/).pop() || 'Workspace')
    }
  }

  const submit = async (): Promise<void> => {
    if (!name || !path) return
    setBusy(true)
    await createWorkspace({ name, path, description: description || undefined })
    setBusy(false)
    onClose()
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Yeni Workspace</h3>
        <div className="field">
          <label>Ad</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Proje adı" autoFocus />
        </div>
        <div className="field">
          <label>Klasör</label>
          <div className="path-pick">
            <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\\Projeler\\..." />
            <button className="btn" onClick={pick}>
              <FolderOpen size={15} />
            </button>
          </div>
        </div>
        <div className="field">
          <label>Açıklama (opsiyonel)</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            İptal
          </button>
          <button className="btn primary" disabled={!name || !path || busy} onClick={submit}>
            Oluştur
          </button>
        </div>
      </div>
    </div>
  )
}

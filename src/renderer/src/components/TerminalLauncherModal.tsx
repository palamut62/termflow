import { FolderOpen } from 'lucide-react'
import { useState } from 'react'
import type { ShellKind } from '../../../shared/types'
import { PROFILES } from '../profiles'
import { useAppStore } from '../store/appStore'

export default function TerminalLauncherModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const addTerminal = useAppStore((s) => s.addTerminal)
  const [kind, setKind] = useState<ShellKind>('cmd')
  const [cwd, setCwd] = useState('')
  const shells = PROFILES.filter((profile) => profile.group === 'shell' && !['custom', 'ssh'].includes(profile.kind))

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <h3>Open terminal at folder</h3>
        <div className="field">
          <label>Terminal</label>
          <select value={kind} onChange={(event) => setKind(event.target.value as ShellKind)}>
            {shells.map((profile) => <option key={profile.kind} value={profile.kind}>{profile.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Working directory</label>
          <div className="path-pick">
            <input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="C:\\projects\\my-app" />
            <button className="btn" onClick={async () => { const path = await window.termflow.dialog.openDir(); if (path) setCwd(path) }}>
              <FolderOpen size={14} /> Browse
            </button>
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!cwd.trim()} onClick={() => { addTerminal(kind, { cwd: cwd.trim() }); onClose() }}>Open terminal</button>
        </div>
      </div>
    </div>
  )
}

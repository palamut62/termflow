import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { AiProviderProfile } from '../../../shared/types'
import { useAppStore } from '../store/appStore'
import { useModalClose } from '../hooks/useModalClose'

const emptyProfile = (): AiProviderProfile => ({
  id: crypto.randomUUID(), name: 'New Provider', command: '', model: '', baseUrl: '',
  apiKeyEnv: '', modelEnv: '', baseUrlEnv: '', color: '#2f80ff', fullPermissionArgs: ''
})

export default function ProviderManagerModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [profiles, setProfiles] = useState<AiProviderProfile[]>(settings.providerProfiles)
  useModalClose(onClose)

  const patchProfile = (id: string, patch: Partial<AiProviderProfile>): void => {
    setProfiles((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item))
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="modal provider-modal" onMouseDown={(event) => event.stopPropagation()}>
        <h3>AI Provider Profiles</h3>
        <p className="help-intro">Configure any CLI-backed provider. Store API keys separately under Settings &gt; Developer &gt; Workspace Environment using the API key variable shown here.</p>
        <div className="provider-list">
          {profiles.map((profile) => (
            <section className="provider-card" key={profile.id}>
              <div className="provider-card-head">
                <input value={profile.name} onChange={(e) => patchProfile(profile.id, { name: e.target.value })} aria-label="Provider name" />
                <input type="color" value={profile.color} onChange={(e) => patchProfile(profile.id, { color: e.target.value })} aria-label="Provider color" />
                <button className="hbtn danger" title="Delete provider" onClick={() => setProfiles((items) => items.filter((item) => item.id !== profile.id))}><Trash2 size={14} /></button>
              </div>
              <div className="provider-fields">
                <label>Terminal command<input value={profile.command} onChange={(e) => patchProfile(profile.id, { command: e.target.value })} placeholder="claude, opencode, ollama run llama3.2..." /></label>
                <label>Model<input value={profile.model} onChange={(e) => patchProfile(profile.id, { model: e.target.value })} placeholder="deepseek-chat" /></label>
                <label>Base URL<input value={profile.baseUrl} onChange={(e) => patchProfile(profile.id, { baseUrl: e.target.value })} placeholder="https://api.example.com" /></label>
                <label>API key variable<input value={profile.apiKeyEnv} onChange={(e) => patchProfile(profile.id, { apiKeyEnv: e.target.value })} placeholder="OPENAI_API_KEY" /></label>
                <label>Model variable<input value={profile.modelEnv} onChange={(e) => patchProfile(profile.id, { modelEnv: e.target.value })} placeholder="OPENAI_MODEL" /></label>
                <label>Base URL variable<input value={profile.baseUrlEnv} onChange={(e) => patchProfile(profile.id, { baseUrlEnv: e.target.value })} placeholder="OPENAI_BASE_URL" /></label>
                <label>Full-permission arguments<input value={profile.fullPermissionArgs} onChange={(e) => patchProfile(profile.id, { fullPermissionArgs: e.target.value })} placeholder="--dangerously-skip-permissions" /></label>
              </div>
            </section>
          ))}
        </div>
        <button className="btn" onClick={() => setProfiles((items) => [...items, emptyProfile()])}><Plus size={14} /> Add provider</button>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={async () => { await updateSettings({ providerProfiles: profiles }); onClose() }}>Save providers</button>
        </div>
      </div>
    </div>
  )
}

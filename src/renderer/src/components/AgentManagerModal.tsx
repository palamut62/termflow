import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { CustomAgentDef } from '../../../shared/types'
import { useAppStore } from '../store/appStore'
import { useModalClose } from '../hooks/useModalClose'
import { PROFILES } from '../profiles'
import ConfirmModal from './ConfirmModal'

const emptyAgent = (): CustomAgentDef => ({
  id: crypto.randomUUID(), name: 'New Agent', command: '', fullPermissionArgs: '', color: '#2f80ff'
})

const builtInAgents = PROFILES.filter((profile) => profile.group === 'agent')

function initialAgents(saved: CustomAgentDef[]): CustomAgentDef[] {
  const overrides = new Map(saved.filter((agent) => agent.kind).map((agent) => [agent.kind, agent]))
  const builtIns = builtInAgents.map((profile) => overrides.get(profile.kind) ?? ({
    id: `builtin:${profile.kind}`,
    kind: profile.kind,
    name: profile.label,
    command: profile.startupCommand ?? profile.kind,
    fullPermissionArgs: profile.bypassArgs ?? '',
    color: profile.color
  }))
  return [...builtIns, ...saved.filter((agent) => !agent.kind)]
}

export default function AgentManagerModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [agents, setAgents] = useState<CustomAgentDef[]>(() => initialAgents(settings.customAgents))
  const [pendingDelete, setPendingDelete] = useState<CustomAgentDef | null>(null)
  useModalClose(onClose)

  const patchAgent = (id: string, patch: Partial<CustomAgentDef>): void => {
    setAgents((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item))
  }

  const deleteAgent = (id: string): void => {
    const nextAgents = agents.filter((agent) => agent.id !== id)
    setAgents(nextAgents)
    void updateSettings({ customAgents: nextAgents })
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="modal provider-modal" onMouseDown={(event) => event.stopPropagation()}>
        <h3>AI Agents</h3>
        <p className="help-intro">Add your own agent CLIs (e.g. grok, qoder). Launched in a terminal with the command you provide.</p>
        <div className="provider-list">
          {agents.map((agent) => (
            <section className="provider-card" key={agent.id}>
              <div className="provider-card-head">
                <input value={agent.name} onChange={(e) => patchAgent(agent.id, { name: e.target.value })} aria-label="Agent name" />
                <input type="color" value={agent.color} onChange={(e) => patchAgent(agent.id, { color: e.target.value })} aria-label="Agent color" />
                {agent.kind ? (
                  <span className="kind-tag" title="Built-in agent">Built-in</span>
                ) : (
                  <button className="hbtn danger" title="Delete agent" aria-label={`Delete ${agent.name}`} onClick={() => setPendingDelete(agent)}><Trash2 size={14} /></button>
                )}
              </div>
              <div className="provider-fields">
                <label>Command<input value={agent.command} onChange={(e) => patchAgent(agent.id, { command: e.target.value })} placeholder="grok, qoder..." /></label>
                <label>Full-permission arguments<input value={agent.fullPermissionArgs ?? ''} onChange={(e) => patchAgent(agent.id, { fullPermissionArgs: e.target.value })} placeholder="--dangerously-skip-permissions" /></label>
              </div>
            </section>
          ))}
        </div>
        <button className="btn" onClick={() => setAgents((items) => [...items, emptyAgent()])}><Plus size={14} /> Add agent</button>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={async () => { await updateSettings({ customAgents: agents }); onClose() }}>Save agents</button>
        </div>
      </div>
      {pendingDelete && (
        <ConfirmModal
          title="Delete AI agent?"
          message={`${pendingDelete.name} will be removed from TermFlow.`}
          confirmLabel="Delete agent"
          tone="danger"
          onConfirm={() => deleteAgent(pendingDelete.id)}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  )
}

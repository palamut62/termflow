import { KeyRound, RefreshCw, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { CredentialMeta } from '../../../shared/types'
import { readAgentMetrics } from '../agentMetrics'
import { useAppStore } from '../store/appStore'

export default function AgentOpsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const workspaceId = useAppStore((s) => s.activeWorkspaceId)!
  const [credentials, setCredentials] = useState<CredentialMeta[]>([])
  const [name, setName] = useState(''); const [provider, setProvider] = useState(''); const [envKey, setEnvKey] = useState(''); const [value, setValue] = useState(''); const [global, setGlobal] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const metrics = useMemo(() => readAgentMetrics(workspaceId), [workspaceId, refresh])
  const totals = metrics.reduce((sum, item) => ({ tokens: sum.tokens + item.inputTokens + item.outputTokens, cost: sum.cost + item.estimatedCostUsd, duration: sum.duration + item.durationMs }), { tokens: 0, cost: 0, duration: 0 })
  const reload = async (): Promise<void> => setCredentials(await window.termflow.vault.list(workspaceId))
  useEffect(() => { void reload() }, [workspaceId])
  return <div className="modal-overlay" onMouseDown={onClose}><div className="modal agent-ops" onMouseDown={(e) => e.stopPropagation()}>
    <header className="workbench-head"><div><h3>Agent Operations</h3><span>Usage metrics and encrypted credentials</span></div><button className="hbtn" onClick={onClose}><X size={16} /></button></header>
    <section className="metric-summary"><div><strong>{metrics.length}</strong><span>sessions</span></div><div><strong>{totals.tokens.toLocaleString()}</strong><span>tokens</span></div><div><strong>${totals.cost.toFixed(4)}</strong><span>reported cost</span></div><div><strong>{Math.round(totals.duration / 60000)}m</strong><span>agent time</span></div><button className="hbtn" onClick={() => setRefresh((v) => v + 1)}><RefreshCw size={14} /></button></section>
    <div className="agent-ops-grid"><section><h4>Agent sessions</h4><div className="metric-list">{metrics.map((item) => <div key={`${item.terminalId}:${item.startedAt}`}><strong>{item.agentName}</strong><span>{(item.inputTokens + item.outputTokens).toLocaleString()} tokens</span><span>${item.estimatedCostUsd.toFixed(4)}</span><time>{Math.round(item.durationMs / 1000)}s</time></div>)}</div></section>
    <section><h4>Credential vault</h4><p>Secrets are encrypted by Windows and never returned to the renderer.</p><div className="vault-form"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" /><input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="Provider" /><input value={envKey} onChange={(e) => setEnvKey(e.target.value.toUpperCase())} placeholder="OPENAI_API_KEY" /><input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Secret value" /><label><input type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} />Available to every workspace</label><button className="btn primary" disabled={!name || !envKey || !value} onClick={async () => { await window.termflow.vault.save({ name, provider, envKey, value, workspaceId: global ? null : workspaceId }); setName('');setProvider('');setEnvKey('');setValue('');await reload() }}><KeyRound size={13} />Save encrypted</button></div><div className="vault-list">{credentials.map((item) => <div key={item.id}><KeyRound size={13} /><span><strong>{item.name}</strong><em>{item.provider} · {item.envKey} · {item.workspaceId ? 'workspace' : 'global'}</em></span><button className="hbtn" onClick={async () => { await window.termflow.vault.remove(item.id); await reload() }}><Trash2 size={13} /></button></div>)}</div></section></div>
  </div></div>
}

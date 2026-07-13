import { Plus, Save, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useModalClose } from '../hooks/useModalClose'

type Tab = 'settings' | 'config'

const THEMES = ['dark', 'light', 'dark-daltonized', 'light-daltonized']
const NOTIF_CHANNELS = ['iterm2', 'terminal_bell', 'iterm2_with_bell', 'notifications_disabled']

interface EnvRow {
  key: string
  value: string
}

export default function AgentConfigModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  useModalClose(onClose)
  const [tab, setTab] = useState<Tab>('settings')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  // config (.claude.json)
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [theme, setTheme] = useState('dark')
  const [notifChannel, setNotifChannel] = useState('iterm2')
  const [autoUpdates, setAutoUpdates] = useState(true)
  const [verbose, setVerbose] = useState(false)

  // settings (.claude/settings.json)
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [model, setModel] = useState('')
  const [envRows, setEnvRows] = useState<EnvRow[]>([])
  const [includeCoAuthoredBy, setIncludeCoAuthoredBy] = useState(true)

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await window.termflow.agentConfig.read('config')
        setConfig(cfg)
        if (typeof cfg.theme === 'string') setTheme(cfg.theme)
        if (typeof cfg.preferredNotifChannel === 'string') setNotifChannel(cfg.preferredNotifChannel as string)
        if (typeof cfg.autoUpdates === 'boolean') setAutoUpdates(cfg.autoUpdates)
        if (typeof cfg.verbose === 'boolean') setVerbose(cfg.verbose)
      } catch (e) {
        setError((e as Error).message || 'Failed to read .claude.json')
      }
      try {
        const st = await window.termflow.agentConfig.read('settings')
        setSettings(st)
        if (typeof st.model === 'string') setModel(st.model)
        if (st.env && typeof st.env === 'object' && !Array.isArray(st.env)) {
          setEnvRows(Object.entries(st.env as Record<string, unknown>).map(([key, value]) => ({ key, value: String(value) })))
        }
        if (typeof st.includeCoAuthoredBy === 'boolean') setIncludeCoAuthoredBy(st.includeCoAuthoredBy)
      } catch (e) {
        setError((e as Error).message || 'Failed to read settings.json')
      }
    })()
  }, [])

  const configPreview = { ...config, theme, preferredNotifChannel: notifChannel, autoUpdates, verbose }
  const settingsEnv = envRows.reduce<Record<string, string>>((acc, r) => {
    if (r.key.trim()) acc[r.key.trim()] = r.value
    return acc
  }, {})
  const settingsPreview = { ...settings, model, env: settingsEnv, includeCoAuthoredBy }

  const saveConfig = async (): Promise<void> => {
    setError('')
    setSaved('')
    try {
      const patch = { theme, preferredNotifChannel: notifChannel, autoUpdates, verbose }
      const merged = await window.termflow.agentConfig.write('config', patch)
      setConfig(merged)
      setSaved('Saved — restart claude terminals to apply')
    } catch (e) {
      setError((e as Error).message || 'Failed to write .claude.json')
    }
  }

  const saveSettings = async (): Promise<void> => {
    setError('')
    setSaved('')
    try {
      const patch = { model, env: settingsEnv, includeCoAuthoredBy }
      const merged = await window.termflow.agentConfig.write('settings', patch)
      setSettings(merged)
      setSaved('Saved — restart claude terminals to apply')
    } catch (e) {
      setError((e as Error).message || 'Failed to write settings.json')
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="modal" style={{ width: 560, maxWidth: '92vw' }} onMouseDown={(e) => e.stopPropagation()}>
        <header className="workbench-head">
          <div>
            <h3>Agent Config</h3>
            <span>Claude Code settings & global config</span>
          </div>
          <button className="hbtn" onClick={onClose}><X size={16} /></button>
        </header>

        <div className="tab-bar" style={{ display: 'flex', gap: 6, padding: '8px 12px 0' }}>
          <button className={`tb-btn ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>Settings (.claude/settings.json)</button>
          <button className={`tb-btn ${tab === 'config' ? 'active' : ''}`} onClick={() => setTab('config')}>Config (.claude.json)</button>
        </div>

        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {error && <div style={{ color: '#ff6b6b', fontSize: 12 }}>{error}</div>}
          {saved && <div style={{ color: '#4caf50', fontSize: 12 }}>{saved}</div>}

          {tab === 'settings' && (
            <>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                Model
                <input className="input" value={model} placeholder="claude-sonnet-5" onChange={(e) => setModel(e.target.value)} />
              </label>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                <span>Environment variables</span>
                {envRows.map((row, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6 }}>
                    <input className="input" style={{ flex: 1 }} placeholder="KEY" value={row.key}
                      onChange={(e) => setEnvRows((rows) => rows.map((r, idx) => idx === i ? { ...r, key: e.target.value } : r))} />
                    <input className="input" style={{ flex: 2 }} placeholder="value" value={row.value}
                      onChange={(e) => setEnvRows((rows) => rows.map((r, idx) => idx === i ? { ...r, value: e.target.value } : r))} />
                    <button className="hbtn" title="Remove" onClick={() => setEnvRows((rows) => rows.filter((_, idx) => idx !== i))}><Trash2 size={13} /></button>
                  </div>
                ))}
                <button className="btn" onClick={() => setEnvRows((rows) => [...rows, { key: '', value: '' }])}><Plus size={13} />Add variable</button>
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <input type="checkbox" checked={includeCoAuthoredBy} onChange={(e) => setIncludeCoAuthoredBy(e.target.checked)} />
                Include Co-Authored-By in commits
              </label>

              <button className="btn primary" onClick={() => void saveSettings()}><Save size={13} />Save</button>

              <details>
                <summary style={{ fontSize: 12, cursor: 'pointer' }}>Raw JSON preview</summary>
                <pre style={{ fontSize: 11, maxHeight: 200, overflow: 'auto' }}>{JSON.stringify(settingsPreview, null, 2)}</pre>
              </details>
            </>
          )}

          {tab === 'config' && (
            <>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                Theme
                <select className="input" value={theme} onChange={(e) => setTheme(e.target.value)}>
                  {THEMES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                Preferred notification channel
                <select className="input" value={notifChannel} onChange={(e) => setNotifChannel(e.target.value)}>
                  {NOTIF_CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <input type="checkbox" checked={autoUpdates} onChange={(e) => setAutoUpdates(e.target.checked)} />
                Auto updates
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <input type="checkbox" checked={verbose} onChange={(e) => setVerbose(e.target.checked)} />
                Verbose
              </label>

              <button className="btn primary" onClick={() => void saveConfig()}><Save size={13} />Save</button>

              <details>
                <summary style={{ fontSize: 12, cursor: 'pointer' }}>Raw JSON preview</summary>
                <pre style={{ fontSize: 11, maxHeight: 200, overflow: 'auto' }}>{JSON.stringify(configPreview, null, 2)}</pre>
              </details>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

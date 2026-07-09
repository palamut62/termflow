import { useState } from 'react'
import { useAppStore } from '../store/appStore'
import { TERMINAL_THEMES } from '../themes'
import type { HighlightRule } from '../../../shared/types'

interface Props {
  onClose: () => void
}

const BORDER_COLORS = [
  { label: 'Yellow', value: '#f5e642' },
  { label: 'Blue', value: '#2f80ff' },
  { label: 'Green', value: '#3fb950' },
  { label: 'Purple', value: '#b48ead' },
  { label: 'Red', value: '#ff4d4f' }
]

const SCROLLBACK = [1000, 5000, 10000, 50000, 100000]
const FONT_FAMILIES = [
  "'Cascadia Mono', 'JetBrains Mono', Consolas, monospace",
  "'JetBrains Mono', Consolas, monospace",
  "'Fira Code', Consolas, monospace",
  "Consolas, 'Courier New', monospace",
  "'Source Code Pro', Consolas, monospace"
]

const HIGHLIGHT_COLORS = ['#ff4d4f', '#f6c343', '#3fb950', '#2f80ff', '#b48ead', '#ff6b6b', '#6dd98a']

// Settings: Appearance + Performance + Terminal Theme & Font (PRD §17.2, §20.1)
export default function SettingsModal({ onClose }: Props): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const update = useAppStore((s) => s.updateSettings)
  const highlightRules = useAppStore((s) => s.highlightRules)
  const [activeTab, setActiveTab] = useState<'general' | 'terminal' | 'highlights'>('general')

  const tabs = [
    { key: 'general' as const, label: 'General' },
    { key: 'terminal' as const, label: 'Terminal' },
    { key: 'highlights' as const, label: 'Highlights' }
  ]

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} style={{ width: 540, maxHeight: '85vh', overflow: 'auto' }}>
        <h3>Settings</h3>

        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid var(--border-soft)', paddingBottom: 8 }}>
          {tabs.map((t) => (
            <button
              key={t.key}
              className="btn"
              onClick={() => setActiveTab(t.key)}
              style={{
                background: activeTab === t.key ? 'var(--accent-soft)' : 'transparent',
                borderColor: activeTab === t.key ? 'var(--accent)' : 'transparent'
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* General tab */}
        {activeTab === 'general' && (
          <>
            <div className="field">
              <label>Theme</label>
              <select value={settings.theme} onChange={(e) => update({ theme: e.target.value as 'dark' | 'light' | 'system' })}>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
                <option value="system">System</option>
              </select>
            </div>

            <div className="field">
              <label>Active terminal border color</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {BORDER_COLORS.map((c) => (
                  <button key={c.value} onClick={() => update({ activeBorderColor: c.value })} title={c.label}
                    style={{ width: 30, height: 30, borderRadius: 8, background: c.value,
                      border: settings.activeBorderColor === c.value ? '2px solid var(--text-primary)' : '2px solid transparent' }} />
                ))}
              </div>
            </div>

            <div className="field">
              <label>Scrollback lines</label>
              <select value={settings.scrollback} onChange={(e) => update({ scrollback: Number(e.target.value) })}>
                {SCROLLBACK.map((n) => (<option key={n} value={n}>{n.toLocaleString()} lines</option>))}
              </select>
            </div>

            <div className="field">
              <label>Passive terminal render interval (ms)</label>
              <select value={settings.passiveThrottleMs} onChange={(e) => update({ passiveThrottleMs: Number(e.target.value) })}>
                {[100, 250, 500, 1000].map((n) => (<option key={n} value={n}>{n} ms</option>))}
              </select>
            </div>

            <div className="field" style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={settings.webgl} style={{ width: 'auto' }} onChange={(e) => update({ webgl: e.target.checked })} />
                GPU (WebGL) acceleration
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={settings.snapToGrid} style={{ width: 'auto' }} onChange={(e) => update({ snapToGrid: e.target.checked })} />
                Snap to grid
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={settings.minimap} style={{ width: 'auto' }} onChange={(e) => update({ minimap: e.target.checked })} />
                Mini-map
              </label>
            </div>

            <div className="field">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={settings.agentAutoApprove} style={{ width: 'auto' }}
                  onChange={(e) => update({ agentAutoApprove: e.target.checked })} />
                Launch AI agents with full permissions (bypass approvals)
              </label>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Claude Code <code>--dangerously-skip-permissions</code>, Codex{' '}
                <code>--dangerously-bypass-approvals-and-sandbox</code>
              </p>
            </div>
          </>
        )}

        {/* Terminal tab */}
        {activeTab === 'terminal' && (
          <>
            <div className="field">
              <label>Terminal Theme</label>
              <select value={settings.terminalTheme} onChange={(e) => update({ terminalTheme: e.target.value })}>
                {TERMINAL_THEMES.map((t) => (<option key={t.name} value={t.name}>{t.name}</option>))}
              </select>
            </div>

            <div className="field">
              <label>Font Family</label>
              <select value={settings.fontFamily} onChange={(e) => update({ fontFamily: e.target.value })}>
                {FONT_FAMILIES.map((f) => (<option key={f} value={f}>{f}</option>))}
              </select>
            </div>

            <div className="field">
              <label>Font Size: {settings.fontSize}px</label>
              <input type="range" min={10} max={24} value={settings.fontSize}
                onChange={(e) => update({ fontSize: Number(e.target.value) })} style={{ width: '100%' }} />
            </div>

            <div className="field">
              <label>Line Height: {settings.lineHeight.toFixed(1)}</label>
              <input type="range" min={1.0} max={2.0} step={0.1} value={settings.lineHeight}
                onChange={(e) => update({ lineHeight: Number(e.target.value) })} style={{ width: '100%' }} />
            </div>

            <div className="field">
              <label>Cursor Style</label>
              <select value={settings.cursorStyle} onChange={(e) => update({ cursorStyle: e.target.value as 'block' | 'underline' | 'bar' })}>
                <option value="block">Block</option>
                <option value="underline">Underline</option>
                <option value="bar">Bar</option>
              </select>
            </div>

            <div className="field">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={settings.cursorBlink} style={{ width: 'auto' }}
                  onChange={(e) => update({ cursorBlink: e.target.checked })} />
                Cursor blink
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginLeft: 20 }}>
                <input type="checkbox" checked={settings.ligatures} style={{ width: 'auto' }}
                  onChange={(e) => update({ ligatures: e.target.checked })} />
                Font ligatures
              </label>
            </div>
          </>
        )}

        {/* Highlights tab */}
        {activeTab === 'highlights' && (
          <>
            <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>Highlight Rules</span>
              <button className="btn primary" onClick={async () => {
                const pattern = window.prompt('Regex pattern:')
                if (!pattern) return
                const label = window.prompt('Label (optional):') || pattern
                const wsId = useAppStore.getState().activeWorkspaceId
                await window.termflow.highlightRules.create({
                  pattern, flags: 'gi', color: HIGHLIGHT_COLORS[0],
                  label, workspaceId: wsId, notifyOnMatch: false
                })
                // Reload
                const rules = await window.termflow.highlightRules.list(wsId || undefined)
                useAppStore.setState({ highlightRules: rules })
              }}>Add Rule</button>
            </div>

            {highlightRules.map((rule) => (
              <div key={rule.id} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
                borderBottom: '1px solid var(--border-soft)'
              }}>
                <div style={{ width: 16, height: 16, borderRadius: 4, background: rule.color, flex: 'none' }} />
                <span style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {rule.label || rule.pattern}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace' }}>/{rule.pattern}/{rule.flags}</span>
                <button className="hbtn" title="Delete" onClick={async () => {
                  await window.termflow.highlightRules.remove(rule.id)
                  const wsId = useAppStore.getState().activeWorkspaceId
                  const rules = await window.termflow.highlightRules.list(wsId || undefined)
                  useAppStore.setState({ highlightRules: rules })
                }} style={{ color: 'var(--danger)' }}>×</button>
              </div>
            ))}
            {highlightRules.length === 0 && (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                No highlight rules defined
              </div>
            )}
          </>
        )}

        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12 }}>
          WebGL / scrollback changes apply to new terminals.
        </p>

        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

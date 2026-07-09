import { useAppStore } from '../store/appStore'

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

// Settings: Appearance + Performance (PRD §17.2, §20.1)
export default function SettingsModal({ onClose }: Props): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const update = useAppStore((s) => s.updateSettings)

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} style={{ width: 500 }}>
        <h3>Ayarlar</h3>

        <div className="field">
          <label>Tema</label>
          <select value={settings.theme} onChange={(e) => update({ theme: e.target.value as 'dark' | 'light' | 'system' })}>
            <option value="dark">Koyu</option>
            <option value="light">Açık</option>
            <option value="system">Sistem</option>
          </select>
        </div>

        <div className="field">
          <label>Aktif terminal border rengi</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {BORDER_COLORS.map((c) => (
              <button
                key={c.value}
                onClick={() => update({ activeBorderColor: c.value })}
                title={c.label}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  background: c.value,
                  border:
                    settings.activeBorderColor === c.value
                      ? '2px solid var(--text-primary)'
                      : '2px solid transparent'
                }}
              />
            ))}
          </div>
        </div>

        <div className="field">
          <label>Scrollback satır limiti</label>
          <select value={settings.scrollback} onChange={(e) => update({ scrollback: Number(e.target.value) })}>
            {SCROLLBACK.map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()} satır
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Pasif terminal render aralığı (ms)</label>
          <select
            value={settings.passiveThrottleMs}
            onChange={(e) => update({ passiveThrottleMs: Number(e.target.value) })}
          >
            {[100, 250, 500, 1000].map((n) => (
              <option key={n} value={n}>
                {n} ms
              </option>
            ))}
          </select>
        </div>

        <div className="field" style={{ display: 'flex', gap: 20 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={settings.webgl}
              style={{ width: 'auto' }}
              onChange={(e) => update({ webgl: e.target.checked })}
            />
            GPU (WebGL) hızlandırma
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={settings.snapToGrid}
              style={{ width: 'auto' }}
              onChange={(e) => update({ snapToGrid: e.target.checked })}
            />
            Snap to grid
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={settings.minimap}
              style={{ width: 'auto' }}
              onChange={(e) => update({ minimap: e.target.checked })}
            />
            Mini-map (önizleme)
          </label>
        </div>

        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={settings.agentAutoApprove}
              style={{ width: 'auto' }}
              onChange={(e) => update({ agentAutoApprove: e.target.checked })}
            />
            AI agent&apos;ları tam yetkiyle başlat (bypass permissions)
          </label>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            Claude Code <code>--dangerously-skip-permissions</code>, Codex{' '}
            <code>--dangerously-bypass-approvals-and-sandbox</code> ile açılır.
          </p>
        </div>

        <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          WebGL / scrollback değişiklikleri yeni açılan terminallerde geçerli olur.
        </p>

        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            Kapat
          </button>
        </div>
      </div>
    </div>
  )
}

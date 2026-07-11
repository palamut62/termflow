import { useEffect, useRef, useState } from 'react'
import {
  Plus,
  Bot,
  LayoutGrid,
  Maximize2,
  Columns3,
  Rows3,
  Focus,
  Share2,
  Settings,
  Search,
  ChevronDown,
  Radio
} from 'lucide-react'
import { useAppStore } from '../store/appStore'
import { PROFILES, AGENT_ROLES } from '../profiles'
import CustomCommandModal from './CustomCommandModal'
import type { LayoutMode, ShellKind } from '../../../shared/types'

interface Props {
  canvasSize: () => { width: number; height: number }
  onOpenSettings: () => void
  onOpenPalette: () => void
}

const LAYOUTS: { mode: LayoutMode; label: string; icon: React.JSX.Element }[] = [
  { mode: 'auto_fit', label: 'Auto Fit All', icon: <Maximize2 size={14} /> },
  { mode: 'grid', label: 'Grid', icon: <LayoutGrid size={14} /> },
  { mode: 'columns', label: 'Columns', icon: <Columns3 size={14} /> },
  { mode: 'rows', label: 'Rows', icon: <Rows3 size={14} /> },
  { mode: 'focus', label: 'Focus + Mini', icon: <Focus size={14} /> },
  { mode: 'agent_graph', label: 'Agent Graph', icon: <Share2 size={14} /> },
  { mode: 'manual', label: 'Manual', icon: <LayoutGrid size={14} /> }
]

function useOutside(cb: () => void): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb()
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [cb])
  return ref
}

export default function Toolbar({ canvasSize, onOpenSettings, onOpenPalette }: Props): React.JSX.Element {
  const addTerminal = useAppStore((s) => s.addTerminal)
  const setLayoutMode = useAppStore((s) => s.setLayoutMode)
  const layoutMode = useAppStore((s) => s.layoutMode)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const broadcastEnabled = useAppStore((s) => s.broadcastEnabled)
  const toggleBroadcast = useAppStore((s) => s.toggleBroadcast)
  const sshProfiles = useAppStore((s) => s.sshProfiles)
  const launchSshProfile = useAppStore((s) => s.launchSshProfile)

  const [termMenu, setTermMenu] = useState(false)
  const [agentMenu, setAgentMenu] = useState(false)
  const [layoutMenu, setLayoutMenu] = useState(false)
  const [customModal, setCustomModal] = useState(false)
  const termRef = useOutside(() => setTermMenu(false))
  const agentRef = useOutside(() => setAgentMenu(false))
  const layoutRef = useOutside(() => setLayoutMenu(false))

  const create = (kind: ShellKind): void => {
    setTermMenu(false)
    if (kind === 'custom') setCustomModal(true)
    else addTerminal(kind)
  }

  const shells = PROFILES.filter((p) => p.group === 'shell')
  const agents = PROFILES.filter((p) => p.group === 'agent')
  const disabled = !activeWorkspaceId

  return (
    <div className="toolbar">
      <div className="brand">
        <svg className="logo" viewBox="0 0 512 512" aria-hidden>
          <rect x="24" y="24" width="464" height="464" rx="104" fill="#20242c" stroke="#2f3440" strokeWidth="6" />
          <path d="M136 176l60 60l-60 60" fill="none" stroke="#2f80ff" strokeWidth="34" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M256 316h96" fill="none" stroke="#f5e642" strokeWidth="34" strokeLinecap="round" />
        </svg>
        <span>TermFlow</span>
      </div>

      <div className="tb-group" ref={termRef} style={{ position: 'relative' }}>
        <div className="split-btn">
          <button
            className="tb-btn primary split-main"
            disabled={disabled}
            title="New terminal (CMD)"
            onClick={() => {
              setTermMenu(false)
              addTerminal('cmd')
            }}
          >
            <Plus size={15} /> New Terminal
          </button>
          <button
            className="tb-btn primary split-caret"
            disabled={disabled}
            title="Select terminal type"
            onClick={() => setTermMenu((v) => !v)}
          >
            <ChevronDown size={13} />
          </button>
        </div>
        {termMenu && (
          <div className="menu" style={{ top: 36, left: 0 }}>
            <div className="menu-label">Shells</div>
            {shells.map((p) => (
              <div key={p.kind} className="menu-item" onClick={() => create(p.kind)}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: p.color }} />
                {p.label}
              </div>
            ))}
            <div className="menu-sep" />
            <div className="menu-label">SSH Profiles</div>
            {sshProfiles.length === 0 && <div className="menu-empty">No SSH profiles</div>}
            {sshProfiles.map((profile) => (
              <div
                key={profile.id}
                className="menu-item"
                onClick={() => {
                  setTermMenu(false)
                  launchSshProfile(profile)
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 4, background: '#7b68ee' }} />
                {profile.name}
              </div>
            ))}
            <div className="menu-sep" />
            <div className="menu-label">AI Agents</div>
            {agents.map((p) => (
              <div key={p.kind} className="menu-item" onClick={() => create(p.kind)}>
                <Bot size={14} color={p.color} />
                {p.label}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="tb-group" ref={agentRef} style={{ position: 'relative' }}>
        <button className="tb-btn" disabled={disabled} onClick={() => setAgentMenu((v) => !v)}>
          <Bot size={15} /> New Agent <ChevronDown size={13} />
        </button>
        {agentMenu && (
          <div className="menu" style={{ top: 36, left: 0, maxHeight: 360, overflowY: 'auto' }}>
            <div className="menu-label">Agent Roles</div>
            {AGENT_ROLES.map((r) => (
              <div
                key={r.role}
                className="menu-item"
                onClick={() => {
                  setAgentMenu(false)
                  if (r.defaultKind === 'custom') setCustomModal(true)
                  else addTerminal(r.defaultKind, { agentRole: r.role, name: r.label })
                }}
              >
                <Bot size={14} color={r.color} />
                {r.label}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="tb-group" ref={layoutRef} style={{ position: 'relative' }}>
        <button className="tb-btn" disabled={disabled} onClick={() => setLayoutMenu((v) => !v)}>
          <LayoutGrid size={15} /> Layout <ChevronDown size={13} />
        </button>
        {layoutMenu && (
          <div className="menu" style={{ top: 36, left: 0 }}>
            {LAYOUTS.map((l) => (
              <div
                key={l.mode}
                className="menu-item"
                onClick={() => {
                  setLayoutMode(l.mode, canvasSize())
                  setLayoutMenu(false)
                }}
                style={{ color: layoutMode === l.mode ? 'var(--text-primary)' : undefined }}
              >
                {l.icon}
                {l.label}
                {layoutMode === l.mode && <span style={{ marginLeft: 'auto' }}>✓</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <button className="tb-btn" disabled={disabled} onClick={() => setLayoutMode('auto_fit', canvasSize())}>
        <Maximize2 size={15} /> Auto Fit
      </button>

      <button
        className={`tb-btn ${broadcastEnabled ? 'active' : ''}`}
        disabled={disabled}
        title="Broadcast input to all terminals in group"
        onClick={toggleBroadcast}
      >
        <Radio size={15} /> Broadcast
      </button>

      <div className="spacer" />

      <button className="tb-btn" title="Command Palette (Ctrl+K)" onClick={onOpenPalette}>
        <Search size={15} />
      </button>
      <button className="tb-btn" title="Settings" onClick={onOpenSettings}>
        <Settings size={15} />
      </button>

      {customModal && (
        <CustomCommandModal
          onClose={() => setCustomModal(false)}
          onSubmit={(cmd) => {
            setCustomModal(false)
            addTerminal('custom', { startupCommand: cmd, name: cmd.split(' ')[0] || 'Custom Command' })
          }}
        />
      )}
    </div>
  )
}

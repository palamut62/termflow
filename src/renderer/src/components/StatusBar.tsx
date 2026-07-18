import { Cpu, GitBranch, TerminalSquare, Layers, Unplug, RefreshCw, Download, Power } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { getLeafTerminalIds } from '../paneUtils'
import { useAppStore } from '../store/appStore'
import { APP_VERSION } from '../appInfo'

type UpdateStatus = { status: string; detail?: string }

export default function StatusBar(): React.JSX.Element {
  const nodes = useAppStore((s) => s.nodes)
  const connections = useAppStore((s) => s.connections)
  const terminals = useAppStore((s) => s.terminals)
  const layoutMode = useAppStore((s) => s.layoutMode)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const workspaces = useAppStore((s) => s.workspaces)
  const detectedAgents = useAppStore((s) => s.detectedAgents)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ status: 'idle' })
  const ws = workspaces.find((w) => w.id === activeWorkspaceId)
  const running = Object.values(terminals).filter((t) => t.status === 'running').length
  const agentCount = Object.keys(detectedAgents).length
  const detachedCount = useMemo(() => {
    const attached = new Set(
      nodes.flatMap((node) => (node.panes ? getLeafTerminalIds(node.panes) : node.terminalId ? [node.terminalId] : []))
    )
    return Object.values(terminals).filter((terminal) => !attached.has(terminal.id)).length
  }, [nodes, terminals])

  useEffect(() => window.termflow.updates.onStatus(setUpdateStatus), [])

  const updateLabel = updateStatus.status === 'checking' ? 'Checking for updates...'
    : updateStatus.status === 'available' ? `v${updateStatus.detail ?? ''} available`
      : updateStatus.status === 'downloading' ? `Downloading ${updateStatus.detail ?? ''}`
        : updateStatus.status === 'ready' ? `v${updateStatus.detail ?? ''} ready to install`
          : updateStatus.status === 'current' ? `v${APP_VERSION} · Up to date`
            : updateStatus.status === 'development' ? `v${APP_VERSION} · Development build`
              : updateStatus.status === 'no-releases' ? `v${APP_VERSION} · No release found`
                : updateStatus.status === 'error' ? 'Update check failed'
                  : `v${APP_VERSION}`

  const handleUpdate = async (): Promise<void> => {
    if (updateStatus.status === 'ready') {
      await window.termflow.updates.install()
      return
    }
    setUpdateStatus({ status: 'checking' })
    try {
      const result = await window.termflow.updates.check(settings.updateChannel)
      if (result.status === 'development') setUpdateStatus(result)
    } catch (error) {
      setUpdateStatus({ status: 'error', detail: error instanceof Error ? error.message : 'Unknown error' })
    }
  }

  const toggleAutomaticUpdates = async (): Promise<void> => {
    const enabled = !settings.autoUpdate
    await updateSettings({ autoUpdate: enabled })
    if (enabled) await handleUpdate()
  }

  return (
    <div className="statusbar">
      <span className="sb-item">
        <GitBranch size={12} /> {ws?.name ?? 'No workspace'}
      </span>
      <span className="sb-item">
        <TerminalSquare size={12} /> {nodes.length} panel{nodes.length !== 1 ? 's' : ''} · {running} running
      </span>
      {connections.length > 0 && (
        <span className="sb-item">
          <Layers size={12} /> {connections.length} connection{connections.length !== 1 ? 's' : ''}
        </span>
      )}
      {agentCount > 0 && (
        <span className="sb-item">
          <Layers size={12} /> {agentCount} detected agent{agentCount !== 1 ? 's' : ''}
        </span>
      )}
      {detachedCount > 0 && (
        <button
          className="sb-item sb-btn"
          title="Detached sessions"
          aria-label="Toggle detached sessions"
          onClick={() => window.dispatchEvent(new CustomEvent('termflow:toggle-detached'))}
        >
          <Unplug size={12} /> {detachedCount} detached
        </button>
      )}
      <span className="sb-item" style={{ marginLeft: 'auto' }}>
        <Cpu size={12} /> layout: {layoutMode}
      </span>
      <span className={`sb-update ${updateStatus.status}`} title={updateStatus.detail}>
        <button className="sb-update-main" onClick={() => void handleUpdate()} disabled={['checking', 'downloading'].includes(updateStatus.status)} title={updateStatus.status === 'ready' ? 'Restart and install update' : 'Check for updates'}>
          {updateStatus.status === 'ready' ? <Download size={12} /> : <RefreshCw size={12} className={['checking', 'downloading'].includes(updateStatus.status) ? 'spin' : ''} />}
          {updateLabel}
        </button>
        <button className={`sb-update-auto ${settings.autoUpdate ? 'active' : ''}`} onClick={() => void toggleAutomaticUpdates()} aria-pressed={settings.autoUpdate} title={`Automatic updates: ${settings.autoUpdate ? 'On' : 'Off'}`}>
          <Power size={11} /> Auto {settings.autoUpdate ? 'On' : 'Off'}
        </button>
      </span>
    </div>
  )
}

import { Link, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { getLeafTerminalIds } from '../paneUtils'
import { useAppStore } from '../store/appStore'

export default function DetachedSessionsPanel(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const terminals = useAppStore((s) => s.terminals)
  const nodes = useAppStore((s) => s.nodes)
  const reattach = useAppStore((s) => s.reattachTerminal)
  const detached = useMemo(() => {
    const attached = new Set(nodes.flatMap((node) => node.panes ? getLeafTerminalIds(node.panes) : node.terminalId ? [node.terminalId] : []))
    return Object.values(terminals).filter((terminal) => !attached.has(terminal.id))
  }, [nodes, terminals])

  useEffect(() => {
    const toggle = (): void => setOpen((v) => !v)
    window.addEventListener('termflow:toggle-detached', toggle)
    return () => window.removeEventListener('termflow:toggle-detached', toggle)
  }, [])

  if (!detached.length) return null
  if (!open) return null
  return (
    <aside className="detached-panel">
      <div className="aap-head"><strong>Detached Sessions</strong><button className="hbtn" aria-label="Close detached sessions" onClick={() => setOpen(false)}><X size={14} /></button></div>
      <div className="aap-list">
        {detached.map((terminal) => (
          <button className="detached-item" key={terminal.id} onClick={() => reattach(terminal.id)}>
            <Link size={13} /><span>{terminal.name}</span><em>{terminal.status}</em>
          </button>
        ))}
      </div>
    </aside>
  )
}

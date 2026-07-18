import { useMemo, useState } from 'react'
import { Bot, ListChecks, Wrench, GitBranch, Activity, X } from 'lucide-react'
import { useAppStore, type AgentActivity } from '../store/appStore'

const KIND_ICON: Record<AgentActivity['kind'], React.JSX.Element> = {
  subagent: <Bot size={13} />,
  task: <ListChecks size={13} />,
  tool: <Wrench size={13} />,
  handoff: <GitBranch size={13} />,
  status: <Activity size={13} />
}

const KIND_LABEL: Record<AgentActivity['kind'], string> = {
  subagent: 'Subagent',
  task: 'Task',
  tool: 'Tool',
  handoff: 'Handoff',
  status: 'Status'
}

// Compact relative time — the flow reads as a live feed, so absolute clocks add noise.
function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.max(0, Math.round(diff / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.round(m / 60)}h`
}

/**
 * Per-terminal agent activity panel. Unlike the global AgentActivityPanel, this
 * lives INSIDE a single TerminalView and only surfaces the sub-agents / tasks /
 * tools detected in THAT terminal's output. Collapsed by default; a right-edge
 * tab toggles it. Selecting an agent chip filters the flow to that agent so the
 * user can follow what one sub-agent is doing step by step. (user request)
 */
export default function TerminalAgentPanel({ terminalId }: { terminalId: string }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const activities = useAppStore((s) => s.agentActivities)

  // Only this terminal's events. agentActivities is capped/newest-first upstream.
  const mine = useMemo(
    () => activities.filter((a) => a.terminalId === terminalId),
    [activities, terminalId]
  )

  const agents = useMemo(() => {
    const map = new Map<string, { name: string; count: number }>()
    for (const a of mine) {
      const cur = map.get(a.agentName)
      if (cur) cur.count += 1
      else map.set(a.agentName, { name: a.agentName, count: 1 })
    }
    return Array.from(map.values())
  }, [mine])

  // Nothing detected for this terminal → no toggle, no clutter.
  if (mine.length === 0) return null

  const flow = selected ? mine.filter((a) => a.agentName === selected) : mine

  if (!open) {
    return (
      <button
        className="tap-toggle nodrag nowheel"
        title="Show agent activity"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
      >
        <Bot size={13} />
        <span>{agents.length}</span>
      </button>
    )
  }

  return (
    <aside
      className="terminal-agent-panel nodrag nowheel"
      onMouseDownCapture={(e) => e.stopPropagation()}
      onWheelCapture={(e) => e.stopPropagation()}
    >
      <div className="aap-head">
        <div>
          <strong>Agents</strong>
          <span>
            {agents.length} agent{agents.length !== 1 ? 's' : ''} · {mine.length} event
            {mine.length !== 1 ? 's' : ''}
          </span>
        </div>
        <button className="hbtn" title="Hide panel" onClick={() => setOpen(false)}>
          <X size={14} />
        </button>
      </div>

      <div className="aap-agents">
        <button
          className={`aap-agent ${selected === null ? 'active' : ''}`}
          onClick={() => setSelected(null)}
        >
          <Activity size={13} />
          <span>All</span>
        </button>
        {agents.map((agent) => (
          <button
            key={agent.name}
            className={`aap-agent ${selected === agent.name ? 'active' : ''}`}
            onClick={() => setSelected((s) => (s === agent.name ? null : agent.name))}
          >
            <Bot size={13} />
            <span>{agent.name}</span>
            <em>{agent.count}</em>
          </button>
        ))}
      </div>

      <div className="aap-list">
        {flow.slice(0, 60).map((item) => (
          <div className={`aap-item ${item.kind}`} key={item.id}>
            <div className="aap-icon">{KIND_ICON[item.kind]}</div>
            <div className="aap-copy">
              <div className="aap-meta">
                <span>{item.agentName}</span>
                <em>
                  {KIND_LABEL[item.kind]} · {timeAgo(item.createdAt)}
                </em>
              </div>
              <p>{item.message}</p>
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}

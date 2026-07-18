import { Bot, ListChecks, Wrench, GitBranch, Activity, X } from 'lucide-react'
import { useAppStore, type AgentActivity } from '../store/appStore'

const KIND_ICON: Record<AgentActivity['kind'], React.JSX.Element> = {
  subagent: <Bot size={13} />,
  task: <ListChecks size={13} />,
  tool: <Wrench size={13} />,
  handoff: <GitBranch size={13} />,
  status: <Activity size={13} />
}

export default function AgentActivityPanel(): React.JSX.Element | null {
  const activities = useAppStore((s) => s.agentActivities)
  const detectedAgents = useAppStore((s) => s.detectedAgents)
  const nodes = useAppStore((s) => s.nodes)
  const clear = useAppStore((s) => s.clearAgentActivities)
  const setActiveNode = useAppStore((s) => s.setActiveNode)

  if (activities.length === 0 && Object.keys(detectedAgents).length === 0) return null

  const agents = Object.values(detectedAgents).slice(0, 8)

  return (
    <aside className="agent-activity-panel">
      <div className="aap-head">
        <div>
          <strong>Agent Activity</strong>
          <span>{activities.length} event{activities.length !== 1 ? 's' : ''}</span>
        </div>
        <button className="hbtn" title="Clear activity" onClick={clear}>
          <X size={14} />
        </button>
      </div>

      {agents.length > 0 && (
        <div className="aap-agents">
          {agents.map((agent) => {
            const node = nodes.find((n) => n.id === agent.nodeId)
            return (
              <button
                className="aap-agent"
                key={`${agent.terminalId}:${agent.name}`}
                onClick={() => agent.nodeId && setActiveNode(agent.nodeId)}
              >
                <Bot size={13} />
                <span>{agent.name}</span>
                <em>{node?.title ?? agent.terminalId.slice(0, 8)}</em>
              </button>
            )
          })}
        </div>
      )}

      <div className="aap-list">
        {activities.slice(0, 30).map((item) => {
          const node = nodes.find((n) => n.id === item.nodeId)
          return (
            <button
              className={`aap-item ${item.kind}`}
              key={item.id}
              onClick={() => item.nodeId && setActiveNode(item.nodeId)}
            >
              <div className="aap-icon">{KIND_ICON[item.kind]}</div>
              <div className="aap-copy">
                <div className="aap-meta">
                  <span>{item.agentName}</span>
                  <em>{node?.title ?? item.terminalId.slice(0, 8)}</em>
                </div>
                <p>{item.message}</p>
              </div>
            </button>
          )
        })}
      </div>
    </aside>
  )
}

import type { AgentMetric } from '../../shared/types'

const live = new Map<string, AgentMetric>()
const key = (workspaceId: string): string => `termflow.agentMetrics.${workspaceId}`
const number = (value: string): number => Number(value.replace(/,/g, '')) || 0

export function captureAgentMetric(workspaceId: string, terminalId: string, agentName: string, data: string): void {
  const metric = live.get(terminalId) ?? { terminalId, agentName, startedAt: new Date().toISOString(), durationMs: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
  const input = data.match(/(?:input|prompt)[_\s-]*tokens?\s*[:=]\s*([\d,]+)/i)
  const output = data.match(/(?:output|completion)[_\s-]*tokens?\s*[:=]\s*([\d,]+)/i)
  const total = data.match(/(?:total)[_\s-]*tokens?\s*[:=]\s*([\d,]+)/i)
  const cost = data.match(/(?:cost|usd)\s*[:=]\s*\$?([\d.]+)/i)
  if (input) metric.inputTokens = Math.max(metric.inputTokens, number(input[1]))
  if (output) metric.outputTokens = Math.max(metric.outputTokens, number(output[1]))
  if (total && !input && !output) metric.outputTokens = Math.max(metric.outputTokens, number(total[1]))
  if (cost) metric.estimatedCostUsd = Math.max(metric.estimatedCostUsd, Number(cost[1]) || 0)
  metric.durationMs = Date.now() - new Date(metric.startedAt).getTime()
  live.set(terminalId, metric)
  persist(workspaceId, metric)
}

export function finishAgentMetric(workspaceId: string, terminalId: string): void {
  const metric = live.get(terminalId)
  if (!metric) return
  metric.endedAt = new Date().toISOString(); metric.durationMs = Date.now() - new Date(metric.startedAt).getTime(); persist(workspaceId, metric); live.delete(terminalId)
}

function persist(workspaceId: string, metric: AgentMetric): void {
  const items = readAgentMetrics(workspaceId).filter((item) => item.terminalId !== metric.terminalId || item.startedAt !== metric.startedAt)
  items.unshift({ ...metric }); localStorage.setItem(key(workspaceId), JSON.stringify(items.slice(0, 500)))
}
export function readAgentMetrics(workspaceId: string): AgentMetric[] { try { return JSON.parse(localStorage.getItem(key(workspaceId)) || '[]') as AgentMetric[] } catch { return [] } }

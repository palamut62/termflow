import { Download, PackageOpen, Play, Puzzle, Trash2, Upload, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { TermFlowPluginManifest } from '../../../shared/types'
import { useAppStore } from '../store/appStore'

const manifestExample = '{\n  "schemaVersion": 1,\n  "id": "acme.dev-tools",\n  "name": "ACME Dev Tools",\n  "version": "1.0.0",\n  "commands": [{ "id": "test", "title": "Run tests", "command": "npm test", "shell": "cmd" }]\n}'

export default function PluginManagerModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const addTerminal = useAppStore((s) => s.addTerminal)
  const workspace = useAppStore((s) => s.workspaces.find((item) => item.id === s.activeWorkspaceId))
  const [plugins, setPlugins] = useState<TermFlowPluginManifest[]>([])
  const [message, setMessage] = useState('')
  const reload = async (): Promise<void> => setPlugins(await window.termflow.plugins.list())
  useEffect(() => { void reload() }, [])
  return <div className="modal-overlay" onMouseDown={onClose}><div className="modal plugin-manager" onMouseDown={(e) => e.stopPropagation()}><header className="workbench-head"><div><h3>Extensions & Workflow Packages</h3><span>Manifest-only plugin SDK with explicit terminal commands</span></div><button className="hbtn" onClick={onClose}><X size={16} /></button></header><div className="plugin-toolbar"><button className="btn" onClick={async () => { const installed = await window.termflow.plugins.install(); if (installed) { setMessage(`${installed.name} installed`); await reload() } }}><Download size={13} />Install plugin</button><button className="btn" onClick={() => window.termflow.workflowPackages.export()}><Upload size={13} />Export workflows</button><button className="btn" onClick={async () => { const count = await window.termflow.workflowPackages.import(); setMessage(`${count} workflow templates imported`) }}><PackageOpen size={13} />Import workflows</button><span>{message}</span></div><div className="plugin-list">{plugins.map((plugin) => <section key={plugin.id}><header><Puzzle size={16} /><div><strong>{plugin.name}</strong><span>{plugin.id} · v{plugin.version}</span></div><button className="hbtn" onClick={async () => { await window.termflow.plugins.remove(plugin.id); await reload() }}><Trash2 size={13} /></button></header>{plugin.description && <p>{plugin.description}</p>}<div>{plugin.commands.map((command) => <button className="dev-task" key={command.id} onClick={() => addTerminal(command.shell || 'custom', { name: command.title, startupCommand: command.command, cwd: command.cwd || workspace?.path })}><Play size={12} /><span>{command.title}</span><em>{command.command}</em></button>)}</div></section>)}</div><details className="plugin-sdk"><summary>Plugin SDK manifest example</summary><pre>{manifestExample}</pre></details></div></div>
}

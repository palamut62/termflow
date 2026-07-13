import { AlertTriangle, Download, PackageOpen, Pencil, Plus, Play, Puzzle, Trash2, Upload, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ShellKind, TermFlowPluginManifest } from '../../../shared/types'
import { useAppStore } from '../store/appStore'
import { useModalClose } from '../hooks/useModalClose'

const manifestExample = '{\n  "schemaVersion": 1,\n  "id": "acme.dev-tools",\n  "name": "ACME Dev Tools",\n  "version": "1.0.0",\n  "commands": [{ "id": "test", "title": "Run tests", "command": "npm test", "shell": "cmd" }]\n}'

const SHELL_OPTIONS: ShellKind[] = ['cmd', 'powershell', 'pwsh', 'gitbash', 'wsl', 'custom']
const ID_REGEX = /^[a-z0-9][a-z0-9._-]+$/

type CommandDraft = { id: string; title: string; command: string; shell: ShellKind; cwd: string }

interface FormState {
  editingId: string | null // existing plugin id being edited (id field readonly)
  isBuiltin: boolean
  name: string
  id: string
  idTouched: boolean
  version: string
  description: string
  commands: CommandDraft[]
}

function slugify(name: string): string {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug ? `user.${slug}` : ''
}

function emptyForm(): FormState {
  return { editingId: null, isBuiltin: false, name: '', id: '', idTouched: false, version: '1.0.0', description: '', commands: [{ id: 'cmd-1', title: '', command: '', shell: 'cmd', cwd: '' }] }
}

function formFromPlugin(plugin: TermFlowPluginManifest): FormState {
  return {
    editingId: plugin.id,
    isBuiltin: !!plugin.builtin,
    name: plugin.name,
    id: plugin.id,
    idTouched: true,
    version: plugin.version,
    description: plugin.description || '',
    commands: plugin.commands.map((c, i) => ({ id: c.id || `cmd-${i + 1}`, title: c.title, command: c.command, shell: (c.shell as ShellKind) || 'cmd', cwd: c.cwd || '' }))
  }
}

export default function PluginManagerModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const addTerminal = useAppStore((s) => s.addTerminal)
  const workspace = useAppStore((s) => s.workspaces.find((item) => item.id === s.activeWorkspaceId))
  const [plugins, setPlugins] = useState<TermFlowPluginManifest[]>([])
  const [message, setMessage] = useState('')
  const [form, setForm] = useState<FormState | null>(null)
  const [error, setError] = useState('')
  const reload = async (): Promise<void> => setPlugins(await window.termflow.plugins.list())
  useEffect(() => { void reload() }, [])
  useModalClose(onClose)

  const effectiveId = form ? (form.idTouched ? form.id : slugify(form.name)) : ''
  const idValid = ID_REGEX.test(effectiveId)

  const patch = (p: Partial<FormState>): void => setForm((f) => (f ? { ...f, ...p } : f))
  const setCommand = (index: number, p: Partial<CommandDraft>): void =>
    setForm((f) => (f ? { ...f, commands: f.commands.map((c, i) => (i === index ? { ...c, ...p } : c)) } : f))

  const save = async (): Promise<void> => {
    if (!form) return
    setError('')
    if (!form.name.trim()) { setError('Name is required'); return }
    if (!idValid) { setError('ID must match ^[a-z0-9][a-z0-9._-]+$'); return }
    const commands = form.commands.filter((c) => c.title.trim() && c.command.trim())
    if (commands.length === 0) { setError('At least one command with a title and command is required'); return }
    const manifest: TermFlowPluginManifest = {
      schemaVersion: 1,
      id: form.editingId ?? effectiveId,
      name: form.name.trim(),
      version: form.version.trim() || '1.0.0',
      ...(form.description.trim() ? { description: form.description.trim() } : {}),
      commands: commands.map((c, i) => ({ id: c.id || `cmd-${i + 1}`, title: c.title.trim(), command: c.command.trim(), shell: c.shell, ...(c.cwd.trim() ? { cwd: c.cwd.trim() } : {}) }))
    }
    try {
      const saved = await window.termflow.plugins.save(manifest)
      setMessage(`${saved.name} ${form.editingId ? 'updated' : 'created'}`)
      setForm(null)
      await reload()
    } catch (e) {
      setError((e as Error).message || 'Failed to save plugin')
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="modal plugin-manager" onMouseDown={(e) => e.stopPropagation()}>
        <header className="workbench-head">
          <div><h3>Extensions & Workflow Packages</h3><span>Manifest-only plugin SDK with explicit terminal commands</span></div>
          <button className="hbtn" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="plugin-toolbar">
          <button className="btn" onClick={() => { setError(''); setForm(emptyForm()) }}><Plus size={13} />Create plugin</button>
          <button className="btn" onClick={async () => { const installed = await window.termflow.plugins.install(); if (installed) { setMessage(`${installed.name} installed`); await reload() } }}><Download size={13} />Install plugin</button>
          <button className="btn" onClick={() => window.termflow.workflowPackages.export()}><Upload size={13} />Export workflows</button>
          <button className="btn" onClick={async () => { const count = await window.termflow.workflowPackages.import(); setMessage(`${count} workflow templates imported`) }}><PackageOpen size={13} />Import workflows</button>
          <span>{message}</span>
        </div>
        {form && (
          <div className="plugin-form">
            <div className="plugin-form-warn"><AlertTriangle size={14} /><span>Commands run in a real terminal — only add commands you trust.</span></div>
            <div className="field">
              <label>Name</label>
              <input value={form.name} placeholder="ACME Dev Tools" onChange={(e) => patch({ name: e.target.value })} />
            </div>
            <div className="field">
              <label>ID</label>
              <input value={effectiveId} readOnly={!!form.editingId} placeholder="user.acme-dev-tools" onChange={(e) => patch({ id: e.target.value, idTouched: true })} />
              {!idValid && effectiveId.length > 0 && <small className="plugin-form-err">ID must match ^[a-z0-9][a-z0-9._-]+$</small>}
            </div>
            <div className="field">
              <label>Version</label>
              <input value={form.version} placeholder="1.0.0" onChange={(e) => patch({ version: e.target.value })} />
            </div>
            <div className="field">
              <label>Description (optional)</label>
              <input value={form.description} onChange={(e) => patch({ description: e.target.value })} />
            </div>
            <div className="field">
              <label>Commands</label>
              {form.commands.map((cmd, i) => (
                <div className="plugin-cmd-row" key={cmd.id}>
                  <input value={cmd.title} placeholder="Title" onChange={(e) => setCommand(i, { title: e.target.value })} />
                  <input value={cmd.command} placeholder="Command" onChange={(e) => setCommand(i, { command: e.target.value })} />
                  <select value={cmd.shell} onChange={(e) => setCommand(i, { shell: e.target.value as ShellKind })}>
                    {SHELL_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <input value={cmd.cwd} placeholder="cwd (optional)" onChange={(e) => setCommand(i, { cwd: e.target.value })} />
                  <button className="acfg-iconbtn danger" title="Remove command" disabled={form.commands.length === 1} onClick={() => patch({ commands: form.commands.filter((_, idx) => idx !== i) })}><Trash2 size={13} /></button>
                </div>
              ))}
              <button className="btn" onClick={() => patch({ commands: [...form.commands, { id: `cmd-${Date.now()}`, title: '', command: '', shell: 'cmd', cwd: '' }] })}><Plus size={13} />Add command</button>
            </div>
            {error && <div className="plugin-form-err">{error}</div>}
            <div className="modal-actions">
              <button className="btn" onClick={() => { setForm(null); setError('') }}>Cancel</button>
              <button className="btn primary" onClick={() => void save()}>Save</button>
            </div>
          </div>
        )}
        <div className="plugin-list">{plugins.map((plugin) => (
          <section key={plugin.id}>
            <header>
              <Puzzle size={16} />
              <div><strong>{plugin.name}</strong><span>{plugin.id} · v{plugin.version}{plugin.builtin ? ' · built-in' : ''}</span></div>
              <button className="hbtn" title={plugin.builtin ? 'Customize plugin' : 'Edit plugin'} onClick={() => { setError(''); setForm(formFromPlugin(plugin)) }}><Pencil size={13} /></button>
              {!plugin.builtin && <button className="hbtn" title="Remove plugin" onClick={async () => { await window.termflow.plugins.remove(plugin.id); await reload() }}><Trash2 size={13} /></button>}
            </header>
            {plugin.description && <p>{plugin.description}</p>}
            <div>{plugin.commands.map((command) => <button className="dev-task" key={command.id} onClick={() => addTerminal(command.shell || 'custom', { name: command.title, startupCommand: command.command, cwd: command.cwd || workspace?.path })}><Play size={12} /><span>{command.title}</span><em>{command.command}</em></button>)}</div>
          </section>
        ))}</div>
        <details className="plugin-sdk"><summary>Plugin SDK manifest example</summary><pre>{manifestExample}</pre></details>
      </div>
    </div>
  )
}

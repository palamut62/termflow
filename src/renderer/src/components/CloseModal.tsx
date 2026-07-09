interface Props {
  name: string
  running: boolean
  onTerminate: () => void
  onDetach: () => void
  onClose: () => void
}

// PRD FR-015 — Terminate / Detach / Cancel when closing a running terminal.
export default function CloseModal({ name, running, onTerminate, onDetach, onClose }: Props): React.JSX.Element {
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} style={{ width: 420 }}>
        <h3>Terminali Kapat</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: 12.5, marginBottom: 4 }}>
          <b style={{ color: 'var(--text-primary)' }}>{name}</b>{' '}
          {running ? 'çalışıyor. Ne yapmak istersin?' : 'kapatılsın mı?'}
        </p>
        <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
          <button className="btn" onClick={onClose}>
            İptal
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            {running && (
              <button className="btn" onClick={onDetach} title="Process çalışmaya devam eder, panel kaldırılır">
                Detach
              </button>
            )}
            <button className="btn" style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={onTerminate}>
              Terminate
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

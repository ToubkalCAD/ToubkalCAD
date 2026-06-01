import React, { useEffect, useState } from 'react';
import { useCADStore } from '../../store/cadStore';
import { CADPersistenceService, CADProject } from '../../services/CADPersistenceService';

export const CADProjectPanel: React.FC = () => {
  const nodes   = useCADStore((s) => s.nodes);
  const rootIds = useCADStore((s) => s.rootIds);
  const log     = useCADStore((s) => s.log);

  const [projects,    setProjects]    = useState<CADProject[]>([]);
  const [projectName, setProjectName] = useState('My ToubkalCAD Project');
  const [saving,      setSaving]      = useState(false);
  const [activeId,    setActiveId]    = useState<string | null>(null);

  const loadList = async () => {
    try {
      const list = await CADPersistenceService.listProjects();
      setProjects(list.sort((a, b) => b.updatedAt - a.updatedAt));
    } catch (e) { console.error(e); }
  };

  useEffect(() => { loadList(); }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const id = await CADPersistenceService.saveProject(nodes, rootIds, projectName, activeId ?? undefined);
      setActiveId(id);
      await loadList();
      log(`Project saved: "${projectName}"`, 'success');
    } catch (e: any) {
      log(`Save error: ${e.message}`, 'error');
    } finally { setSaving(false); }
  };

  const handleLoad = (proj: CADProject) => {
    useCADStore.setState({ nodes: proj.nodes, rootIds: proj.rootIds, selectedIds: [] });
    setActiveId(proj.id);
    setProjectName(proj.name);
    log(`Project loaded: "${proj.name}" (WASM geometry must be recreated)`, 'warn');
  };

  const handleDelete = async (id: string, name: string) => {
    await CADPersistenceService.deleteProject(id);
    if (activeId === id) setActiveId(null);
    await loadList();
    log(`Project deleted: "${name}"`, 'warn');
  };

  const handleExportJSON = async () => {
    const id   = await CADPersistenceService.saveProject(nodes, rootIds, projectName, activeId ?? undefined);
    const proj = await CADPersistenceService.loadProject(id);
    if (proj) { CADPersistenceService.exportJSON(proj); log('JSON exported.', 'success'); }
  };

  const handleImportJSON = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const proj = await CADPersistenceService.importJSON(file);
        await CADPersistenceService.saveProject(proj.nodes, proj.rootIds, proj.name, proj.id);
        await loadList();
        log(`Project imported: "${proj.name}"`, 'success');
      } catch (err: any) { log(`Import error: ${err.message}`, 'error'); }
    };
    input.click();
  };

  const objCount = Object.keys(nodes).length;

  return (
    <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: '14px',
                  color: 'var(--text-primary)', fontSize: '12px' }}>

      <Section title="Current project">
        <div style={{ color: 'var(--text-muted)', fontSize: '10px', marginBottom: '6px' }}>
          {objCount} object{objCount !== 1 ? 's' : ''} in scene
          {activeId && (
            <span style={{ color: 'var(--accent)', marginLeft: '6px' }}>
              · ID …{activeId.slice(-6)}
            </span>
          )}
        </div>
        <input
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder="Project name"
          style={inputStyle}
        />
        <div style={{ display: 'flex', gap: '5px', marginTop: '8px' }}>
          <ActionBtn onClick={handleSave} disabled={saving} accent>
            {saving ? '⏳ Saving…' : '↓ Save'}
          </ActionBtn>
          <ActionBtn onClick={handleExportJSON}>↓ JSON</ActionBtn>
          <ActionBtn onClick={handleImportJSON}>↑ JSON</ActionBtn>
        </div>
      </Section>

      <Section title={`Saved projects (${projects.length})`}>
        {projects.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '11px' }}>
            No saved projects.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {projects.map((proj) => {
              const isActive = activeId === proj.id;
              return (
                <div key={proj.id} style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  padding: '6px 8px', borderRadius: 'var(--radius-sm)',
                  background: isActive ? 'var(--sel-bg)'       : 'var(--surface-3)',
                  border:     isActive ? '1px solid var(--sel-border)' : '1px solid var(--border)',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: '11px', color: 'var(--text-primary)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {proj.name}
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                      {new Date(proj.updatedAt).toLocaleString()} ·{' '}
                      {Object.keys(proj.nodes).length} objects
                    </div>
                  </div>
                  <button onClick={() => handleLoad(proj)} style={iconBtnStyle} title="Load">▶</button>
                  <button onClick={() => handleDelete(proj.id, proj.name)}
                          style={{ ...iconBtnStyle, color: 'var(--error)' }} title="Delete">✕</button>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div>
    <div style={{
      fontSize: '9px', color: 'var(--text-muted)', textTransform: 'uppercase',
      letterSpacing: '0.8px', marginBottom: '8px', paddingBottom: '4px',
      borderBottom: '1px solid var(--border)',
    }}>
      {title}
    </div>
    {children}
  </div>
);

const ActionBtn: React.FC<{
  onClick: () => void; disabled?: boolean; accent?: boolean; children: React.ReactNode;
}> = ({ onClick, disabled, accent, children }) => (
  <button onClick={onClick} disabled={disabled} style={{
    fontSize: '11px', padding: '5px 10px', borderRadius: 'var(--radius-sm)',
    cursor: disabled ? 'not-allowed' : 'pointer', flex: 1,
    background: accent ? 'var(--accent)' : 'var(--surface-3)',
    color:      accent ? '#fff'          : 'var(--text-dim)',
    border:     accent ? 'none'          : '1px solid var(--border)',
    opacity: disabled ? 0.5 : 1,
    fontWeight: accent ? 600 : 400,
  }}>
    {children}
  </button>
);

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '5px 8px',
  background: 'var(--surface-1)', border: '1px solid var(--border)',
  color: 'var(--text-primary)', borderRadius: 'var(--radius-sm)',
  fontSize: '11px', boxSizing: 'border-box',
};

const iconBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--text-muted)',
  cursor: 'pointer', fontSize: '13px', padding: '2px 4px',
};

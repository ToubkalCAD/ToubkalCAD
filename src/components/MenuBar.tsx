// ============================================================
// ToubkalCAD – MenuBar.tsx
// Native-style application menu bar (File / Edit / View / Help)
// ============================================================

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useCADStore } from '../store/cadStore';
import { ProjectFileService } from '../services/ProjectFileService';
import { showPrompt, showConfirm } from './AppDialog';
import { OccExchangeService } from '../services/OccExchangeService';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';

interface MenuItem {
  label?:     string;
  shortcut?:  string;
  action?:    () => void;
  separator?: true;
  disabled?:  boolean;
}

interface MenuDef {
  label: string;
  items: MenuItem[];
}

// ─── Dropdown panel ───────────────────────────────────────────────────────────
const Dropdown: React.FC<{
  items: MenuItem[];
  onClose: () => void;
}> = ({ items, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        top: '100%',
        left: 0,
        minWidth: '200px',
        background: 'var(--surface-3)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        boxShadow: 'var(--shadow-md)',
        zIndex: 9000,
        padding: '3px 0',
        animation: 'fadeIn 0.1s ease-out',
      }}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} style={{ height: '1px', background: 'var(--border)', margin: '3px 0' }} />
        ) : (
          <button
            key={i}
            disabled={item.disabled}
            onClick={() => { item.action?.(); onClose(); }}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              width: '100%', padding: '5px 14px',
              background: 'none', border: 'none', cursor: item.disabled ? 'default' : 'pointer',
              color: item.disabled ? 'var(--text-muted)' : 'var(--text-primary)',
              fontSize: '12px', textAlign: 'left' as const, gap: '24px',
            }}
            onMouseEnter={(e) => {
              if (!item.disabled)
                (e.currentTarget as HTMLElement).style.background = 'var(--accent-dim)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'none';
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && (
              <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{item.shortcut}</span>
            )}
          </button>
        )
      )}
    </div>
  );
};

// ─── MenuBar component ────────────────────────────────────────────────────────
export const MenuBar: React.FC = () => {
  const [open, setOpen] = useState<string | null>(null);
  const past   = useCADStore((s) => s.past);
  const future = useCADStore((s) => s.future);
  const undo   = useCADStore((s) => s.undo);
  const redo   = useCADStore((s) => s.redo);
  const nodes  = useCADStore((s) => s.nodes);

  const closeAll = useCallback(() => setOpen(null), []);

  // ─── File actions ─────────────────────────────────────────────────────────
  const hasContent = Object.keys(nodes).length > 0;

  const newProject = useCallback(async () => {
    if (Object.keys(useCADStore.getState().nodes).length > 0 &&
        !(await showConfirm({
          title: 'New Project',
          message: 'Discard the current project and start a new one?',
          confirmLabel: 'Discard',
          danger: true,
        }))) return;
    useCADStore.getState().newProject();
  }, []);

  const openProject = useCallback(async () => {
    try {
      const picked = await ProjectFileService.openDialog();
      if (!picked) return;                       // user cancelled
      useCADStore.getState().loadProject(picked.text);
    } catch (err: any) {
      useCADStore.getState().log(`Open failed: ${err?.message ?? err}`, 'error');
    }
  }, []);

  const saveProject = useCallback(async () => {
    const name = await showPrompt({
      title: 'Save Project',
      label: 'Project name',
      defaultValue: 'Untitled',
      confirmLabel: 'Save',
    });
    if (name === null) return;                   // cancelled
    useCADStore.getState().saveProject(name);
  }, []);

  const exportSTEP = useCallback(() => {
    const oc = window.oc;
    if (!oc) { useCADStore.getState().log('Kernel not ready.', 'error'); return; }
    const { nodes: ns, rootIds } = useCADStore.getState();
    const reg = CADGeometryRegistry.getInstance();
    try {
      const data = OccExchangeService.exportProjectSTEP(oc, ns, rootIds, (id) => reg.getShape(id));
      const url  = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/octet-stream' }));
      const a    = document.createElement('a');
      a.href = url;
      a.download = `toubkalcad_${Date.now()}.step`;
      a.click();
      URL.revokeObjectURL(url);
      useCADStore.getState().log('STEP export successful.', 'success');
    } catch (err: any) {
      useCADStore.getState().log(`STEP export failed: ${err?.message ?? err}`, 'error');
    }
  }, []);

  const menus: MenuDef[] = [
    {
      label: 'File',
      items: [
        { label: 'New Project',    shortcut: 'Ctrl+N', action: newProject },
        { label: 'Open Project…',  shortcut: 'Ctrl+O', action: openProject },
        { separator: true },
        { label: 'Save Project',   shortcut: 'Ctrl+S', action: saveProject, disabled: !hasContent },
        { label: 'Export STEP…',   action: exportSTEP, disabled: !hasContent },
        { separator: true },
        { label: 'Preferences…', action: () => { /* TODO */ } },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Ctrl+Z', action: undo, disabled: past.length === 0 },
        { label: 'Redo', shortcut: 'Ctrl+Y', action: redo, disabled: future.length === 0 },
        { separator: true },
        {
          label: 'Select All',
          shortcut: 'Ctrl+A',
          action: () => useCADStore.getState().setSelectedIds(Object.keys(nodes)),
          disabled: Object.keys(nodes).length === 0,
        },
        {
          label: 'Deselect All',
          shortcut: 'Esc',
          action: () => useCADStore.getState().setSelectedIds([]),
        },
        { separator: true },
        {
          label: 'Delete Selected',
          shortcut: 'Del',
          disabled: useCADStore.getState().selectedIds.length === 0,
          action: () => {
            const { selectedIds, deleteNode } = useCADStore.getState();
            selectedIds.forEach((id) => {
              deleteNode(id);
              window.dispatchEvent(new CustomEvent('cad-remove-mesh', { detail: { id } }));
            });
          },
        },
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Perspective',   shortcut: 'Num 0', action: () => window.dispatchEvent(new CustomEvent('cad-view-preset', { detail: 'PERSPECTIVE' })) },
        { label: 'Top',           shortcut: 'Num 7', action: () => window.dispatchEvent(new CustomEvent('cad-view-preset', { detail: 'TOP' })) },
        { label: 'Front',         shortcut: 'Num 1', action: () => window.dispatchEvent(new CustomEvent('cad-view-preset', { detail: 'FRONT' })) },
        { label: 'Right',         shortcut: 'Num 3', action: () => window.dispatchEvent(new CustomEvent('cad-view-preset', { detail: 'RIGHT' })) },
        { label: 'Isometric',     shortcut: 'Num 5', action: () => window.dispatchEvent(new CustomEvent('cad-view-preset', { detail: 'ISOMETRIC' })) },
        { separator: true },
        { label: 'Frame Selected', shortcut: 'F',       action: () => window.dispatchEvent(new CustomEvent('cad-frame-selection')) },
        { label: 'Fit All',        shortcut: 'Shift+F', action: () => window.dispatchEvent(new CustomEvent('cad-frame-all')) },
      ],
    },
    {
      label: 'Help',
      items: [
        { label: 'Keyboard Shortcuts', action: () => window.dispatchEvent(new CustomEvent('cad-show-shortcuts')) },
        { separator: true },
        { label: 'About ToubkalCAD',   action: () => { /* TODO */ } },
      ],
    },
  ];

  return (
    <div style={{
      display: 'flex', alignItems: 'stretch',
      height: '100%',
      position: 'relative',
    }}>
      {menus.map((menu) => (
        <div key={menu.label} style={{ position: 'relative' }}>
          <button
            onClick={() => setOpen(open === menu.label ? null : menu.label)}
            style={{
              height: '100%',
              padding: '0 11px',
              background: open === menu.label ? 'var(--surface-4)' : 'none',
              border: 'none',
              color: open === menu.label ? 'var(--text-primary)' : 'var(--text-dim)',
              cursor: 'pointer',
              fontSize: '12px',
              letterSpacing: '0.1px',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'var(--surface-4)';
              (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)';
              if (open && open !== menu.label) setOpen(menu.label);
            }}
            onMouseLeave={(e) => {
              if (open !== menu.label) {
                (e.currentTarget as HTMLElement).style.background = 'none';
                (e.currentTarget as HTMLElement).style.color = 'var(--text-dim)';
              }
            }}
          >
            {menu.label}
          </button>
          {open === menu.label && (
            <Dropdown items={menu.items} onClose={closeAll} />
          )}
        </div>
      ))}
    </div>
  );
};

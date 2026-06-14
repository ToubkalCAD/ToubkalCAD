// ============================================================
// ToubkalCAD – ParameterModal.tsx
// Imperative Promise-based modal replacing browser prompt().
// Usage: const vals = await showParamModal('Create Box', fields);
//        if (!vals) return; // user cancelled
// ============================================================

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

export interface ParamField {
  key:     string;
  label:   string;
  default: number;
  min?:    number;
  max?:    number;
  step?:   number;
  unit?:   string;
}

interface ModalState {
  title:   string;
  fields:  ParamField[];
  confirmLabel: string;
  resolve: (v: Record<string, number> | null) => void;
}

// Module-level registry — one modal at a time
let _openModal: ((s: ModalState) => void) | null = null;

export function showParamModal(
  title: string,
  fields: ParamField[],
  confirmLabel = 'Create',
): Promise<Record<string, number> | null> {
  return new Promise((resolve) => {
    _openModal?.({ title, fields, confirmLabel, resolve });
  });
}

export const ParameterModal: React.FC = () => {
  const [state, setState] = useState<ModalState | null>(null);
  const [vals,  setVals]  = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    _openModal = setState;
    return () => { _openModal = null; };
  }, []);

  useEffect(() => {
    if (state) {
      const d: Record<string, string> = {};
      state.fields.forEach((f) => { d[f.key] = String(f.default); });
      setVals(d);
      setErrors({});
      requestAnimationFrame(() => {
        firstRef.current?.focus();
        firstRef.current?.select();
      });
    }
  }, [state?.title]);

  const confirm = useCallback(() => {
    if (!state) return;
    const result: Record<string, number> = {};
    const errs: Record<string, boolean> = {};
    let valid = true;
    for (const f of state.fields) {
      const v = parseFloat(vals[f.key] ?? '');
      if (isNaN(v) || (f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) {
        errs[f.key] = true;
        valid = false;
      } else {
        result[f.key] = v;
      }
    }
    if (!valid) { setErrors(errs); return; }
    state.resolve(result);
    setState(null);
  }, [state, vals]);

  const cancel = useCallback(() => {
    state?.resolve(null);
    setState(null);
  }, [state]);

  if (!state) return null;

  return createPortal(
    <div className="cad-modal-overlay" onClick={cancel}>
      <div
        className="cad-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter')  confirm();
          if (e.key === 'Escape') cancel();
        }}
      >
        {/* Header */}
        <div style={{
          padding: '11px 16px',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontWeight: 600, fontSize: '12px', color: 'var(--text-primary)', letterSpacing: '0.2px' }}>
            {state.title}
          </span>
          <button
            onClick={cancel}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: '2px 4px' }}
          >
            ✕
          </button>
        </div>

        {/* Fields */}
        <div style={{ padding: '16px 16px 12px', display: 'flex', flexDirection: 'column', gap: '11px' }}>
          {state.fields.map((f, i) => (
            <div key={f.key}>
              <label style={{
                display: 'block', fontSize: '10px', color: 'var(--text-dim)',
                textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '5px',
              }}>
                {f.label}{f.unit ? ` (${f.unit})` : ''}
              </label>
              <input
                ref={i === 0 ? firstRef : undefined}
                type="number"
                value={vals[f.key] ?? f.default}
                onChange={(e) => {
                  setVals((p) => ({ ...p, [f.key]: e.target.value }));
                  if (errors[f.key]) setErrors((p) => ({ ...p, [f.key]: false }));
                }}
                min={f.min}
                max={f.max}
                step={f.step ?? 0.1}
                style={{
                  width: '100%',
                  background: 'var(--surface-3)',
                  border: `1px solid ${errors[f.key] ? 'var(--error)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)',
                  padding: '6px 9px',
                  fontSize: '12px',
                  outline: 'none',
                  transition: 'border-color 0.12s',
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = 'var(--accent)';
                  e.target.select();
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = errors[f.key] ? 'var(--error)' : 'var(--border)';
                }}
              />
              {errors[f.key] && (
                <span style={{ fontSize: '10px', color: 'var(--error)', marginTop: '3px', display: 'block' }}>
                  Invalid value{f.min !== undefined ? ` (min ${f.min})` : ''}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{
          padding: '10px 16px',
          borderTop: '1px solid var(--border)',
          display: 'flex', gap: '8px', justifyContent: 'flex-end',
        }}>
          <button
            onClick={cancel}
            style={{
              padding: '5px 16px',
              background: 'none',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-dim)',
              cursor: 'pointer',
              fontSize: '11px',
            }}
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            style={{
              padding: '5px 16px',
              background: 'var(--accent)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              color: '#fff',
              cursor: 'pointer',
              fontSize: '11px',
              fontWeight: 600,
            }}
          >
            {state.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

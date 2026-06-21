// ============================================================
// ToubkalCAD – AppDialog.tsx
// Imperative Promise-based text-prompt + confirm dialogs that replace the
// browser's native window.prompt()/window.confirm() (which render as ugly
// "localhost:8080 says…" chrome). Styled to match the rest of the app, reusing
// the same .cad-modal-overlay / .cad-modal CSS as ParameterModal.
//
// Usage:
//   const name = await showPrompt({ title: 'Save Project', label: 'Project name', defaultValue: 'Untitled' });
//   if (name === null) return;                      // cancelled
//   if (await showConfirm({ title: 'New Project', message: 'Discard…?', danger: true })) { … }
//
// Mount a single <AppDialog /> once at the app root (alongside <ParameterModal />).
// ============================================================

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

interface PromptOpts {
  title:         string;
  label?:        string;
  defaultValue?: string;
  placeholder?:  string;
  confirmLabel?: string;
}
interface ConfirmOpts {
  title:         string;
  message:       string;
  confirmLabel?: string;
  cancelLabel?:  string;
  danger?:       boolean;
}

type DialogState =
  | { kind: 'prompt';  title: string; label?: string; value: string; placeholder?: string;
      confirmLabel: string; resolve: (v: string | null) => void }
  | { kind: 'confirm'; title: string; message: string; confirmLabel: string; cancelLabel: string;
      danger: boolean; resolve: (v: boolean) => void };

// Module-level registry — one dialog at a time (matches ParameterModal).
let _open: ((s: DialogState) => void) | null = null;

export function showPrompt(opts: PromptOpts): Promise<string | null> {
  return new Promise((resolve) => {
    _open?.({
      kind: 'prompt',
      title: opts.title,
      label: opts.label,
      value: opts.defaultValue ?? '',
      placeholder: opts.placeholder,
      confirmLabel: opts.confirmLabel ?? 'OK',
      resolve,
    });
  });
}

export function showConfirm(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    _open?.({
      kind: 'confirm',
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? 'OK',
      cancelLabel: opts.cancelLabel ?? 'Cancel',
      danger: opts.danger ?? false,
      resolve,
    });
  });
}

const btnBase: React.CSSProperties = {
  padding: '5px 16px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
  fontSize: '11px',
};

export const AppDialog: React.FC = () => {
  const [state, setState] = useState<DialogState | null>(null);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    _open = (s) => { setState(s); if (s.kind === 'prompt') setValue(s.value); };
    return () => { _open = null; };
  }, []);

  useEffect(() => {
    if (state?.kind === 'prompt') {
      requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
    }
  }, [state]);

  const close = useCallback(() => setState(null), []);

  const confirm = useCallback(() => {
    if (!state) return;
    if (state.kind === 'prompt') {
      if (!value.trim()) return;                    // require a non-empty name
      state.resolve(value);
    } else {
      state.resolve(true);
    }
    close();
  }, [state, value, close]);

  const cancel = useCallback(() => {
    if (!state) return;
    if (state.kind === 'prompt') state.resolve(null);
    else state.resolve(false);
    close();
  }, [state, close]);

  if (!state) return null;

  const confirmDisabled = state.kind === 'prompt' && !value.trim();
  const confirmBg = state.kind === 'confirm' && state.danger ? 'var(--error)' : 'var(--accent)';

  return createPortal(
    <div className="cad-modal-overlay" onClick={cancel}>
      <div
        className="cad-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter')  { e.preventDefault(); confirm(); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
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

        {/* Body */}
        <div style={{ padding: '16px' }}>
          {state.kind === 'prompt' ? (
            <>
              {state.label && (
                <label style={{
                  display: 'block', fontSize: '10px', color: 'var(--text-dim)',
                  textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px',
                }}>
                  {state.label}
                </label>
              )}
              <input
                ref={inputRef}
                type="text"
                value={value}
                placeholder={state.placeholder}
                onChange={(e) => setValue(e.target.value)}
                style={{
                  width: '100%',
                  background: 'var(--surface-3)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)',
                  padding: '7px 9px',
                  fontSize: '12px',
                  outline: 'none',
                  transition: 'border-color 0.12s',
                }}
                onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; }}
                onBlur={(e) => { e.target.style.borderColor = 'var(--border)'; }}
              />
            </>
          ) : (
            <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-primary)', lineHeight: 1.5 }}>
              {state.message}
            </p>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '10px 16px',
          borderTop: '1px solid var(--border)',
          display: 'flex', gap: '8px', justifyContent: 'flex-end',
        }}>
          <button
            onClick={cancel}
            style={{ ...btnBase, background: 'none', border: '1px solid var(--border)', color: 'var(--text-dim)' }}
          >
            {state.kind === 'confirm' ? state.cancelLabel : 'Cancel'}
          </button>
          <button
            onClick={confirm}
            disabled={confirmDisabled}
            style={{
              ...btnBase,
              background: confirmDisabled ? 'var(--surface-4)' : confirmBg,
              border: 'none',
              color: confirmDisabled ? 'var(--text-muted)' : '#fff',
              fontWeight: 600,
              cursor: confirmDisabled ? 'default' : 'pointer',
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

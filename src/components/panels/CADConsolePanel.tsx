// ============================================================
// ToubkalCAD – CADConsolePanel.tsx
// Real-time log viewer with level filters.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { useCADStore, LogEntry } from '../../store/cadStore';

const LEVEL_COLORS: Record<LogEntry['level'], string> = {
  info:    'var(--text-dim)',
  warn:    'var(--warn)',
  error:   'var(--error)',
  success: 'var(--success)',
};
const LEVEL_ICONS: Record<LogEntry['level'], string> = {
  info:    'ℹ',
  warn:    '⚠',
  error:   '✖',
  success: '✔',
};

export const CADConsolePanel: React.FC = () => {
  const logs      = useCADStore((s) => s.logs);
  const clearLogs = useCADStore((s) => s.clearLogs);
  const [filter, setFilter] = useState<LogEntry['level'] | 'all'>('all');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const visible = filter === 'all' ? logs : logs.filter((l) => l.level === filter);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      {/* Filter bar */}
      <div style={{
        display: 'flex', gap: '5px', padding: '4px 8px',
        borderBottom: '1px solid var(--border)',
        alignItems: 'center', flexShrink: 0,
      }}>
        <span style={{ fontSize: '9px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px', marginRight: '2px' }}>
          Filter
        </span>
        {(['all', 'info', 'success', 'warn', 'error'] as const).map((lvl) => (
          <button
            key={lvl}
            onClick={() => setFilter(lvl)}
            style={{
              fontSize: '10px', padding: '2px 7px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
              border:     filter === lvl ? '1px solid var(--accent)' : '1px solid var(--border)',
              background: filter === lvl ? 'var(--accent-dim)' : 'transparent',
              color:      lvl === 'all' ? 'var(--text-dim)' : LEVEL_COLORS[lvl as LogEntry['level']],
            }}
          >
            {lvl === 'all' ? 'All' : `${LEVEL_ICONS[lvl as LogEntry['level']]} ${lvl}`}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{visible.length}</span>
        <button
          onClick={clearLogs}
          style={{
            fontSize: '10px', padding: '2px 7px', borderRadius: 'var(--radius-sm)',
            background: 'transparent', border: '1px solid var(--border)',
            color: 'var(--text-muted)', cursor: 'pointer',
          }}
        >
          Clear
        </button>
      </div>

      {/* Log entries */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '2px 0', fontFamily: 'monospace' }}>
        {visible.map((entry) => {
          const d  = new Date(entry.timestamp);
          const ts = `${d.getHours().toString().padStart(2,'0')}:${
                      d.getMinutes().toString().padStart(2,'0')}:${
                      d.getSeconds().toString().padStart(2,'0')}`;
          return (
            <div
              key={entry.id}
              style={{
                display: 'flex', gap: '8px', padding: '2px 8px',
                fontSize: '11px', lineHeight: '1.5',
                borderBottom: '1px solid rgba(255,255,255,0.03)',
              }}
            >
              <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{ts}</span>
              <span style={{ color: LEVEL_COLORS[entry.level], flexShrink: 0 }}>
                {LEVEL_ICONS[entry.level]}
              </span>
              <span style={{ color: LEVEL_COLORS[entry.level] }}>{entry.message}</span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};

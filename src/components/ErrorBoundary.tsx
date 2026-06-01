import React from 'react';

interface Props {
  children: React.ReactNode;
  label?: string;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary: ${this.props.label ?? 'Panel'}]`, error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: '16px',
          display: 'flex', flexDirection: 'column', gap: '8px',
          color: 'var(--error)', fontSize: '11px',
          fontFamily: 'monospace',
        }}>
          <div style={{ fontWeight: 600 }}>⚠ Panel crashed: {this.props.label ?? 'Unknown'}</div>
          <div style={{ color: 'var(--text-muted)', whiteSpace: 'pre-wrap', fontSize: '10px' }}>
            {this.state.error.message}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              alignSelf: 'flex-start', padding: '4px 12px',
              background: 'var(--surface-3)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)', color: 'var(--text-dim)',
              cursor: 'pointer', fontSize: '10px',
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

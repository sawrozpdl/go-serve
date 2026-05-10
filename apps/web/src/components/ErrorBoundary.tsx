import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Top-level safety net. Without this, an uncaught render error blanks the
 * page. With it, the user gets a recoverable screen with a "reload" button.
 *
 * Console-logs the error so the dev tools still see it; we don't ship the
 * stack to a third-party service in v1.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="login-shell">
        <div className="login-card" role="alert">
          <h1>something broke.</h1>
          <p className="sub">unexpected error</p>
          <p
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--ink-300)',
              padding: '10px 12px',
              background: 'var(--ink-1000)',
              border: '1px solid var(--ink-700)',
              borderRadius: 2,
              wordBreak: 'break-word',
              maxHeight: 160,
              overflowY: 'auto',
            }}
          >
            {this.state.error.message || 'unknown'}
          </p>
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button
              type="button"
              className="btn"
              onClick={() => {
                this.reset();
                location.reload();
              }}
            >
              Reload
            </button>
            <button type="button" className="btn primary" onClick={this.reset}>
              Try again
            </button>
          </div>
          <p className="hint">
            If this keeps happening, sign out and back in, or contact support.
          </p>
        </div>
      </div>
    );
  }
}

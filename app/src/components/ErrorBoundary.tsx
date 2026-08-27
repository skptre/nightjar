import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

function isDatabaseError(error: Error | null): boolean {
  if (!error) return false;
  const msg = error.message.toLowerCase();
  return msg.includes('database') || msg.includes('sqlite') || msg.includes('indexeddb')
    || msg.includes('sql.js') || msg.includes('schema');
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled error:', error, info);
  }

  private handleResetDatabase = (): void => {
    const confirmed = window.confirm(
      'This will clear all local data (cached postings, applications, notes). Your profile will be preserved. Continue?',
    );
    if (!confirmed) return;

    try {
      const req = indexedDB.deleteDatabase('nightjar');
      req.onsuccess = () => window.location.reload();
      req.onerror = () => window.location.reload();
    } catch {
      window.location.reload();
    }
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      const isDbError = isDatabaseError(this.state.error);

      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
          <div className="text-center p-8 max-w-md">
            <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
              <svg className="w-6 h-6 text-red-600 dark:text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-red-600 dark:text-red-400">
              {isDbError ? 'Database Error' : 'Something went wrong'}
            </h1>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              {isDbError
                ? 'The local database may be corrupted. You can try reloading, or reset the database to start fresh.'
                : 'An unexpected error occurred. Try reloading the page.'}
            </p>
            <pre className="mt-3 text-xs text-gray-500 dark:text-gray-500 max-w-lg overflow-auto bg-gray-100 dark:bg-gray-900 p-2 rounded text-left">
              {this.state.error?.message}
            </pre>
            <div className="mt-6 flex gap-3 justify-center">
              <button
                className="px-4 py-2 bg-violet-600 text-white rounded-md hover:bg-violet-700 text-sm font-medium transition-colors"
                onClick={() => this.setState({ hasError: false, error: null })}
              >
                Try again
              </button>
              {isDbError && (
                <button
                  className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 text-sm font-medium transition-colors"
                  onClick={this.handleResetDatabase}
                >
                  Reset database
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

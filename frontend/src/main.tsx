import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from './App';
import './index.css';

const qc = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

// Without a boundary, an uncaught render error unmounts the whole tree and
// leaves just the dark <body> background — the "screen blacks out" symptom.
// This boundary prints the error inline so the cause is visible.
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('Render error:', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-neutral-950 text-neutral-100 p-6 font-mono text-sm">
          <div className="max-w-3xl mx-auto space-y-4">
            <div className="text-red-400 font-semibold">Render error</div>
            <pre className="bg-neutral-900 border border-neutral-800 rounded p-3 whitespace-pre-wrap break-words">
              {this.state.error.name}: {this.state.error.message}
              {this.state.error.stack && '\n\n' + this.state.error.stack}
            </pre>
            <button
              onClick={() => this.setState({ error: null })}
              className="px-3 py-1.5 rounded bg-accent text-white text-xs"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </QueryClientProvider>
  </React.StrictMode>,
);

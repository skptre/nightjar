import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ToastProvider } from '@/components/Toast';
import { DatabaseProvider } from '@/providers/DatabaseProvider';
import { ProfileProvider } from '@/providers/ProfileProvider';
import { SyncProvider } from '@/providers/SyncProvider';
import { App } from '@/App';
import '@fontsource-variable/geist';
import './index.css';
import { applyAppearance } from '@/hooks/useAppearance';
import { restoreDestination } from '@/lib/startup';
applyAppearance();
restoreDestination();
// A launch must never clear personal data. Explicit Settings actions own resets.

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <ToastProvider>
          <DatabaseProvider>
            <ProfileProvider>
              <SyncProvider>
                <App />
              </SyncProvider>
            </ProfileProvider>
          </DatabaseProvider>
        </ToastProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ToastProvider } from '@/components/Toast';
import { DatabaseProvider } from '@/providers/DatabaseProvider';
import { ProfileProvider } from '@/providers/ProfileProvider';
import { SyncProvider } from '@/providers/SyncProvider';
import { App } from '@/App';
import './index.css';
import { applyAppearance } from '@/hooks/useAppearance';
applyAppearance();
const lastDestination = localStorage.getItem('nightjar_last_destination');
if (window.location.pathname === '/' && lastDestination && ['/jobs', '/applications'].includes(lastDestination)
  && localStorage.getItem('nightjar_onboarding_dismissed') === 'true') {
  window.history.replaceState(null, '', lastDestination);
}

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

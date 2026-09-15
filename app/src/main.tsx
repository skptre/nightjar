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
// FOR NOW: every launch starts fresh on the landing page with no remembered
// personalization, filters, or last destination. The local tracker (applications,
// watched companies, cached postings) is preserved — only profile/session UI resets.
try {
  localStorage.removeItem('nightjar_profile');
  localStorage.removeItem('nightjar_onboarding_dismissed');
  localStorage.removeItem('nightjar_last_destination');
} catch { /* localStorage unavailable */ }
if (window.location.pathname !== '/') {
  window.history.replaceState(null, '', '/');
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

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { DatabaseProvider } from '@/providers/DatabaseProvider';
import { ProfileProvider } from '@/providers/ProfileProvider';
import { SyncProvider } from '@/providers/SyncProvider';
import { App } from '@/App';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <DatabaseProvider>
          <ProfileProvider>
            <SyncProvider>
              <App />
            </SyncProvider>
          </ProfileProvider>
        </DatabaseProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);

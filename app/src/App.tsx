import { Navigate, Routes, Route } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { FeedView } from '@/views/Feed/FeedView';
import { PipelineView } from '@/views/Pipeline/PipelineView';
import { SettingsView } from '@/views/Settings/SettingsView';
import { HomeView } from '@/views/Home/HomeView';

export function App(): React.ReactNode {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<HomeView />} />
        <Route path="/jobs" element={<FeedView />} />
        <Route path="/applications" element={<PipelineView />} />
        <Route path="/settings" element={<SettingsView />} />
        <Route path="/pipeline" element={<Navigate to="/applications" replace />} />
        <Route path="/calendar" element={<Navigate to="/" replace />} />
        <Route path="/companies/*" element={<Navigate to="/" replace />} />
        <Route path="/insights" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

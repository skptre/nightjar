import { Routes, Route } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { FeedView } from '@/views/Feed/FeedView';
import { PipelineView } from '@/views/Pipeline/PipelineView';
import { CalendarView } from '@/views/Calendar/CalendarView';
import { CompaniesView } from '@/views/Companies/CompaniesView';
import { CompanyDetail } from '@/views/Companies/CompanyDetail';
import { SettingsView } from '@/views/Settings/SettingsView';
import { InsightsView } from '@/views/Insights/InsightsView';

export function App(): React.ReactNode {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<FeedView />} />
        <Route path="/pipeline" element={<PipelineView />} />
        <Route path="/calendar" element={<CalendarView />} />
        <Route path="/companies" element={<CompaniesView />} />
        <Route path="/companies/:slug" element={<CompanyDetail />} />
        <Route path="/settings" element={<SettingsView />} />
        <Route path="/insights" element={<InsightsView />} />
      </Routes>
    </Layout>
  );
}

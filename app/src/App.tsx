import { Routes, Route } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { FeedView } from '@/views/Feed/FeedView';
import { PipelineView } from '@/views/Pipeline/PipelineView';
import { CompaniesView } from '@/views/Companies/CompaniesView';

export function App(): React.ReactNode {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<FeedView />} />
        <Route path="/pipeline" element={<PipelineView />} />
        <Route path="/companies" element={<CompaniesView />} />
      </Routes>
    </Layout>
  );
}

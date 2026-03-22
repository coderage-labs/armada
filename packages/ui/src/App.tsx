import './i18n';
import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './app/query-client';
import { SSEProvider } from './providers/SSEProvider';
import { OperationsProvider } from './contexts/OperationsContext';
import { OperationsBar } from './components/OperationsBar';
import { AuthProvider } from './hooks/useAuth';
import { prewarmUsers } from './hooks/useUsers';
import { ErrorBoundary } from './components/ErrorBoundary';

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.querySelector('main')?.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function AnimatedRoutes() {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
      >
        <Routes location={location}>
            <Route path="/operations" element={<Operations />} />
            <Route path="/changesets" element={<Changesets />} />
            <Route path="/" element={<Dashboard />} />
            <Route path="/nodes" element={<Nodes />} />
            <Route path="/nodes/:id" element={<NodeDetail />} />
            <Route path="/instances" element={<Instances />} />
            <Route path="/instances/:id" element={<InstanceDetail />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/agents/:name" element={<AgentDetail />} />
            <Route path="/templates" element={<Templates />} />
            <Route path="/templates/new" element={<TemplateEditor />} />
            <Route path="/templates/:id/edit" element={<TemplateEditor />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/:id" element={<ProjectDetail />} />
            <Route path="/workflows" element={<Workflows />} />
            <Route path="/workflows/:id" element={<WorkflowDetail />} />
            <Route path="/hierarchy" element={<Hierarchy />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/activity" element={<Activity />} />
            <Route path="/usage" element={<Usage />} />
            <Route path="/learning" element={<Learning />} />
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/webhooks" element={<Webhooks />} />
            <Route path="/integrations" element={<Integrations />} />
            <Route path="/users" element={<Users />} />
            <Route path="/account" element={<Account />} />
            <Route path="/skills" element={<Skills />} />
            <Route path="/plugins" element={<Plugins />} />
            <Route path="/models" element={<Models />} />
            <Route path="/providers" element={<Providers />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/codebase" element={<Codebase />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/settings" element={<Settings />} />
        </Routes>
      </motion.div>
    </AnimatePresence>
  );
}
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import Nodes from './pages/Nodes';
import NodeDetail from './pages/NodeDetail';
import Skills from './pages/Skills';
import Plugins from './pages/Plugins';
import Logs from './pages/Logs';

import Login from './pages/Login';
import Agents from './pages/Agents';
import AgentDetail from './pages/AgentDetail';
import Templates from './pages/Templates';
import TemplateEditor from './pages/TemplateEditor';
import Hierarchy from './pages/Hierarchy';
import Tasks from './pages/Tasks';
import Activity from './pages/Activity';
import Projects from './pages/Projects';
import Webhooks from './pages/Webhooks';
import ProjectDetail from './pages/ProjectDetail';
import Users from './pages/Users';
import Account from './pages/Account';
import Workflows from './pages/Workflows';
import WorkflowDetail from './pages/WorkflowDetail';
import Operations from './pages/Operations';
import Changesets from './pages/Changesets';
import Models from './pages/Models';
import Providers from './pages/Providers';
import Integrations from './pages/Integrations';
import Instances from './pages/Instances';
import InstanceDetail from './pages/InstanceDetail';
import AcceptInvite from './pages/AcceptInvite';
import SetupWizard from './pages/SetupWizard';
import Settings from './pages/Settings';
import Usage from './pages/Usage';
import Notifications from './pages/Notifications';
import Analytics from './pages/Analytics';
import Codebase from './pages/Codebase';
import Learning from './pages/Learning';
import { ChangesetBottomBar } from './components/ChangesetBottomBar';
import { Toaster } from './components/ui/sonner';

export default function App() {
  const [authed, setAuthed] = useState(() =>
    !!localStorage.getItem('armada_token') || !!localStorage.getItem('armada_authed')
  );
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/auth/setup-status')
      .then(r => r.json())
      .then(data => setNeedsSetup(data.needsSetup))
      .catch(() => setNeedsSetup(false));
  }, []);

  // Pre-warm users cache so resolveUser() is populated across the app
  useEffect(() => {
    if (authed) prewarmUsers();
  }, [authed]);

  // Invite route is public — check if we're on an invite path
  const isInvitePath = window.location.pathname.startsWith('/invite/');
  if (isInvitePath) {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/invite/:token" element={<AcceptInvite />} />
        </Routes>
      </BrowserRouter>
    );
  }

  // Dismiss splash loader once React takes over
  useEffect(() => {
    if (needsSetup !== null) {
      const splash = document.getElementById('splash');
      if (splash) {
        splash.classList.add('fade');
        setTimeout(() => splash.remove(), 500);
      }
    }
  }, [needsSetup]);

  // Still checking setup status — splash screen handles the loading state
  if (needsSetup === null) {
    return null;
  }

  // First boot — show setup wizard
  if (needsSetup) {
    return <SetupWizard onComplete={() => {
      setNeedsSetup(false);
      setAuthed(true);
    }} />;
  }

  if (!authed) {
    return <Login onLogin={() => setAuthed(true)} />;
  }

  const handleLogout = () => {
    localStorage.removeItem('armada_token');
    localStorage.removeItem('armada_authed');
    // Clear session cookie by calling logout or just expire it client-side
    document.cookie = 'armada_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
    setAuthed(false);
  };

  return (
    <QueryClientProvider client={queryClient}>
    <AuthProvider>
    <SSEProvider>
    <OperationsProvider>
    <BrowserRouter>
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex">
        <Sidebar onLogout={handleLogout} />
        <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 p-4 md:p-8 overflow-auto pt-16 md:pt-8 pb-14">
          <ScrollToTop />
          <ErrorBoundary>
          <AnimatedRoutes />
          </ErrorBoundary>
        </main>
        <ChangesetBottomBar />
        </div>
        <OperationsBar />
      </div>
      <Toaster />
    </BrowserRouter>
    </OperationsProvider>
    </SSEProvider>
    </AuthProvider>
    </QueryClientProvider>
  );
}

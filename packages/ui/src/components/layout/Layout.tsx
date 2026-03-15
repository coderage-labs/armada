import { useState, type ReactNode } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import BottomBar from './BottomBar';
import { PageTransition } from '../PageTransition';

interface Props {
  onLogout?: () => void;
  children?: ReactNode;
}

export default function Layout({ onLogout, children }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  return (
    <div className="min-h-screen flex bg-zinc-950 text-zinc-100">
      <Sidebar
        onLogout={onLogout}
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
      />
      <div className="flex-1 flex flex-col overflow-hidden">
        <TopBar
          onMenuClick={() => setSidebarOpen(true)}
          onLogout={onLogout}
        />
        <main className="flex-1 overflow-auto p-6">
          <AnimatePresence mode="wait">
            <PageTransition key={location.pathname}>
              {children || <Outlet />}
            </PageTransition>
          </AnimatePresence>
        </main>
        <BottomBar />
      </div>
    </div>
  );
}

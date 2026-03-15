import { useEffect, useState, useMemo, type ComponentType } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';
import { useSSEConnection } from '../providers/SSEProvider';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import {
  Home, Monitor, Bot, Cpu, Rocket, FileCode, FolderKanban, GitBranch,
  Activity, Bell, BellRing, Puzzle, Plug, Terminal, Menu, X, LogOut, Bolt, Users,
  Workflow, Radio, Cable, Layers, Settings, Shield, Server, GitPullRequest,
  Wifi, WifiOff, TrendingUp,
} from 'lucide-react';

interface BadgeCounts {
  pendingGates: number;
  activeOperations: number;
  errorInstances: number;
}

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** If set, item is only shown when the user has this scope */
  requiredScope?: string;
}

const navItems: NavItem[] = [
  { to: '/operations', label: 'Operations', icon: Radio },
  { to: '/changesets', label: 'Changesets', icon: GitPullRequest },
  { to: '/', label: 'Dashboard', icon: Home },
  { to: '/nodes', label: 'Nodes', icon: Monitor },
  { to: '/instances', label: 'Instances', icon: Layers },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/templates', label: 'Templates', icon: FileCode },
  { to: '/providers', label: 'Providers', icon: Server },
  { to: '/models', label: 'Models', icon: Cpu },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/workflows', label: 'Workflows', icon: Workflow },
  { to: '/users', label: 'Users', icon: Users, requiredScope: 'users:write' },
  { to: '/hierarchy', label: 'Hierarchy', icon: GitBranch },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/usage', label: 'Usage', icon: TrendingUp },
  { to: '/webhooks', label: 'Webhooks', icon: Bell },
  { to: '/notifications', label: 'Notifications', icon: BellRing },
  { to: '/integrations', label: 'Integrations', icon: Cable },
  { to: '/skills', label: 'Skills', icon: Puzzle },
  { to: '/plugins', label: 'Plugins', icon: Plug },
  { to: '/logs', label: 'Logs', icon: Terminal },
  { to: '/settings', label: 'Settings', icon: Settings, requiredScope: 'system:read' },
];

interface Props {
  onLogout?: () => void;
}

interface CallerInfo {
  id: string;
  name: string;
  displayName: string;
  role: string;
  type: string;
}

export default function Sidebar({ onLogout }: Props) {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [caller, setCaller] = useState<CallerInfo | null>(null);
  const sse = useSSEConnection();
  const { data: badges = { pendingGates: 0, activeOperations: 0, errorInstances: 0 } } = useQuery({
    queryKey: ['badges'],
    queryFn: () => apiFetch<BadgeCounts>('/api/badges'),
  });
  const { user } = useAuth();
  const location = useLocation();
  const currentNav = navItems.find(i => i.to === location.pathname);
  const currentLabel = currentNav?.label || 'Armada';
  const CurrentIcon = currentNav?.icon || Rocket;

  const { hasScope } = useAuth();

  const filteredNavItems = useMemo(() => {
    if (!user) return navItems; // show all while loading
    return navItems.filter(item => !item.requiredScope || hasScope(item.requiredScope));
  }, [user, hasScope]);

  useEffect(() => {
    apiFetch<CallerInfo>('/api/auth/me')
      .then(setCaller)
      .catch(() => {});
    apiFetch<{ version?: string }>('/api/health')
      .then((data) => { if (data.version) setVersion(data.version); })
      .catch(() => {});

    return () => {};
  }, []);

  return (
    <>
      {/* Mobile header */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-50 bg-zinc-950/90 backdrop-blur border-b border-zinc-700 flex items-center px-4 py-3">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={() => setOpen(!open)} className="h-8 w-8 mr-3 text-zinc-300">
                {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{open ? 'Close menu' : 'Open menu'}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <h1 className="text-sm font-semibold text-zinc-100 flex items-center gap-1.5">
          <CurrentIcon className="w-4 h-4 text-violet-400" /> {currentLabel}
        </h1>
      </div>

      {/* Overlay */}
      {open && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/50"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`
        fixed md:relative z-50 md:z-auto
        w-64 shrink-0 h-full
        bg-zinc-950 md:bg-zinc-800/50 backdrop-blur border-r border-zinc-700
        flex flex-col
        transition-transform duration-200
        ${open ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}>
        {/* Logo */}
        <div className="p-6 border-b border-zinc-700">
          <h1 className="text-xl font-bold text-zinc-100 flex items-center gap-2">
            <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-violet-500/20 text-violet-400">
              <Rocket className="w-4 h-4" />
            </span>
            <span><span className="text-violet-400">Armada</span></span>
          </h1>
          <p className="text-xs text-zinc-500 mt-1">Agent orchestration platform</p>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          {filteredNavItems.map((item) => {
            // Determine badge count for this nav item
            let badge = 0;
            if (item.to === '/workflows') badge = badges.pendingGates;
            else if (item.to === '/operations') badge = badges.activeOperations;
            else if (item.to === '/instances') badge = badges.errorInstances;

            const badgeColor =
              item.to === '/instances'
                ? 'bg-red-500 text-white'
                : 'bg-violet-500 text-white';

            return (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-violet-500/20 text-violet-300'
                      : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/50'
                  }`
                }
              >
                <item.icon className="w-5 h-5 shrink-0" />
                <span className="flex-1">{item.label}</span>
                {badge > 0 && (
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none ${badgeColor}`}>
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </NavLink>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="p-4 border-t border-zinc-700 space-y-3">
          {/* Account card */}
          {caller && (
            <div className="flex items-center gap-3">
              <img
                src={`/api/users/${caller.id}/avatar`}
                alt=""
                className="w-9 h-9 rounded-full bg-zinc-700/50 object-cover shrink-0"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-zinc-200 truncate">{caller.displayName}</p>
                <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{caller.role}</p>
              </div>
              <NavLink
                to="/account"
                onClick={() => setOpen(false)}
                className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors"
                title="Account settings"
              >
                <Settings className="w-4 h-4" />
              </NavLink>
            </div>
          )}
          {onLogout && (
            <Button
             variant="ghost"
              size="sm"
              onClick={onLogout}
              className="w-full justify-start text-zinc-500 hover:text-zinc-300 rounded-xl"
            >
              <LogOut className="w-4 h-4" /> Sign Out
            </Button>
          )}
          <div className="flex items-center gap-2">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1">
                    {sse.connected
                      ? <Wifi className="w-3 h-3 text-emerald-500" />
                      : <WifiOff className="w-3 h-3 text-red-400" />
                    }
                  </div>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {sse.connected
                    ? `SSE connected · ${sse.eventCount} events`
                    : sse.polling ? 'SSE disconnected · polling fallback' : 'SSE disconnected'
                  }
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {version && <p className="text-xs text-zinc-600">v{version}</p>}
          </div>
        </div>
      </aside>
    </>
  );
}

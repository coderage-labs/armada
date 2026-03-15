import { useEffect, useState, useMemo, type ComponentType } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../hooks/useApi';
import { useAuth } from '../../hooks/useAuth';
import { useSSEConnection } from '../../providers/SSEProvider';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import {
  Home, Monitor, Bot, Cpu, Zap, FileCode, FolderKanban, GitBranch,
  Activity, Bell, Puzzle, Plug, Terminal, LogOut, Users,
  Workflow, Radio, Cable, Layers, Settings, Server, GitPullRequest,
  ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, ListChecks,
  Wifi, WifiOff,
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
  requiredScope?: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    label: 'Infrastructure',
    items: [
      { to: '/nodes', label: 'Nodes', icon: Monitor },
      { to: '/instances', label: 'Instances', icon: Layers },
      { to: '/plugins', label: 'Plugins', icon: Plug },
    ],
  },
  {
    label: 'Agents',
    items: [
      { to: '/agents', label: 'Agents', icon: Bot },
      { to: '/templates', label: 'Templates', icon: FileCode },
      { to: '/hierarchy', label: 'Hierarchy', icon: GitBranch },
      { to: '/skills', label: 'Skills', icon: Puzzle },
    ],
  },
  {
    label: 'Automation',
    items: [
      { to: '/projects', label: 'Projects', icon: FolderKanban },
      { to: '/workflows', label: 'Workflows', icon: Workflow },
      { to: '/tasks', label: 'Tasks', icon: ListChecks },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { to: '/providers', label: 'Providers', icon: Server },
      { to: '/models', label: 'Models', icon: Cpu },
      { to: '/integrations', label: 'Integrations', icon: Cable },
      { to: '/webhooks', label: 'Webhooks', icon: Bell },
      { to: '/settings', label: 'Settings', icon: Settings, requiredScope: 'system:read' },
    ],
  },
  {
    label: 'Observe',
    items: [
      { to: '/operations', label: 'Operations', icon: Radio },
      { to: '/changesets', label: 'Changesets', icon: GitPullRequest },
      { to: '/activity', label: 'Activity', icon: Activity },
      { to: '/logs', label: 'Logs', icon: Terminal },
    ],
  },
];

interface Props {
  onLogout?: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface CallerInfo {
  id: string;
  name: string;
  displayName: string;
  role: string;
  type: string;
}

export default function Sidebar({ onLogout, open, onOpenChange }: Props) {
  const [version, setVersion] = useState<string | null>(null);
  const [caller, setCaller] = useState<CallerInfo | null>(null);
  const sse = useSSEConnection();
  const { data: badges = { pendingGates: 0, activeOperations: 0, errorInstances: 0 } } = useQuery({
    queryKey: ['badges'],
    queryFn: () => apiFetch<BadgeCounts>('/api/badges'),
  });
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar_collapsed') === 'true');
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(() => {
    const saved = localStorage.getItem('sidebar_groups');
    return saved ? JSON.parse(saved) : { Infrastructure: true, Agents: true, Automation: true, Configuration: true, Observe: true };
  });
  
  const { user, hasScope } = useAuth();
  const location = useLocation();

  const filteredGroups = useMemo(() => {
    if (!user) return navGroups;
    return navGroups.map(group => ({
      ...group,
      items: group.items.filter(item => !item.requiredScope || hasScope(item.requiredScope)),
    })).filter(group => group.items.length > 0);
  }, [user, hasScope]);

  useEffect(() => {
    localStorage.setItem('sidebar_groups', JSON.stringify(expandedGroups));
  }, [expandedGroups]);

  useEffect(() => {
    localStorage.setItem('sidebar_collapsed', String(collapsed));
  }, [collapsed]);

  useEffect(() => {
    apiFetch<CallerInfo>('/api/auth/me')
      .then(setCaller)
      .catch(() => {});
    apiFetch<{ version?: string }>('/api/health')
      .then((data) => { if (data.version) setVersion(data.version); })
      .catch(() => {});

    return () => {};
  }, []);

  const toggleGroup = (label: string) => {
    setExpandedGroups(prev => ({ ...prev, [label]: !prev[label] }));
  };

  const getBadgeForGroup = (label: string): number => {
    if (label === 'Observe') {
      return badges.activeOperations;
    }
    return 0;
  };

  const getBadgeForItem = (to: string): number => {
    if (to === '/operations') return badges.activeOperations;
    if (to === '/instances') return badges.errorInstances;
    return 0;
  };

  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/50"
          onClick={() => onOpenChange(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`
        fixed md:relative z-50 md:z-auto
        ${collapsed ? 'w-16' : 'w-64'} shrink-0 h-full
        bg-zinc-950 md:bg-zinc-900 dark:bg-zinc-900 backdrop-blur border-r border-zinc-700 dark:border-zinc-700
        flex flex-col
        transition-all duration-200
        ${open ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}>
        {/* Logo */}
        <div className="p-6 border-b border-zinc-700">
          {collapsed ? (
            <div className="flex items-center justify-center">
              <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-violet-500/20 text-violet-400">
                <Zap className="w-4 h-4" />
              </span>
            </div>
          ) : (
            <>
              <h1 className="text-xl font-bold text-zinc-100 flex items-center gap-2">
                <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-violet-500/20 text-violet-400">
                  <Zap className="w-4 h-4" />
                </span>
                <span className="text-violet-400">Armada</span>
              </h1>
              <p className="text-xs text-zinc-500 mt-1">Agent orchestration</p>
            </>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          {/* Dashboard - always visible */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <NavLink
                  to="/"
                  onClick={() => onOpenChange(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-violet-500/20 text-violet-300'
                        : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/50'
                    } ${collapsed ? 'justify-center' : ''}`
                  }
                >
                  <Home className="w-5 h-5 shrink-0" />
                  {!collapsed && <span className="flex-1">Dashboard</span>}
                </NavLink>
              </TooltipTrigger>
              {collapsed && <TooltipContent side="right">Dashboard</TooltipContent>}
            </Tooltip>
          </TooltipProvider>

          {/* Groups */}
          {filteredGroups.map((group) => {
            const isExpanded = expandedGroups[group.label];
            const groupBadge = getBadgeForGroup(group.label);
            const hasActiveItem = group.items.some(item => item.to === location.pathname);

            return (
              <div key={group.label} className="space-y-1">
                {/* Group header */}
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => toggleGroup(group.label)}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-wider transition-colors rounded-lg ${
                          hasActiveItem ? 'text-violet-300' : 'text-zinc-500 hover:text-zinc-300'
                        } ${collapsed ? 'justify-center' : ''}`}
                      >
                        {collapsed ? (
                          <ChevronRight className="w-3 h-3" />
                        ) : (
                          <>
                            {isExpanded ? (
                              <ChevronDown className="w-3 h-3" />
                            ) : (
                              <ChevronRight className="w-3 h-3" />
                            )}
                            <span className="flex-1 text-left">{group.label}</span>
                            {groupBadge > 0 && (
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none bg-violet-500 text-white">
                                {groupBadge > 99 ? '99+' : groupBadge}
                              </span>
                            )}
                          </>
                        )}
                      </button>
                    </TooltipTrigger>
                    {collapsed && <TooltipContent side="right">{group.label}</TooltipContent>}
                  </Tooltip>
                </TooltipProvider>

                {/* Group items */}
                {(isExpanded || collapsed) && (
                  <div className={collapsed ? 'space-y-1' : 'space-y-0.5 ml-2'}>
                    {group.items.map((item) => {
                      const badge = getBadgeForItem(item.to);
                      const badgeColor = item.to === '/instances' ? 'bg-red-500 text-white' : 'bg-violet-500 text-white';

                      return (
                        <TooltipProvider key={item.to}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <NavLink
                                to={item.to}
                                onClick={() => onOpenChange(false)}
                                className={({ isActive }) =>
                                  `flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors ${
                                    isActive
                                      ? 'bg-violet-500/20 text-violet-300'
                                      : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/50'
                                  } ${collapsed ? 'justify-center' : ''}`
                                }
                              >
                                <item.icon className="w-4 h-4 shrink-0" />
                                {!collapsed && (
                                  <>
                                    <span className="flex-1">{item.label}</span>
                                    {badge > 0 && (
                                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none ${badgeColor}`}>
                                        {badge > 99 ? '99+' : badge}
                                      </span>
                                    )}
                                  </>
                                )}
                              </NavLink>
                            </TooltipTrigger>
                            {collapsed && <TooltipContent side="right">{item.label}</TooltipContent>}
                          </Tooltip>
                        </TooltipProvider>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="p-4 border-t border-zinc-700 space-y-3">
          {/* Collapse toggle */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCollapsed(!collapsed)}
                  className={`w-full ${collapsed ? 'justify-center px-0' : 'justify-start'} text-zinc-500 hover:text-zinc-300 rounded-xl`}
                >
                  {collapsed ? (
                    <ChevronsRight className="w-4 h-4" />
                  ) : (
                    <>
                      <ChevronsLeft className="w-4 h-4" />
                      <span className="ml-2">Collapse</span>
                    </>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{collapsed ? 'Expand sidebar' : 'Collapse sidebar'}</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {/* User section */}
          {caller && !collapsed && (
            <div className="flex items-center gap-3">
              <img
                src={`/api/users/${caller.id}/avatar?v=${(caller as any).avatarVersion || 0}`}
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
                onClick={() => onOpenChange(false)}
                className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors"
                title="Account settings"
              >
                <Settings className="w-4 h-4" />
              </NavLink>
            </div>
          )}
          
          {caller && collapsed && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <NavLink
                    to="/account"
                    onClick={() => onOpenChange(false)}
                    className="flex justify-center p-2 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors"
                  >
                    <img
                      src={`/api/users/${caller.id}/avatar?v=${(caller as any).avatarVersion || 0}`}
                      alt=""
                      className="w-8 h-8 rounded-full bg-zinc-700/50 object-cover"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  </NavLink>
                </TooltipTrigger>
                <TooltipContent side="right">Account</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {onLogout && !collapsed && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onLogout}
              className="w-full justify-start text-zinc-500 hover:text-zinc-300 rounded-xl"
            >
              <LogOut className="w-4 h-4 mr-2" /> Sign Out
            </Button>
          )}
          
          {onLogout && collapsed && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onLogout}
                    className="w-full justify-center px-0 text-zinc-500 hover:text-zinc-300 rounded-xl"
                  >
                    <LogOut className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Sign Out</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {!collapsed && (
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
          )}
          {collapsed && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex justify-center">
                    {sse.connected
                      ? <Wifi className="w-3 h-3 text-emerald-500" />
                      : <WifiOff className="w-3 h-3 text-red-400" />
                    }
                  </div>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {sse.connected ? 'SSE connected' : 'SSE disconnected'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </aside>
    </>
  );
}

import { useState, useEffect } from 'react';
import { useLocation, NavLink } from 'react-router-dom';
import { Menu, Sun, Moon, User, LogOut } from 'lucide-react';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { apiFetch } from '../../hooks/useApi';

interface Props {
  onMenuClick: () => void;
  onLogout?: () => void;
}

interface CallerInfo {
  id: string;
  name: string;
  displayName: string;
  role: string;
}

const routeTitles: Record<string, string> = {
  '/': 'Dashboard',
  '/nodes': 'Nodes',
  '/instances': 'Instances',
  '/plugins': 'Plugins',
  '/agents': 'Agents',
  '/templates': 'Templates',
  '/hierarchy': 'Hierarchy',
  '/skills': 'Skills',
  '/projects': 'Projects',
  '/workflows': 'Workflows',
  '/tasks': 'Tasks',
  '/providers': 'Providers',
  '/models': 'Models',
  '/integrations': 'Integrations',
  '/webhooks': 'Webhooks',
  '/settings': 'Settings',
  '/operations': 'Operations',
  '/changesets': 'Changesets',
  '/activity': 'Activity',
  '/logs': 'Logs',
  '/users': 'Users',
  '/account': 'Account',
};

export default function TopBar({ onMenuClick, onLogout }: Props) {
  const location = useLocation();
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('theme');
    return (saved === 'light' || saved === 'dark') ? saved : 'dark';
  });
  const [caller, setCaller] = useState<CallerInfo | null>(null);

  useEffect(() => {
    apiFetch<CallerInfo>('/api/auth/me')
      .then(setCaller)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const html = document.documentElement;
    if (theme === 'dark') {
      html.classList.add('dark');
    } else {
      html.classList.remove('dark');
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  // Get page title from route
  const getPageTitle = () => {
    // Check for detail pages
    if (location.pathname.startsWith('/nodes/')) return 'Node Details';
    if (location.pathname.startsWith('/instances/')) return 'Instance Details';
    if (location.pathname.startsWith('/agents/')) return 'Agent Details';
    if (location.pathname.startsWith('/projects/')) return 'Project Details';
    if (location.pathname.startsWith('/workflows/')) return 'Workflow Details';
    if (location.pathname.startsWith('/templates/') && location.pathname.includes('/edit')) return 'Edit Template';
    if (location.pathname === '/templates/new') return 'New Template';
    
    return routeTitles[location.pathname] || 'Armada';
  };

  return (
    <header className="h-16 border-b border-zinc-700 dark:border-zinc-700 bg-zinc-900 dark:bg-zinc-900 flex items-center px-6 gap-4">
      {/* Mobile menu button */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={onMenuClick}
              className="md:hidden h-9 w-9 text-zinc-300"
            >
              <Menu className="w-5 h-5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open menu</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {/* Page title */}
      <h2 className="text-lg font-semibold text-zinc-100 flex-1">
        {getPageTitle()}
      </h2>

      {/* Theme toggle */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              className="h-9 w-9 text-zinc-400 hover:text-zinc-100"
            >
              {theme === 'dark' ? (
                <Sun className="w-5 h-5" />
              ) : (
                <Moon className="w-5 h-5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle theme</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {/* User menu */}
      {caller && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full">
              <img
                src={`/api/users/${caller.id}/avatar`}
                alt=""
                className="w-9 h-9 rounded-full bg-zinc-700/50 object-cover"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <div className="px-2 py-2">
              <p className="text-sm font-medium text-zinc-100">{caller.displayName}</p>
              <p className="text-xs text-zinc-500">{caller.role}</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <NavLink to="/account" className="flex items-center gap-2 cursor-pointer">
                <User className="w-4 h-4" />
                <span>Account</span>
              </NavLink>
            </DropdownMenuItem>
            {onLogout && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onLogout} className="flex items-center gap-2 cursor-pointer">
                  <LogOut className="w-4 h-4" />
                  <span>Sign Out</span>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </header>
  );
}

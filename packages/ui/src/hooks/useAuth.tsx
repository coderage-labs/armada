import { createContext, useContext, useCallback, useEffect, useState, type ReactNode } from 'react';
import { apiFetch } from './useApi';

interface AuthUser {
  id: string;
  name: string;
  displayName: string;
  role: string;
  type: string;
  hasPassword: boolean;
  scopes: string[];
}

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  hasScope: (scope: string) => boolean;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  refresh: async () => {},
  hasScope: () => false,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      const me = await apiFetch<AuthUser>('/api/auth/me');
      setUser(me);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  const hasScope = useCallback(
    (scope: string): boolean => {
      // Owner role has all scopes implicitly
      if (user?.role === 'owner') return true;
      return user?.scopes?.includes(scope) ?? false;
    },
    [user],
  );

  useEffect(() => { refresh(); }, []);

  return (
    <AuthContext.Provider value={{ user, loading, refresh, hasScope }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

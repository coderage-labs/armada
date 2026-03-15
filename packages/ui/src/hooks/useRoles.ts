import { useState, useEffect, useCallback, useMemo } from 'react';
import type { RoleMetadata } from '@coderage-labs/armada-shared';
import { apiFetch } from './useApi';
import { roleColorFromMeta, getTierFromMeta, DEFAULT_COLOR } from '../utils/roles';
import type { RoleColor } from '../utils/roles';

interface HierarchyResponse {
  rules: Record<string, string[]>;
  roles: RoleMetadata[];
}

export function useRoles() {
  const [rolesMap, setRolesMap] = useState<Map<string, RoleMetadata>>(new Map());

  useEffect(() => {
    apiFetch<HierarchyResponse>('/api/hierarchy')
      .then(data => {
        const map = new Map<string, RoleMetadata>();
        for (const r of data.roles ?? []) {
          map.set(r.role, r);
        }
        setRolesMap(map);
      })
      .catch(() => { /* ignore — will use defaults */ });
  }, []);

  const getRoleColor = useCallback((role?: string): RoleColor => {
    if (!role) return DEFAULT_COLOR;
    // Exact match first
    const meta = rolesMap.get(role) ?? rolesMap.get(role.toLowerCase());
    if (meta) return roleColorFromMeta(meta);
    // Partial match — check if the role contains a known key
    const lower = role.toLowerCase();
    for (const [key, m] of rolesMap) {
      if (lower.includes(key)) return roleColorFromMeta(m);
    }
    return DEFAULT_COLOR;
  }, [rolesMap]);

  const getRoleTier = useCallback((role?: string): number => {
    if (!role) return 2;
    const meta = rolesMap.get(role) ?? rolesMap.get(role.toLowerCase());
    if (meta) return getTierFromMeta(meta);
    const lower = role.toLowerCase();
    for (const [key, m] of rolesMap) {
      if (lower.includes(key)) return getTierFromMeta(m);
    }
    return 2;
  }, [rolesMap]);

  const getRoleIcon = useCallback((role?: string): string | null => {
    if (!role) return null;
    const meta = rolesMap.get(role) ?? rolesMap.get(role.toLowerCase());
    return meta?.icon ?? null;
  }, [rolesMap]);

  const getRoleDescription = useCallback((role?: string): string => {
    if (!role) return '';
    const meta = rolesMap.get(role) ?? rolesMap.get(role.toLowerCase());
    return meta?.description ?? '';
  }, [rolesMap]);

  return {
    roles: rolesMap,
    getRoleColor,
    getRoleTier,
    getRoleIcon,
    getRoleDescription,
  };
}

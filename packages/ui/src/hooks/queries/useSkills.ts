import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../useApi';

export function useSkills() {
  return useQuery({
    queryKey: ['skills'],
    queryFn: () => apiFetch<any[]>('/api/skills/library'),
  });
}

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { Template } from '@coderage-labs/armada-shared';
import { apiFetch } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';
import { useTemplates } from '../hooks/queries/useTemplates';
import TemplateCard from '../components/TemplateCard';
import { usePendingStyle } from '../hooks/usePendingStyle';
import type { PendingFields } from '../hooks/usePendingStyle';
import { FileCode } from 'lucide-react';
import { EmptyState } from '../components/EmptyState';
import { CardGrid } from '../components/shared';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui/button';
import ConfirmDialog from '../components/ConfirmDialog';

interface TemplateWithPending extends Template {
  pendingAction?: string | null;
  pendingFields?: PendingFields | null;
}

function TemplateCardWrapper({ t, hasDrift, onEdit, onClone, onDelete }: {
  t: TemplateWithPending;
  hasDrift: boolean;
  onEdit: (id: string) => void;
  onClone: (t: Template) => void;
  onDelete: (id: string) => void;
}) {
  const { cardClass } = usePendingStyle(t.pendingFields, t.pendingAction);
  return (
    <div className={`h-full ${cardClass}`.trim()}>
      <TemplateCard template={t} hasDrift={hasDrift} onEdit={onEdit} onClone={onClone} onDelete={onDelete} />
    </div>
  );
}

export default function Templates() {
  const navigate = useNavigate();
  const { hasScope } = useAuth();
  const canMutate = hasScope('templates:write');
  const queryClient = useQueryClient();
  const { data: templates = [], isLoading: loading, error: fetchError } = useTemplates();
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [driftMap, setDriftMap] = useState<Record<string, boolean>>({});

  const checkDrift = async (tmpls: Template[]) => {
    const map: Record<string, boolean> = {};
    // Check drift in parallel (best-effort, don't block UI)
    await Promise.allSettled(
      tmpls.map(async (t) => {
        try {
          const data = await apiFetch<any[]>(`/api/templates/${t.id}/drift`);
          const hasDrift = data.some((a: any) => a.drifted);
          map[t.id] = hasDrift;
        } catch {
          // ignore
        }
      }),
    );
    setDriftMap(map);
  };

  useEffect(() => {
    if (templates.length > 0) {
      checkDrift(templates);
    }
  }, [templates]);

  const handleEdit = (id: string) => navigate(`/templates/${id}/edit`);

  const handleClone = async (t: Template) => {
    try {
      const { id: _id, createdAt: _c, ...rest } = t as any;
      const newId = crypto.randomUUID();
      await apiFetch('/api/templates', {
        method: 'POST',
        body: JSON.stringify({ ...rest, name: `${t.name}-copy` }),
      });
      queryClient.invalidateQueries();
    } catch (e: any) {
      setError(e.message ?? 'Clone failed');
    }
  };

  const handleDelete = (id: string) => setDeleting(id);

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await apiFetch(`/api/templates/${deleting}`, { method: 'DELETE' });
      setDeleting(null);
      queryClient.invalidateQueries();
    } catch (e: any) {
      setError(e.message ?? 'Delete failed');
      setDeleting(null);
    }
  };

  // suppress unused warning from fetchError
  void fetchError;

  return (
    <div className="space-y-6">
      <PageHeader icon={FileCode} title="Templates" subtitle="Agent configuration templates">
        {canMutate && (
          <Button
            onClick={() => navigate('/templates/new')}
            className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9"
          >
            + Create Template
          </Button>
        )}
      </PageHeader>

      {/* Error */}
      {error && (
        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && <CardGrid loading skeletonCount={3} />}

      {/* Empty state */}
      {!loading && templates.length === 0 && (
        <EmptyState
          icon={FileCode}
          title="No templates yet"
          description="Templates define the configuration for your agents"
          action={canMutate ? { label: 'Create Template', onClick: () => navigate('/templates/new') } : undefined}
        />
      )}

      {/* Grid */}
      {!loading && templates.length > 0 && (
        <CardGrid>
          {(templates as TemplateWithPending[]).map((t) => (
            <TemplateCardWrapper
              key={t.id}
              t={t}
              hasDrift={driftMap[t.id] ?? false}
              onEdit={handleEdit}
              onClone={handleClone}
              onDelete={handleDelete}
            />
          ))}
        </CardGrid>
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleting}
        title="Delete Template"
        message="Are you sure? This action cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

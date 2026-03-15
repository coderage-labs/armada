import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';
import { useWebhooks, useInboundWebhooks, useWebhookMetrics, useWebhookDeliveries } from '../hooks/queries/useWebhooks';
import { usePendingStyle } from '../hooks/usePendingStyle';
import type { PendingFields } from '../hooks/usePendingStyle';
import { PendingBadge } from '../components/PendingBadge';
import {
  Bell, CheckCircle2, XCircle, Pencil, Trash2, FlaskConical, Hourglass, Key,
  Webhook as WebhookIcon, Copy, Check, BarChart2, RefreshCw, Clock, Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '../components/PageHeader';
import ConfirmDialog from '../components/ConfirmDialog';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Switch } from '../components/ui/switch';
import { EmptyState } from '../components/EmptyState';
import { RowSkeleton } from '../components/ui/skeleton';
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '../components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/responsive-dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';

/* ── Types ─────────────────────────────────────────── */

interface Webhook {
  id: string;
  url: string;
  events: string;
  secret: string | null;
  enabled: boolean;
  createdAt: string;
  pendingAction?: string | null;
  pendingFields?: PendingFields | null;
}

/* ── Event types ───────────────────────────────────── */

const EVENT_TYPES = [
  'task:created', 'task:updated', 'task:comment',
  'agent.created', 'agent.updated', 'agent.deleted', 'agent.health',
  'project:created', 'project:updated', 'project:deleted',
];

/* ── Helpers ───────────────────────────────────────── */

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function truncateUrl(url: string, max = 50): string {
  if (url.length <= max) return url;
  return url.slice(0, max - 3) + '…';
}

/* ── Webhook Form ──────────────────────────────────── */

function WebhookForm({
  initial,
  onSubmit,
  onCancel,
  loading,
}: {
  initial?: Webhook;
  onSubmit: (data: { url: string; events: string; secret: string; enabled: boolean }) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const [url, setUrl] = useState(initial?.url ?? '');
  const [events, setEvents] = useState(initial?.events ?? '*');
  const [secret, setSecret] = useState('');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [useAllEvents, setUseAllEvents] = useState(!initial || initial.events === '*');

  const toggleEvent = (ev: string) => {
    const current = events.split(',').map(e => e.trim()).filter(Boolean);
    if (current.includes(ev)) {
      setEvents(current.filter(e => e !== ev).join(',') || '*');
    } else {
      setEvents([...current, ev].join(','));
    }
  };

  const selectedEvents = events === '*' ? [] : events.split(',').map(e => e.trim());

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-zinc-400 mb-1.5">Webhook URL</label>
        <Input
          type="url"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://example.com/webhook"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-zinc-400 mb-1.5">Events</label>
        <div className="flex items-center gap-3 mb-2">
          <Button
            variant="ghost" type="button"
            onClick={() => { setUseAllEvents(true); setEvents('*'); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              useAllEvents
                ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                : 'bg-zinc-800/50 text-zinc-400 border border-zinc-800 hover:bg-zinc-700/50'
            }`}
          >
            All events
          </Button>
          <Button
            variant="ghost" type="button"
            onClick={() => { setUseAllEvents(false); setEvents(''); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              !useAllEvents
                ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                : 'bg-zinc-800/50 text-zinc-400 border border-zinc-800 hover:bg-zinc-700/50'
            }`}
          >
            Select events
          </Button>
        </div>
        {!useAllEvents && (
          <div className="flex flex-wrap gap-1.5">
            {EVENT_TYPES.map(ev => (
              <Button
                variant="ghost" key={ev}
                type="button"
                onClick={() => toggleEvent(ev)}
                className={`px-2.5 py-1 rounded-lg text-xs transition-colors ${
                  selectedEvents.includes(ev)
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                    : 'bg-zinc-800/50 text-zinc-500 border border-zinc-800 hover:bg-zinc-700/50 hover:text-zinc-300'
                }`}
              >
                {ev}
              </Button>
            ))}
          </div>
        )}
      </div>

      <div>
        <label className="block text-xs font-medium text-zinc-400 mb-1.5">
          Secret <span className="text-zinc-600">(optional, for HMAC-SHA256 signatures)</span>
        </label>
        <Input
          type="password"
          value={secret}
          onChange={e => setSecret(e.target.value)}
          placeholder={initial ? '••••••' : 'Enter a shared secret'}
        />
      </div>

      <div className="flex items-center gap-2">
        <Switch checked={enabled} onCheckedChange={setEnabled} />
        <span className="text-xs text-zinc-400">{enabled ? 'Enabled' : 'Disabled'}</span>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button
          variant="outline" onClick={onCancel}
          className="text-sm"
        >
          Cancel
        </Button>
        <Button
          onClick={() => onSubmit({ url, events: useAllEvents ? '*' : events, secret, enabled })}
          disabled={loading || !url}
          className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9 disabled:opacity-50"
        >
          {loading ? 'Saving…' : initial ? 'Update' : 'Create'}
        </Button>
      </div>
    </div>
  );
}

/* ── Webhook Deliveries Dialog ─────────────────────── */

function WebhookDeliveriesDialog({
  webhookId,
  webhookUrl,
  open,
  onClose,
}: {
  webhookId: string;
  webhookUrl: string;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: metrics, isLoading: metricsLoading } = useWebhookMetrics(open ? webhookId : null);
  const { data: deliveries = [], isLoading: deliveriesLoading } = useWebhookDeliveries(open ? webhookId : null, 20);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const handleRetry = async (deliveryId: string) => {
    setRetryingId(deliveryId);
    try {
      await apiFetch(`/api/webhooks/${webhookId}/deliveries/${deliveryId}/retry`, { method: 'POST' });
      toast.success('Delivery retried successfully');
      await queryClient.invalidateQueries({ queryKey: ['webhook-deliveries', webhookId] });
      await queryClient.invalidateQueries({ queryKey: ['webhook-metrics', webhookId] });
    } catch (err: any) {
      toast.error(`Retry failed: ${err.message ?? 'Unknown error'}`);
    } finally {
      setRetryingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BarChart2 className="w-4 h-4 text-violet-400" />
            Delivery History
          </DialogTitle>
          <p className="text-xs text-zinc-500 truncate">{webhookUrl}</p>
        </DialogHeader>

        {/* Metrics strip */}
        <div className="grid grid-cols-4 gap-3 flex-shrink-0">
          {metricsLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 animate-pulse h-16" />
            ))
          ) : metrics ? (
            <>
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                <div className="text-[11px] text-zinc-500 uppercase tracking-wider mb-1">Total</div>
                <div className="text-xl font-semibold text-zinc-200 tabular-nums">{metrics.total}</div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                <div className="text-[11px] text-zinc-500 uppercase tracking-wider mb-1">Success Rate</div>
                <div className={`text-xl font-semibold tabular-nums ${metrics.successRate >= 90 ? 'text-emerald-400' : metrics.successRate >= 70 ? 'text-amber-400' : 'text-red-400'}`}>
                  {metrics.successRate}%
                </div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                <div className="text-[11px] text-zinc-500 uppercase tracking-wider mb-1">Failed</div>
                <div className={`text-xl font-semibold tabular-nums ${metrics.failed > 0 ? 'text-red-400' : 'text-zinc-400'}`}>
                  {metrics.failed}
                </div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                <div className="text-[11px] text-zinc-500 uppercase tracking-wider mb-1">Avg Latency</div>
                <div className="text-xl font-semibold text-zinc-200 tabular-nums">
                  {metrics.avgLatencyMs != null ? `${metrics.avgLatencyMs}ms` : '—'}
                </div>
              </div>
            </>
          ) : null}
        </div>

        {/* Deliveries table */}
        <div className="flex-1 overflow-auto min-h-0">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
            <Table className="text-sm">
              <TableHeader className="sticky top-0 bg-zinc-900 z-10">
                <TableRow className="border-b border-zinc-800">
                  <TableHead className="px-4 py-2.5 text-left text-[11px] text-zinc-500 uppercase tracking-wider">Event</TableHead>
                  <TableHead className="px-4 py-2.5 text-left text-[11px] text-zinc-500 uppercase tracking-wider">Status</TableHead>
                  <TableHead className="px-4 py-2.5 text-left text-[11px] text-zinc-500 uppercase tracking-wider">Code</TableHead>
                  <TableHead className="px-4 py-2.5 text-left text-[11px] text-zinc-500 uppercase tracking-wider">Latency</TableHead>
                  <TableHead className="px-4 py-2.5 text-left text-[11px] text-zinc-500 uppercase tracking-wider">Attempt</TableHead>
                  <TableHead className="px-4 py-2.5 text-left text-[11px] text-zinc-500 uppercase tracking-wider whitespace-nowrap">Time</TableHead>
                  <TableHead className="px-4 py-2.5 text-right text-[11px] text-zinc-500 uppercase tracking-wider w-20"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveriesLoading && Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i} className="border-b border-zinc-800/50">
                    {Array.from({ length: 7 }).map((_, j) => (
                      <TableCell key={j} className="px-4 py-3">
                        <div className="h-3 bg-zinc-800 rounded animate-pulse" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {!deliveriesLoading && deliveries.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="px-4 py-10 text-center text-zinc-600 text-sm">
                      No deliveries recorded yet
                    </TableCell>
                  </TableRow>
                )}
                {!deliveriesLoading && deliveries.map(d => (
                  <TableRow key={d.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                    <TableCell className="px-4 py-2.5">
                      <span className="text-xs font-mono text-zinc-300">{d.eventType}</span>
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      {d.status === 'success' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                          <CheckCircle2 className="w-3 h-3" /> success
                        </span>
                      ) : d.status === 'failed' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-500/15 text-red-400 border border-red-500/20">
                          <XCircle className="w-3 h-3" /> failed
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-zinc-700/50 text-zinc-400 border border-zinc-700">
                          <Clock className="w-3 h-3" /> {d.status}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="px-4 py-2.5 text-xs text-zinc-400 tabular-nums">
                      {d.statusCode ?? <span className="text-zinc-600">—</span>}
                    </TableCell>
                    <TableCell className="px-4 py-2.5 text-xs text-zinc-400 tabular-nums">
                      {d.latencyMs != null ? `${d.latencyMs}ms` : <span className="text-zinc-600">—</span>}
                    </TableCell>
                    <TableCell className="px-4 py-2.5 text-xs text-zinc-500 tabular-nums">
                      #{d.attempt}
                    </TableCell>
                    <TableCell className="px-4 py-2.5 text-xs text-zinc-600 whitespace-nowrap">
                      {relativeTime(d.createdAt)}
                    </TableCell>
                    <TableCell className="px-4 py-2.5 text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRetry(d.id)}
                        disabled={retryingId === d.id}
                        className="text-xs h-7 gap-1 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50 px-2"
                      >
                        {retryingId === d.id
                          ? <Hourglass className="w-3 h-3" />
                          : <><RefreshCw className="w-3 h-3" /> Retry</>
                        }
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Webhook Row ───────────────────────────────────── */

function WebhookRow({
  webhook,
  onToggle,
  onEdit,
  onDelete,
  onTest,
  onDeliveries,
  testResult,
  testing,
}: {
  webhook: Webhook;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  onDeliveries: () => void;
  testResult: { success: boolean; message: string } | null;
  testing: boolean;
}) {
  const { pf, rowClass, switchPf, badgePf, isFieldPending } = usePendingStyle(webhook.pendingFields, webhook.pendingAction);

  return (
    <TableRow className={`border-b border-zinc-800/50 hover:bg-zinc-800/40 transition-colors ${rowClass}`}>
      <TableCell className="px-4 py-3">
        <span className={switchPf('enabled')}>
          <Switch checked={webhook.enabled} onCheckedChange={() => onToggle()} />
        </span>
      </TableCell>
      <TableCell className="px-4 py-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <code className={pf('url', 'text-sm text-zinc-200 block')} title={webhook.url}>
              {truncateUrl(webhook.url, 55)}
            </code>
            {webhook.pendingAction && (
              <PendingBadge action={webhook.pendingAction as 'create' | 'update' | 'delete'} />
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-zinc-600">
            {webhook.secret && (
              <span className="flex items-center gap-1"><Key className="w-3 h-3" /> Signed</span>
            )}
            {testResult && (
              <span className={testResult.success ? 'text-emerald-400' : 'text-red-400'}>
                {testResult.success
                  ? <span className="inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Delivered</span>
                  : <span className="inline-flex items-center gap-1"><XCircle className="w-3 h-3" /> {testResult.message}</span>
                }
              </span>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {webhook.events === '*' ? (
            <Badge
              variant="secondary"
              className={badgePf('events', 'bg-violet-500/15 text-violet-300 border border-violet-500/20 text-[11px]')}
            >
              All events
            </Badge>
          ) : (
            webhook.events.split(',').map(ev => (
              <span
                key={ev}
                className={isFieldPending('events')
                  ? 'px-1.5 py-0.5 rounded-full text-[11px] bg-amber-500/15 text-amber-300 border border-amber-500/20'
                  : 'px-1.5 py-0.5 rounded-full text-[11px] bg-zinc-800/50 text-zinc-400 border border-zinc-800'
                }
              >
                {ev.trim()}
              </span>
            ))
          )}
        </div>
      </TableCell>
      <TableCell className="px-4 py-3 text-xs text-zinc-600 whitespace-nowrap">
        {relativeTime(webhook.createdAt)}
      </TableCell>
      <TableCell className="px-4 py-3">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={onTest}
            disabled={testing}
            className="text-xs h-8 gap-1.5 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
          >
            {testing
              ? <Hourglass className="w-3 h-3" />
              : <><FlaskConical className="w-3 h-3" /> Test</>
            }
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onDeliveries}
            className="text-xs h-8 gap-1.5 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
          >
            <BarChart2 className="w-3 h-3" /> Deliveries
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onEdit}
            className="text-xs h-8 gap-1.5 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
          >
            <Pencil className="w-3 h-3" /> Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onDelete}
            className="text-xs h-8 gap-1.5 border-red-500/20 text-red-400/70 hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/40"
          >
            <Trash2 className="w-3 h-3" /> Delete
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

/* ── Main Page ─────────────────────────────────────── */

function OutboundWebhooks({ canMutate }: { canMutate: boolean }) {
  const { user: _authUser } = useAuth();
  const queryClient = useQueryClient();
  const { data: webhooks = [], isLoading: loading } = useWebhooks();
  const [showForm, setShowForm] = useState(false);
  const [editingWebhook, setEditingWebhook] = useState<Webhook | null>(null);
  const [deliveriesWebhook, setDeliveriesWebhook] = useState<Webhook | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);
  const [saving, setSaving] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({});
  const [testingId, setTestingId] = useState<string | null>(null);

  const handleCreate = async (data: { url: string; events: string; secret: string; enabled: boolean }) => {
    setSaving(true);
    try {
      await apiFetch('/api/webhooks', {
        method: 'POST',
        body: JSON.stringify({
          url: data.url,
          events: data.events,
          enabled: data.enabled,
          ...(data.secret ? { secret: data.secret } : {}),
        }),
      });
      setShowForm(false);
      await queryClient.invalidateQueries();
    } catch (err) {
      console.error('Failed to create webhook:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async (id: string, data: { url: string; events: string; secret: string; enabled: boolean }) => {
    setSaving(true);
    try {
      const body: Record<string, any> = { url: data.url, events: data.events, enabled: data.enabled };
      if (data.secret) body.secret = data.secret;
      await apiFetch(`/api/webhooks/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      setEditingWebhook(null);
      await queryClient.invalidateQueries();
    } catch (err) {
      console.error('Failed to update webhook:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (webhook: Webhook) => {
    try {
      await apiFetch(`/api/webhooks/${webhook.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: !webhook.enabled }),
      });
      await queryClient.invalidateQueries();
    } catch (err) {
      console.error('Failed to toggle webhook:', err);
    }
  };

  const handleDelete = (id: string) => {
    setConfirmDialog({
      title: 'Delete Webhook',
      message: 'Delete this webhook?',
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await apiFetch(`/api/webhooks/${id}`, { method: 'DELETE' });
          await queryClient.invalidateQueries();
        } catch (err) {
          console.error('Failed to delete webhook:', err);
        }
      },
    });
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const result = await apiFetch<{ success: boolean; status?: number; error?: string }>(
        `/api/webhooks/${id}/test`,
        { method: 'POST' },
      );
      setTestResults(prev => ({
        ...prev,
        [id]: {
          success: result.success,
          message: result.success ? `Status ${result.status}` : (result.error ?? 'Failed'),
        },
      }));
    } catch (err: any) {
      setTestResults(prev => ({
        ...prev,
        [id]: { success: false, message: err.message ?? 'Failed' },
      }));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
            <Bell className="w-4 h-4 text-violet-400" />
            Outbound Webhooks
          </h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            Send armada events to external URLs when things happen.
          </p>
        </div>
        {canMutate && (
          <Button
            onClick={() => setShowForm(true)}
            className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9"
          >
            + Add Webhook
          </Button>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Webhook</DialogTitle>
          </DialogHeader>
          <WebhookForm
            onSubmit={handleCreate}
            onCancel={() => setShowForm(false)}
            loading={saving}
          />
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editingWebhook} onOpenChange={(open) => { if (!open) setEditingWebhook(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Webhook</DialogTitle>
          </DialogHeader>
          {editingWebhook && (
            <WebhookForm
              initial={editingWebhook}
              onSubmit={(data) => handleUpdate(editingWebhook.id, data)}
              onCancel={() => setEditingWebhook(null)}
              loading={saving}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Deliveries dialog */}
      {deliveriesWebhook && (
        <WebhookDeliveriesDialog
          webhookId={deliveriesWebhook.id}
          webhookUrl={deliveriesWebhook.url}
          open={!!deliveriesWebhook}
          onClose={() => setDeliveriesWebhook(null)}
        />
      )}

      {/* Table or empty state */}
      {(loading || webhooks.length > 0) ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-zinc-800">
                <TableHead className="px-4 py-3 text-left text-[11px] text-zinc-500 uppercase tracking-wider w-14">On</TableHead>
                <TableHead className="px-4 py-3 text-left text-[11px] text-zinc-500 uppercase tracking-wider">URL</TableHead>
                <TableHead className="px-4 py-3 text-left text-[11px] text-zinc-500 uppercase tracking-wider">Events</TableHead>
                <TableHead className="px-4 py-3 text-left text-[11px] text-zinc-500 uppercase tracking-wider whitespace-nowrap">Created</TableHead>
                <TableHead className="px-4 py-3 text-right text-[11px] text-zinc-500 uppercase tracking-wider">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && [1, 2, 3].map(i => <RowSkeleton key={i} cols={5} />)}
              {!loading && webhooks.map(webhook => (
                <WebhookRow
                  key={webhook.id}
                  webhook={webhook as Webhook}
                  onToggle={() => handleToggle(webhook as Webhook)}
                  onEdit={() => setEditingWebhook(webhook as Webhook)}
                  onDelete={() => handleDelete(webhook.id)}
                  onTest={() => handleTest(webhook.id)}
                  onDeliveries={() => setDeliveriesWebhook(webhook as Webhook)}
                  testResult={testResults[webhook.id] ?? null}
                  testing={testingId === webhook.id}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState
          icon={Bell}
          title="No webhooks configured"
          description="Add a webhook to receive notifications when armada events occur"
          action={canMutate ? { label: '+ Add Webhook', onClick: () => setShowForm(true) } : undefined}
        />
      )}

      {/* Supported events reference */}
      {!loading && webhooks.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
          <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-3">Supported Events</h3>
          <div className="flex flex-wrap gap-1.5">
            {EVENT_TYPES.map(ev => (
              <Badge key={ev} variant="secondary">
                {ev}
              </Badge>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDialog}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        confirmLabel="Delete"
        destructive
        onConfirm={() => confirmDialog?.onConfirm()}
        onCancel={() => setConfirmDialog(null)}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   INBOUND WEBHOOKS
   ═══════════════════════════════════════════════════════════════════ */

/* ── Types ─────────────────────────────────────────── */

interface InboundWebhook {
  id: string;
  name: string;
  hookId: string;
  secret: string | null;
  action: 'workflow' | 'task' | 'event';
  actionConfig: Record<string, any>;
  enabled: boolean;
  lastDeliveryAt: string | null;
  deliveryCount: number;
  createdAt: string;
  pendingAction?: string | null;
  pendingFields?: PendingFields | null;
}

/* ── CopyButton ────────────────────────────────────── */

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handle = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <Button
      variant="ghost" onClick={handle}
      className="ml-1.5 text-zinc-500 hover:text-zinc-300 transition-colors"
      title="Copy URL"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
    </Button>
  );
}

/* ── InboundWebhookForm ────────────────────────────── */

function InboundWebhookForm({
  initial,
  onSubmit,
  onCancel,
  loading,
}: {
  initial?: InboundWebhook;
  onSubmit: (data: { name: string; action: string; actionConfig: Record<string, any>; secret: string; enabled: boolean }) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [action, setAction] = useState<string>(initial?.action ?? 'event');
  const [secret, setSecret] = useState('');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  // actionConfig fields
  const [workflowId, setWorkflowId] = useState((initial?.actionConfig as any)?.workflowId ?? '');
  const [projectId, setProjectId] = useState((initial?.actionConfig as any)?.projectId ?? '');
  const [fromAgent, setFromAgent] = useState((initial?.actionConfig as any)?.fromAgent ?? 'webhook');
  const [toAgent, setToAgent] = useState((initial?.actionConfig as any)?.toAgent ?? '');
  const [taskText, setTaskText] = useState((initial?.actionConfig as any)?.taskText ?? '');
  const [eventName, setEventName] = useState((initial?.actionConfig as any)?.eventName ?? '');

  function buildConfig() {
    if (action === 'workflow') return { workflowId, projectId: projectId || undefined };
    if (action === 'task') return { fromAgent, toAgent: toAgent || undefined, taskText: taskText || undefined, projectId: projectId || undefined };
    return { eventName: eventName || undefined };
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-zinc-400 mb-1.5">Name</label>
        <Input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. GitHub PR trigger"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-zinc-400 mb-1.5">Action</label>
        <div className="flex gap-2">
          {(['workflow', 'task', 'event'] as const).map(a => (
            <Button
              variant="ghost" key={a}
              type="button"
              onClick={() => setAction(a)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors capitalize ${
                action === a
                  ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                  : 'bg-zinc-800/50 text-zinc-400 border border-zinc-800 hover:bg-zinc-700/50'
              }`}
            >
              {a}
            </Button>
          ))}
        </div>
      </div>

      {/* Action config fields */}
      {action === 'workflow' && (
        <div className="space-y-3 rounded-lg bg-zinc-900/50 border border-zinc-800 p-4">
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Workflow ID <span className="text-red-400">*</span></label>
            <Input type="text" value={workflowId} onChange={e => setWorkflowId(e.target.value)} placeholder="uuid of the workflow" />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Project ID <span className="text-zinc-600">(optional)</span></label>
            <Input type="text" value={projectId} onChange={e => setProjectId(e.target.value)} placeholder="pin run to a project" />
          </div>
        </div>
      )}

      {action === 'task' && (
        <div className="space-y-3 rounded-lg bg-zinc-900/50 border border-zinc-800 p-4">
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">From Agent</label>
            <Input type="text" value={fromAgent} onChange={e => setFromAgent(e.target.value)} placeholder="webhook" />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">To Agent <span className="text-zinc-600">(optional)</span></label>
            <Input type="text" value={toAgent} onChange={e => setToAgent(e.target.value)} placeholder="target agent name" />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Task Text Template <span className="text-zinc-600">(optional — payload appended if blank)</span></label>
            <Textarea value={taskText} onChange={e => setTaskText(e.target.value)} rows={3} placeholder="Task to create when webhook fires…" className="resize-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Project ID <span className="text-zinc-600">(optional)</span></label>
            <Input type="text" value={projectId} onChange={e => setProjectId(e.target.value)} placeholder="assign task to project" />
          </div>
        </div>
      )}

      {action === 'event' && (
        <div className="rounded-lg bg-zinc-900/50 border border-zinc-800 p-4">
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">Event Name <span className="text-zinc-600">(optional — defaults to webhook.inbound.&lt;hookId&gt;)</span></label>
          <Input type="text" value={eventName} onChange={e => setEventName(e.target.value)} placeholder="e.g. github.pr.merged" />
        </div>
      )}

      <div>
        <label className="block text-xs font-medium text-zinc-400 mb-1.5">
          Secret <span className="text-zinc-600">(optional, for HMAC-SHA256 verification)</span>
        </label>
        <Input
          type="password"
          value={secret}
          onChange={e => setSecret(e.target.value)}
          placeholder={initial ? '••••••' : 'Shared secret'}
        />
      </div>

      <div className="flex items-center gap-2">
        <Switch checked={enabled} onCheckedChange={setEnabled} />
        <span className="text-xs text-zinc-400">{enabled ? 'Enabled' : 'Disabled'}</span>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 transition-colors">
          Cancel
        </Button>
        <Button
          onClick={() => onSubmit({ name, action, actionConfig: buildConfig(), secret, enabled })}
          disabled={loading || !name || (action === 'workflow' && !workflowId)}
          className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9 disabled:opacity-50"
        >
          {loading ? 'Saving…' : initial ? 'Update' : 'Create'}
        </Button>
      </div>
    </div>
  );
}

/* ── InboundWebhookRow ─────────────────────────────── */

function InboundWebhookRow({
  hook,
  baseUrl,
  onToggle,
  onEdit,
  onDelete,
}: {
  hook: InboundWebhook;
  baseUrl: string;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { pf, rowClass, switchPf, badgePf } = usePendingStyle(hook.pendingFields, hook.pendingAction);
  const hookUrl = `${baseUrl}/hooks/${hook.hookId}`;
  const actionColors: Record<string, string> = {
    workflow: 'bg-blue-500/15 text-blue-300 border-blue-500/20',
    task: 'bg-amber-500/15 text-amber-300 border-amber-500/20',
    event: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20',
  };

  return (
    <TableRow className={`border-b border-zinc-800/50 hover:bg-zinc-800/40 transition-colors ${rowClass}`}>
      <TableCell className="px-4 py-3">
        <span className={switchPf('enabled')}>
          <Switch checked={hook.enabled} onCheckedChange={() => onToggle()} />
        </span>
      </TableCell>
      <TableCell className="px-4 py-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className={pf('name', 'text-sm font-medium text-zinc-200')}>{hook.name}</span>
            {hook.pendingAction && (
              <PendingBadge action={hook.pendingAction as 'create' | 'update' | 'delete'} />
            )}
          </div>
          <div className="flex items-center gap-1">
            <code className="text-xs text-zinc-400 bg-zinc-800/50 rounded px-2 py-0.5 max-w-xs truncate">
              POST /hooks/{hook.hookId}
            </code>
            <CopyButton text={hookUrl} />
          </div>
        </div>
      </TableCell>
      <TableCell className="px-4 py-3">
        <Badge className={`px-2 py-0.5 rounded-full text-xs border ${badgePf('action', actionColors[hook.action] ?? '')}`}>
          {hook.action}
        </Badge>
        {hook.secret && (
          <div className="flex items-center gap-1 text-xs text-zinc-500 mt-1">
            <Key className="w-3 h-3" /> Signed
          </div>
        )}
      </TableCell>
      <TableCell className="px-4 py-3 text-xs text-zinc-400 tabular-nums">
        {hook.deliveryCount > 0 ? (
          <div className="space-y-0.5">
            <div>{hook.deliveryCount} deliver{hook.deliveryCount === 1 ? 'y' : 'ies'}</div>
            {hook.lastDeliveryAt && (
              <div className="text-zinc-600">last: {relativeTime(hook.lastDeliveryAt)}</div>
            )}
          </div>
        ) : (
          <span className="text-zinc-600">—</span>
        )}
      </TableCell>
      <TableCell className="px-4 py-3 text-xs text-zinc-600 whitespace-nowrap">
        {relativeTime(hook.createdAt)}
      </TableCell>
      <TableCell className="px-4 py-3">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={onEdit}
            className="text-xs h-8 gap-1.5 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
          >
            <Pencil className="w-3 h-3" /> Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onDelete}
            className="text-xs h-8 gap-1.5 border-red-500/20 text-red-400/70 hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/40"
          >
            <Trash2 className="w-3 h-3" /> Delete
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

/* ── InboundWebhooksSection ────────────────────────── */

function InboundWebhooksSection({ canMutate }: { canMutate: boolean }) {
  const queryClient = useQueryClient();
  const { data: hooks = [], isLoading: loading } = useInboundWebhooks();
  const [showForm, setShowForm] = useState(false);
  const [editingHook, setEditingHook] = useState<InboundWebhook | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);

  const baseUrl = window.location.origin;

  const handleCreate = async (data: { name: string; action: string; actionConfig: Record<string, any>; secret: string; enabled: boolean }) => {
    setSaving(true);
    try {
      await apiFetch('/api/webhooks/inbound', {
        method: 'POST',
        body: JSON.stringify({
          name: data.name,
          action: data.action,
          actionConfig: data.actionConfig,
          enabled: data.enabled,
          ...(data.secret ? { secret: data.secret } : {}),
        }),
      });
      setShowForm(false);
      await queryClient.invalidateQueries();
    } catch (err) {
      console.error('Failed to create inbound webhook:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async (id: string, data: { name: string; action: string; actionConfig: Record<string, any>; secret: string; enabled: boolean }) => {
    setSaving(true);
    try {
      const body: Record<string, any> = { name: data.name, action: data.action, actionConfig: data.actionConfig, enabled: data.enabled };
      if (data.secret) body.secret = data.secret;
      await apiFetch(`/api/webhooks/inbound/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      setEditingHook(null);
      await queryClient.invalidateQueries();
    } catch (err) {
      console.error('Failed to update inbound webhook:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (hook: InboundWebhook) => {
    try {
      await apiFetch(`/api/webhooks/inbound/${hook.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: !hook.enabled }),
      });
      await queryClient.invalidateQueries();
    } catch (err) {
      console.error('Failed to toggle inbound webhook:', err);
    }
  };

  const handleDelete = (id: string) => {
    setConfirmDialog({
      title: 'Delete Inbound Webhook',
      message: 'Delete this inbound webhook? External services will no longer be able to trigger actions through it.',
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await apiFetch(`/api/webhooks/inbound/${id}`, { method: 'DELETE' });
          await queryClient.invalidateQueries();
        } catch (err) {
          console.error('Failed to delete inbound webhook:', err);
        }
      },
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
            <WebhookIcon className="w-4 h-4 text-violet-400" />
            Inbound Webhooks
          </h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            Expose endpoints that external services can POST to, triggering workflows, tasks, or events.
          </p>
        </div>
        {canMutate && (
          <Button
            onClick={() => setShowForm(true)}
            className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9"
          >
            + Add Inbound Webhook
          </Button>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Inbound Webhook</DialogTitle>
          </DialogHeader>
          <InboundWebhookForm
            onSubmit={handleCreate}
            onCancel={() => setShowForm(false)}
            loading={saving}
          />
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editingHook} onOpenChange={(open) => { if (!open) setEditingHook(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Inbound Webhook</DialogTitle>
          </DialogHeader>
          {editingHook && (
            <InboundWebhookForm
              initial={editingHook}
              onSubmit={(data) => handleUpdate(editingHook.id, data)}
              onCancel={() => setEditingHook(null)}
              loading={saving}
            />
          )}
        </DialogContent>
      </Dialog>

      {(loading || hooks.length > 0) ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-zinc-800">
                <TableHead className="px-4 py-3 text-left text-[11px] text-zinc-500 uppercase tracking-wider w-14">On</TableHead>
                <TableHead className="px-4 py-3 text-left text-[11px] text-zinc-500 uppercase tracking-wider">Name / Endpoint</TableHead>
                <TableHead className="px-4 py-3 text-left text-[11px] text-zinc-500 uppercase tracking-wider">Action</TableHead>
                <TableHead className="px-4 py-3 text-left text-[11px] text-zinc-500 uppercase tracking-wider">Deliveries</TableHead>
                <TableHead className="px-4 py-3 text-left text-[11px] text-zinc-500 uppercase tracking-wider whitespace-nowrap">Created</TableHead>
                <TableHead className="px-4 py-3 text-right text-[11px] text-zinc-500 uppercase tracking-wider">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && [1, 2, 3].map(i => <RowSkeleton key={i} cols={6} />)}
              {!loading && hooks.map(hook => (
                <InboundWebhookRow
                  key={hook.id}
                  hook={hook as InboundWebhook}
                  baseUrl={baseUrl}
                  onToggle={() => handleToggle(hook as InboundWebhook)}
                  onEdit={() => setEditingHook(hook as InboundWebhook)}
                  onDelete={() => handleDelete(hook.id)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState
          icon={WebhookIcon}
          title="No inbound webhooks configured"
          description="Create one to let external services trigger armada actions"
          action={canMutate ? { label: '+ Add Inbound Webhook', onClick: () => setShowForm(true) } : undefined}
        />
      )}

      <ConfirmDialog
        open={!!confirmDialog}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        confirmLabel="Delete"
        destructive
        onConfirm={() => confirmDialog?.onConfirm()}
        onCancel={() => setConfirmDialog(null)}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   COMBINED PAGE (tabs: Outbound / Inbound)
   ═══════════════════════════════════════════════════════════════════ */

export default function WebhooksPage() {
  const { hasScope } = useAuth();
  const canMutate = hasScope('webhooks:write');

  return (
    <div className="space-y-6">
      <PageHeader icon={Bell} title="Webhooks" subtitle="Configure webhooks to send and receive armada events" />

      <Tabs defaultValue="outbound">
        <TabsList>
          <TabsTrigger value="outbound" className="capitalize">Outbound</TabsTrigger>
          <TabsTrigger value="inbound" className="capitalize">Inbound</TabsTrigger>
        </TabsList>
        <TabsContent value="outbound">
          <OutboundWebhooks canMutate={canMutate} />
        </TabsContent>
        <TabsContent value="inbound">
          <InboundWebhooksSection canMutate={canMutate} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

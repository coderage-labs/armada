import { useState } from 'react';
import {
  Bell, Plus, Pencil, Trash2, FlaskConical, MessageSquare,
  Slack, Hash, Mail, CheckCircle2, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { EmptyState } from '../components/EmptyState';
import { RowSkeleton } from '../components/ui/skeleton';
import ConfirmDialog from '../components/ConfirmDialog';
import { ResponsiveDialog as Dialog, ResponsiveDialogContent as DialogContent, ResponsiveDialogHeader as DialogHeader, ResponsiveDialogTitle as DialogTitle } from '../components/ui/responsive-dialog';
import {
  useNotificationChannels,
  useCreateNotificationChannel,
  useUpdateNotificationChannel,
  useDeleteNotificationChannel,
  useTestNotificationChannel,
} from '../hooks/queries/useNotificationChannels';
import type { NotificationChannel } from '../hooks/queries/useNotificationChannels';

// ── Channel type metadata ──────────────────────────────────────────────

const CHANNEL_TYPES = [
  { value: 'telegram',  label: 'Telegram',  icon: MessageSquare, color: 'text-sky-400' },
  { value: 'slack',     label: 'Slack',     icon: Slack,         color: 'text-yellow-400' },
  { value: 'discord',   label: 'Discord',   icon: Hash,          color: 'text-indigo-400' },
  { value: 'email',     label: 'Email',     icon: Mail,          color: 'text-emerald-400' },
] as const;

type ChannelType = (typeof CHANNEL_TYPES)[number]['value'];

function channelTypeMeta(type: string) {
  return CHANNEL_TYPES.find(t => t.value === type) ?? CHANNEL_TYPES[0];
}

// ── Config fields per channel type ────────────────────────────────────

interface FieldDef { key: string; label: string; placeholder: string; secret?: boolean }

const CONFIG_FIELDS: Record<ChannelType, FieldDef[]> = {
  telegram: [
    { key: 'token',   label: 'Bot Token',   placeholder: '123456:ABC-DEF…', secret: true },
    { key: 'chat_id', label: 'Chat ID',      placeholder: '-1001234567890' },
  ],
  slack: [
    { key: 'webhook_url', label: 'Webhook URL', placeholder: 'https://hooks.slack.com/services/…', secret: true },
  ],
  discord: [
    { key: 'webhook_url', label: 'Webhook URL', placeholder: 'https://discord.com/api/webhooks/…', secret: true },
  ],
  email: [
    { key: 'smtp_host',     label: 'SMTP Host',         placeholder: 'smtp.example.com' },
    { key: 'smtp_port',     label: 'SMTP Port',         placeholder: '587' },
    { key: 'smtp_user',     label: 'Username',          placeholder: 'user@example.com' },
    { key: 'smtp_pass',     label: 'Password',          placeholder: '••••••••', secret: true },
    { key: 'from_address',  label: 'From Address',      placeholder: 'armada@example.com' },
    { key: 'to_address',    label: 'To Address',        placeholder: 'alerts@example.com' },
  ],
};

// ── Channel Form ──────────────────────────────────────────────────────

function ChannelForm({
  initial,
  onSubmit,
  onCancel,
  loading,
}: {
  initial?: NotificationChannel;
  onSubmit: (data: { type: ChannelType; name: string; enabled: boolean; config: Record<string, string> }) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const [type, setType] = useState<ChannelType>((initial?.type as ChannelType) ?? 'telegram');
  const [name, setName] = useState(initial?.name ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [config, setConfig] = useState<Record<string, string>>(() => {
    if (!initial) return {};
    return Object.fromEntries(
      Object.entries(initial.config).map(([k, v]) => [k, String(v)]),
    );
  });

  const fields = CONFIG_FIELDS[type] ?? [];

  const handleTypeChange = (t: ChannelType) => {
    setType(t);
    setConfig({}); // reset config when type changes
  };

  const setField = (key: string, value: string) =>
    setConfig(prev => ({ ...prev, [key]: value }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { toast.error('Name is required'); return; }
    onSubmit({ type, name: name.trim(), enabled, config });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Type selector */}
      <div>
        <label className="block text-xs font-medium text-zinc-400 mb-1.5">Channel Type</label>
        <div className="grid grid-cols-2 gap-2">
          {CHANNEL_TYPES.map(t => {
            const Icon = t.icon;
            const active = type === t.value;
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => handleTypeChange(t.value)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${
                  active
                    ? 'border-zinc-500 bg-zinc-700 text-zinc-100'
                    : 'border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300'
                }`}
              >
                <Icon className={`w-4 h-4 ${active ? t.color : ''}`} />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Name */}
      <div>
        <label className="block text-xs font-medium text-zinc-400 mb-1.5">Display Name</label>
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Armada Alerts"
          className="bg-zinc-800 border-zinc-700 text-zinc-100"
        />
      </div>

      {/* Config fields */}
      {fields.map(f => (
        <div key={f.key}>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">{f.label}</label>
          <Input
            type={f.secret ? 'password' : 'text'}
            value={config[f.key] ?? ''}
            onChange={e => setField(f.key, e.target.value)}
            placeholder={f.placeholder}
            className="bg-zinc-800 border-zinc-700 text-zinc-100 font-mono text-xs"
          />
        </div>
      ))}

      {/* Enable toggle */}
      <div className="flex items-center justify-between py-2 border-t border-zinc-800">
        <span className="text-sm text-zinc-300">Enabled</span>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={loading} className="flex-1">
          {loading ? 'Saving…' : initial ? 'Save Changes' : 'Add Channel'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} className="flex-1 border-zinc-700">
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ── Channel Row ───────────────────────────────────────────────────────

function ChannelRow({
  channel,
  onEdit,
  onDelete,
  onTest,
  onToggle,
  testing,
}: {
  channel: NotificationChannel;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  onToggle: (enabled: boolean) => void;
  testing: boolean;
}) {
  const meta = channelTypeMeta(channel.type);
  const Icon = meta.icon;

  return (
    <div className="flex items-center gap-4 px-4 py-3 bg-zinc-900 rounded-xl border border-zinc-800 hover:border-zinc-700 transition-colors">
      {/* Icon */}
      <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-zinc-800 shrink-0">
        <Icon className={`w-4 h-4 ${meta.color}`} />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-100 truncate">{channel.name}</span>
          <Badge variant="outline" className="border-zinc-700 text-zinc-400 text-xs capitalize shrink-0">
            {channel.type}
          </Badge>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          {channel.enabled ? (
            <CheckCircle2 className="w-3 h-3 text-emerald-400" />
          ) : (
            <XCircle className="w-3 h-3 text-zinc-500" />
          )}
          <span className="text-xs text-zinc-500">{channel.enabled ? 'Active' : 'Disabled'}</span>
        </div>
      </div>

      {/* Toggle */}
      <Switch
        checked={channel.enabled}
        onCheckedChange={onToggle}
        className="shrink-0"
      />

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="outline"
          size="sm"
          onClick={onTest}
          disabled={testing}
          className="border-zinc-700 text-zinc-400 hover:text-zinc-100 h-8 px-2"
          title="Send test message"
        >
          <FlaskConical className="w-3.5 h-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onEdit}
          className="border-zinc-700 text-zinc-400 hover:text-zinc-100 h-8 px-2"
          title="Edit"
        >
          <Pencil className="w-3.5 h-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onDelete}
          className="border-zinc-700 text-zinc-400 hover:text-red-400 h-8 px-2"
          title="Delete"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────

export default function Notifications() {
  const { data: channels, isLoading } = useNotificationChannels();
  const createMutation = useCreateNotificationChannel();
  const updateMutation = useUpdateNotificationChannel();
  const deleteMutation = useDeleteNotificationChannel();
  const testMutation = useTestNotificationChannel();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<NotificationChannel | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<NotificationChannel | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const openCreate = () => { setEditingChannel(null); setDialogOpen(true); };
  const openEdit = (ch: NotificationChannel) => { setEditingChannel(ch); setDialogOpen(true); };
  const closeDialog = () => { setDialogOpen(false); setEditingChannel(null); };

  const handleSubmit = async (data: { type: string; name: string; enabled: boolean; config: Record<string, string> }) => {
    try {
      if (editingChannel) {
        await updateMutation.mutateAsync({ id: editingChannel.id, ...data } as any);
        toast.success('Channel updated');
      } else {
        await createMutation.mutateAsync(data as any);
        toast.success('Channel created');
      }
      closeDialog();
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to save channel');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      toast.success(`Deleted "${deleteTarget.name}"`);
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to delete channel');
    } finally {
      setDeleteTarget(null);
    }
  };

  const handleTest = async (channel: NotificationChannel) => {
    setTestingId(channel.id);
    try {
      await testMutation.mutateAsync(channel.id);
      toast.success(`Test message sent to "${channel.name}"`);
    } catch (err: any) {
      toast.error(`Test failed: ${err.message ?? 'Unknown error'}`);
    } finally {
      setTestingId(null);
    }
  };

  const handleToggle = async (channel: NotificationChannel, enabled: boolean) => {
    try {
      await updateMutation.mutateAsync({ id: channel.id, enabled });
      toast.success(enabled ? `Enabled "${channel.name}"` : `Disabled "${channel.name}"`);
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to update channel');
    }
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Bell}
        title="Notifications"
        subtitle="Configure where Armada alerts are delivered"
        color="violet"
      >
        <Button
          variant="outline"
          size="sm"
          onClick={openCreate}
          className="border-zinc-700 text-zinc-300 hover:text-zinc-100 gap-1.5"
        >
          <Plus className="w-4 h-4" />
          Add Channel
        </Button>
      </PageHeader>

      {/* Channel list */}
      <div className="space-y-2">
        {isLoading ? (
          <div className="space-y-2">
            <RowSkeleton />
            <RowSkeleton />
            <RowSkeleton />
          </div>
        ) : !channels?.length ? (
          <EmptyState
            icon={Bell}
            title="No notification channels configured"
            description="Add a channel to receive alerts when changesets apply, operations complete, or instances fail."
            action={{ label: 'Add Channel', onClick: openCreate }}
          />
        ) : (
          channels.map(ch => (
            <ChannelRow
              key={ch.id}
              channel={ch}
              onEdit={() => openEdit(ch)}
              onDelete={() => setDeleteTarget(ch)}
              onTest={() => handleTest(ch)}
              onToggle={enabled => handleToggle(ch, enabled)}
              testing={testingId === ch.id}
            />
          ))
        )}
      </div>

      {/* Add/Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={open => { if (!open) closeDialog(); }}>
        <DialogContent className="bg-zinc-900 border-zinc-800 text-zinc-100 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingChannel ? 'Edit Channel' : 'Add Notification Channel'}</DialogTitle>
          </DialogHeader>
          <ChannelForm
            initial={editingChannel ?? undefined}
            onSubmit={handleSubmit}
            onCancel={closeDialog}
            loading={isSaving}
          />
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Notification Channel"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

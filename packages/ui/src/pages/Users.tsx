import { useEffect, useState, useCallback, useRef } from 'react';
import { apiFetch } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';
import { useUsers } from '../hooks/useUsers';
import { formatDate, formatDateTime } from '../lib/dates';
import type { ArmadaUser } from '@coderage-labs/armada-shared';
import { Users as UsersIcon, Trash2, Pencil, User, Bot, Palette, Loader2, Mail, Copy, Check, Clock, Fingerprint, Shield, Key, Lock } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Checkbox } from '../components/ui/checkbox';
import RegisterPasskey from '../components/RegisterPasskey';
import ConfirmDialog from '../components/ConfirmDialog';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { RowSkeleton } from '../components/ui/skeleton';
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '../components/ui/table';
import { EmptyState } from '../components/EmptyState';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/dialog';
import { useSSEEvent } from '../providers/SSEProvider';

function TypeBadge({ type }: { type: string }) {
  const isHuman = type === 'human';
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${
      isHuman
        ? 'bg-blue-500/20 text-blue-300 border-blue-500/20'
        : 'bg-violet-500/20 text-violet-300 border-violet-500/20'
    }`}>
      {isHuman ? <User className="w-3 h-3" /> : <Bot className="w-3 h-3" />}
      {isHuman ? 'Human' : 'Agent'}
    </span>
  );
}

function RoleBadge({ role }: { role: string }) {
  const colors: Record<string, string> = {
    owner: 'bg-amber-500/20 text-amber-300 border-amber-500/20',
    operator: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/20',
    viewer: 'bg-zinc-500/20 text-zinc-300 border-zinc-500/20',
  };
  return (
    <Badge className={`text-xs font-medium px-2 py-0.5 rounded-full border ${colors[role] || colors.viewer}`}>
      {role.charAt(0).toUpperCase() + role.slice(1)}
    </Badge>
  );
}

interface UserFormData {
  name: string;
  displayName: string;
  type: 'human' | 'operator';
  role: 'owner' | 'operator' | 'viewer';
  linkedAccounts: { telegram?: string; github?: string; email?: string; callbackUrl?: string; hooksToken?: string };
  notifications: {
    channels: string[];
    telegram?: { chatId: string };
    email?: { address: string };
    webhook?: { url: string };
    preferences: { gates: boolean; completions: boolean; failures: boolean; quietHours?: { start: string; end: string } };
  };
}

const emptyForm: UserFormData = {
  name: '',
  displayName: '',
  type: 'operator',
  role: 'viewer',
  linkedAccounts: {},
  notifications: { channels: [], preferences: { gates: false, completions: false, failures: false } },
};

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-sm font-medium text-zinc-300 mb-3">{children}</h3>
  );
}

function UserDialog({
  open,
  user,
  onClose,
  onSave,
}: {
  open: boolean;
  user: ArmadaUser | null;
  onClose: () => void;
  onSave: (data: UserFormData) => Promise<void>;
}) {
  const [form, setForm] = useState<UserFormData>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (user) {
      setForm({
        name: user.name,
        displayName: user.displayName,
        type: user.type,
        role: user.role,
        linkedAccounts: { ...user.linkedAccounts } as UserFormData['linkedAccounts'],
        notifications: {
          channels: user.notifications?.channels ?? [],
          telegram: user.notifications?.telegram,
          email: user.notifications?.email,
          webhook: user.notifications?.webhook,
          preferences: {
            ...(user.notifications?.preferences ?? { gates: false, completions: false, failures: false }),
          },
        },
      });
    } else {
      setForm(emptyForm);
    }
    setError('');
  }, [user, open]);

  const isHuman = form.type === 'human';

  const toggleChannel = (ch: string) => {
    const channels = form.notifications.channels.includes(ch)
      ? form.notifications.channels.filter((c) => c !== ch)
      : [...form.notifications.channels, ch];
    setForm({ ...form, notifications: { ...form.notifications, channels } });
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.displayName.trim()) {
      setError('Name and display name are required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave(form);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{user ? 'Edit User' : 'Create User'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-300 text-sm rounded-lg px-4 py-2">
              {error}
            </div>
          )}

          {/* Type Toggle */}
          <div>
            <label className="block text-sm text-zinc-400 mb-2">Type</label>
            {user ? (
              <div className="flex gap-2">
                <span className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border opacity-70 cursor-not-allowed ${
                  form.type === 'human'
                    ? 'bg-blue-500/20 text-blue-300 border-blue-500/30'
                    : 'bg-violet-500/20 text-violet-300 border-violet-500/30'
                }`}>
                  {form.type === 'human' ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                  {form.type.charAt(0).toUpperCase() + form.type.slice(1)}
                </span>
                <span className="self-center text-xs text-zinc-600">Type cannot be changed after creation</span>
              </div>
            ) : (
              <div className="flex gap-2">
                {(['human', 'operator'] as const).map((t) => (
                  <Button
                    variant="ghost" key={t}
                    type="button"
                    onClick={() => setForm({ ...form, type: t })}
                    className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border transition-colors ${
                      form.type === t
                        ? t === 'human'
                          ? 'bg-blue-500/20 text-blue-300 border-blue-500/30'
                          : 'bg-violet-500/20 text-violet-300 border-violet-500/30'
                        : 'bg-zinc-800/50 text-zinc-400 border-zinc-800 hover:bg-zinc-700/50'
                    }`}
                  >
                    {t === 'human' ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </Button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm text-zinc-400 mb-1">Username</label>
            <Input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
              disabled={!!user}
              className="w-full"
              placeholder="e.g. admin"
            />
          </div>

          <div>
            <label className="block text-sm text-zinc-400 mb-1">Display Name</label>
            <Input
              type="text"
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              className="w-full"
              placeholder="e.g. Chris"
            />
          </div>

          <div>
            <label className="block text-sm text-zinc-400 mb-1">Role</label>
            <Select
              value={form.role}
              onValueChange={(v) => setForm({ ...form, role: v as 'owner' | 'operator' | 'viewer' })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="owner">Owner</SelectItem>
                <SelectItem value="operator">Operator</SelectItem>
                <SelectItem value="viewer">Viewer</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* ── Human-specific fields ── */}
          {isHuman && (
            <div className="space-y-4 animate-in fade-in duration-200">
              {/* Notification Channels */}
              <div className="border-t border-zinc-800 pt-4">
                <SectionHeading>Notification Channels</SectionHeading>
                <div className="space-y-2">
                  {(['telegram', 'webhook'] as const).map((ch) => (
                    <Checkbox
                      key={ch}
                      checked={form.notifications.channels.includes(ch)}
                      onChange={() => toggleChannel(ch)}
                      label={ch.charAt(0).toUpperCase() + ch.slice(1)}
                    />
                  ))}
                </div>

                {/* Conditional channel detail fields */}
                <div className="mt-3 space-y-2">
                  {form.notifications.channels.includes('telegram') && (
                    <div className="animate-in fade-in duration-150">
                      <label className="block text-xs text-zinc-500 mb-1">Telegram Chat ID</label>
                      <Input
                        type="text"
                        value={form.notifications.telegram?.chatId ?? ''}
                        onChange={(e) => setForm({
                          ...form,
                          notifications: {
                            ...form.notifications,
                            telegram: { chatId: e.target.value },
                          },
                        })}
                        className="w-full"
                        placeholder="e.g. 123456789"
                      />
                    </div>
                  )}
                  {form.notifications.channels.includes('webhook') && (
                    <div className="animate-in fade-in duration-150">
                      <label className="block text-xs text-zinc-500 mb-1">Webhook URL</label>
                      <Input
                        type="text"
                        value={form.notifications.webhook?.url ?? ''}
                        onChange={(e) => setForm({
                          ...form,
                          notifications: {
                            ...form.notifications,
                            webhook: { url: e.target.value },
                          },
                        })}
                        className="w-full"
                        placeholder="https://hooks.example.com/notify"
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Notification Preferences */}
              <div className="border-t border-zinc-800 pt-4">
                <SectionHeading>Notification Preferences</SectionHeading>
                <div className="space-y-2">
                  {(['gates', 'completions', 'failures'] as const).map((pref) => (
                    <Checkbox
                      key={pref}
                      checked={form.notifications.preferences[pref]}
                      onChange={(v) => setForm({
                        ...form,
                        notifications: {
                          ...form.notifications,
                          preferences: { ...form.notifications.preferences, [pref]: v },
                        },
                      })}
                      label={pref.charAt(0).toUpperCase() + pref.slice(1)}
                    />
                  ))}
                </div>
              </div>

              {/* Quiet Hours */}
              <div className="border-t border-zinc-800 pt-4">
                <SectionHeading>Quiet Hours (optional)</SectionHeading>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Start</label>
                    <Input
                      type="time"
                      value={form.notifications.preferences.quietHours?.start ?? ''}
                      onChange={(e) => setForm({
                        ...form,
                        notifications: {
                          ...form.notifications,
                          preferences: {
                            ...form.notifications.preferences,
                            quietHours: {
                              start: e.target.value,
                              end: form.notifications.preferences.quietHours?.end ?? '',
                            },
                          },
                        },
                      })}
                      className="w-full"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">End</label>
                    <Input
                      type="time"
                      value={form.notifications.preferences.quietHours?.end ?? ''}
                      onChange={(e) => setForm({
                        ...form,
                        notifications: {
                          ...form.notifications,
                          preferences: {
                            ...form.notifications.preferences,
                            quietHours: {
                              start: form.notifications.preferences.quietHours?.start ?? '',
                              end: e.target.value,
                            },
                          },
                        },
                      })}
                      className="w-full"
                    />
                  </div>
                </div>
              </div>

              {/* Linked Accounts (Human) */}
              <div className="border-t border-zinc-800 pt-4">
                <SectionHeading>Linked Accounts</SectionHeading>
                <div className="space-y-2">
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">GitHub Username</label>
                    <Input
                      type="text"
                      value={form.linkedAccounts.github ?? ''}
                      onChange={(e) => setForm({ ...form, linkedAccounts: { ...form.linkedAccounts, github: e.target.value || undefined } })}
                      className="w-full"
                      placeholder="e.g. octocat"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Email</label>
                    <Input
                      type="text"
                      value={form.linkedAccounts.email ?? ''}
                      onChange={(e) => setForm({ ...form, linkedAccounts: { ...form.linkedAccounts, email: e.target.value || undefined } })}
                      className="w-full"
                      placeholder="e.g. user@example.com"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Agent-specific fields ── */}
          {!isHuman && (
            <div className="space-y-4 animate-in fade-in duration-200">
              {/* Operator Connection */}
              <div className="border-t border-zinc-800 pt-4">
                <SectionHeading>Operator Connection</SectionHeading>
                <div className="space-y-2">
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Callback URL</label>
                    <Input
                      type="text"
                      placeholder="http://openclaw-instance:18789"
                      value={form.linkedAccounts.callbackUrl ?? ''}
                      onChange={(e) => setForm({
                        ...form,
                        linkedAccounts: { ...form.linkedAccounts, callbackUrl: e.target.value || undefined },
                      })}
                      className="w-full"
                    />
                    <p className="text-xs text-zinc-600 mt-1">How the armada reaches this operator</p>
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Hooks Token</label>
                    <Input
                      type="password"
                      placeholder="Bearer token for callbacks"
                      value={form.linkedAccounts.hooksToken ?? ''}
                      onChange={(e) => setForm({
                        ...form,
                        linkedAccounts: { ...form.linkedAccounts, hooksToken: e.target.value || undefined },
                      })}
                      className="w-full"
                    />
                  </div>
                </div>
              </div>

              {/* Linked Accounts (Agent) */}
              <div className="border-t border-zinc-800 pt-4">
                <SectionHeading>Linked Accounts</SectionHeading>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">GitHub Username</label>
                  <Input
                    type="text"
                    value={form.linkedAccounts.github ?? ''}
                    onChange={(e) => setForm({ ...form, linkedAccounts: { ...form.linkedAccounts, github: e.target.value || undefined } })}
                    className="w-full"
                    placeholder="For PR attribution"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-violet-600 hover:bg-violet-700 text-white"
          >
            {saving ? 'Saving…' : user ? 'Update' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface Invite {
  id: string;
  created_by: string;
  role: string;
  display_name: string | null;
  expires_at: string;
  used_at: string | null;
  used_by: string | null;
  created_at: string;
}

function InviteDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [role, setRole] = useState<'operator' | 'viewer'>('viewer');
  const [displayName, setDisplayName] = useState('');
  const [creating, setCreating] = useState(false);
  const [inviteUrl, setInviteUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setRole('viewer');
      setDisplayName('');
      setInviteUrl('');
      setCopied(false);
      setError('');
    }
  }, [open]);

  async function handleCreate() {
    setCreating(true);
    setError('');
    try {
      const data = await apiFetch<{ id: string; inviteUrl: string; expiresAt: string }>('/api/auth/invites', {
        method: 'POST',
        body: JSON.stringify({ role, displayName: displayName.trim() || undefined }),
      });
      setInviteUrl(data.inviteUrl);
      onCreated();
    } catch (err: any) {
      setError(err.message || 'Failed to create invite');
    } finally {
      setCreating(false);
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="w-5 h-5" /> Invite User
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-300 text-sm rounded-lg px-4 py-2">
              {error}
            </div>
          )}

          {inviteUrl ? (
            <div className="space-y-3">
              <p className="text-sm text-zinc-400">Share this link with the person you want to invite:</p>
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  readOnly
                  value={inviteUrl}
                  className="flex-1 font-mono"
                />
                <Button
                  onClick={handleCopy}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-violet-600 hover:bg-violet-500 rounded-lg transition-colors shrink-0"
                >
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <p className="text-xs text-zinc-600">Link expires in 24 hours</p>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Role</label>
                <Select value={role} onValueChange={(v) => setRole(v as 'operator' | 'viewer')}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="operator">Operator</SelectItem>
                    <SelectItem value="viewer">Viewer</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="block text-sm text-zinc-400 mb-1">Display Name (optional)</label>
                <Input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full"
                  placeholder="e.g. Jane Smith"
                />
                <p className="text-xs text-zinc-600 mt-1">Pre-fills the display name for the invited user</p>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {inviteUrl ? 'Done' : 'Cancel'}
          </Button>
          {!inviteUrl && (
            <Button
              onClick={handleCreate}
              disabled={creating}
              className="bg-violet-600 hover:bg-violet-700 text-white"
            >
              {creating ? 'Creating…' : 'Generate Invite Link'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── My Account — Passkey Management ───────────────── */

interface Passkey {
  id: string;
  label: string;
  createdAt: string;
}

function PasskeyRow({ pk, onDelete, onRename, deletingId }: {
  pk: Passkey;
  onDelete: (id: string) => void;
  onRename: (id: string, label: string) => void;
  deletingId: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(pk.label || 'Passkey');

  function handleSave() {
    const trimmed = label.trim();
    if (trimmed && trimmed !== pk.label) {
      onRename(pk.id, trimmed);
    }
    setEditing(false);
  }

  return (
    <div className="flex items-center justify-between bg-zinc-800/50 rounded-lg px-3 py-2 text-sm">
      <div className="flex items-center gap-2 min-w-0">
        <Fingerprint className="w-4 h-4 text-violet-400 shrink-0" />
        {editing ? (
          <Input
            value={label}
            onChange={e => setLabel(e.target.value)}
            onBlur={handleSave}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setLabel(pk.label || 'Passkey'); setEditing(false); } }}
            autoFocus
            className="h-6 text-sm bg-zinc-900 border-zinc-700 px-2 py-0"
          />
        ) : (
          <>
            <span className="text-zinc-200 truncate">{pk.label || 'Passkey'}</span>
            <button onClick={() => setEditing(true)} className="text-zinc-500 hover:text-zinc-300 transition" title="Rename">
              <Pencil className="w-3 h-3" />
            </button>
          </>
        )}
        <span className="text-[10px] text-zinc-500 shrink-0">
          Added {formatDate(pk.createdAt)}
        </span>
      </div>
      <Button
        variant="ghost" onClick={() => onDelete(pk.id)}
        disabled={deletingId === pk.id}
        className="text-red-400/60 hover:text-red-400 transition disabled:opacity-50"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}

function MyAccount() {
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [showRegister, setShowRegister] = useState(false);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchPasskeys = useCallback(async () => {
    try {
      const data = await apiFetch<Passkey[]>('/api/auth/passkeys');
      setPasskeys(data);
    } catch {
      // endpoint may not exist yet
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPasskeys(); }, [fetchPasskeys]);

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      await apiFetch(`/api/auth/passkeys/${id}`, { method: 'DELETE' });
      await fetchPasskeys();
    } catch {
      // silent
    } finally {
      setDeletingId(null);
    }
  }

  async function handleRename(id: string, label: string) {
    try {
      await apiFetch(`/api/auth/passkeys/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ label }),
      });
      await fetchPasskeys();
    } catch {
      // silent
    }
  }

  return (
    <div className="bg-zinc-800/50 border border-zinc-800 rounded-lg p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-violet-400" />
          <h2 className="text-sm font-semibold text-zinc-200">My Account</h2>
        </div>
        {!showRegister && (
          <Button
            variant="ghost" onClick={() => setShowRegister(true)}
            className="flex items-center gap-1.5 text-xs text-violet-300 hover:text-violet-200 transition"
          >
            <Fingerprint className="w-3.5 h-3.5" /> Add Passkey
          </Button>
        )}
      </div>

      {loading ? (
        <div className="text-xs text-zinc-500">Loading passkeys…</div>
      ) : passkeys.length === 0 && !showRegister ? (
        <div className="text-xs text-zinc-500 flex items-center gap-2">
          <Fingerprint className="w-4 h-4 text-amber-400" />
          No passkeys registered. Add one to enable passwordless login.
        </div>
      ) : (
        <div className="space-y-2">
          {passkeys.map(pk => (
            <PasskeyRow key={pk.id} pk={pk} onDelete={handleDelete} onRename={handleRename} deletingId={deletingId} />
          ))}
        </div>
      )}

      {showRegister && (
        <div className="border-t border-zinc-800 pt-4">
          <RegisterPasskey
            onSuccess={() => {
              setShowRegister(false);
              fetchPasskeys();
            }}
          />
        </div>
      )}
    </div>
  );
}

/* ── User Credentials Dialog (owner-only) ──────────── */

interface UserPasskey {
  id: string;
  label: string;
  createdAt: string;
}

function CredentialsDialog({
  user,
  onClose,
}: {
  user: ArmadaUser | null;
  onClose: () => void;
}) {
  const [passkeys, setPasskeys] = useState<UserPasskey[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showResetPw, setShowResetPw] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [resetting, setResetting] = useState(false);
  const [pwMsg, setPwMsg] = useState('');

  const fetchPasskeys = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const data = await apiFetch<UserPasskey[]>(`/api/users/${user.id}/passkeys`);
      setPasskeys(data);
    } catch {
      // silent — may not have permission
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (user) {
      fetchPasskeys();
      setShowResetPw(false);
      setNewPassword('');
      setPwMsg('');
    }
  }, [user, fetchPasskeys]);

  async function handleDeletePasskey(id: string) {
    if (!user) return;
    setDeletingId(id);
    try {
      await apiFetch(`/api/users/${user.id}/passkeys/${id}`, { method: 'DELETE' });
      await fetchPasskeys();
    } catch {
      // silent
    } finally {
      setDeletingId(null);
    }
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!newPassword || resetting || !user) return;
    setResetting(true);
    setPwMsg('');
    try {
      await apiFetch(`/api/users/${user.id}/password`, {
        method: 'PUT',
        body: JSON.stringify({ password: newPassword }),
      });
      setPwMsg('Password reset successfully.');
      setNewPassword('');
      setShowResetPw(false);
    } catch (err: any) {
      setPwMsg(err.message ?? 'Failed to reset password');
    } finally {
      setResetting(false);
    }
  }

  return (
    <Dialog open={!!user} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-violet-400" />
            Credentials — {user?.displayName ?? user?.name}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <p className="text-xs text-zinc-500 mb-2 font-medium uppercase tracking-wider">Passkeys</p>
            {loading ? (
              <p className="text-xs text-zinc-500">Loading…</p>
            ) : passkeys.length === 0 ? (
              <p className="text-xs text-zinc-600">No passkeys registered.</p>
            ) : (
              <div className="space-y-1">
                {passkeys.map(pk => (
                  <div key={pk.id} className="flex items-center justify-between bg-zinc-800/50 rounded-lg px-3 py-2 text-sm">
                    <div className="flex items-center gap-2">
                      <Fingerprint className="w-4 h-4 text-violet-400" />
                      <span className="text-zinc-300">{pk.label || 'Passkey'}</span>
                      <span className="text-xs text-zinc-500">{formatDate(pk.createdAt)}</span>
                    </div>
                    <Button
                      variant="ghost"
                      onClick={() => handleDeletePasskey(pk.id)}
                      disabled={deletingId === pk.id}
                      className="text-red-400/60 hover:text-red-400 transition disabled:opacity-40"
                      title="Remove passkey"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-zinc-800 pt-4">
            <p className="text-xs text-zinc-500 mb-2 font-medium uppercase tracking-wider">Password</p>
            {!showResetPw ? (
              <Button
                variant="ghost"
                onClick={() => { setShowResetPw(true); setPwMsg(''); }}
                className="flex items-center gap-1.5 text-xs text-amber-400/70 hover:text-amber-400 transition-colors"
              >
                <Lock className="w-3 h-3" /> Reset Password
              </Button>
            ) : (
              <form onSubmit={handleResetPassword} className="space-y-2">
                <Input
                  type="password"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  placeholder="New password (min 8 chars)"
                  minLength={8}
                />
                <div className="flex gap-2">
                  <Button
                    type="submit"
                    disabled={newPassword.length < 8 || resetting}
                    className="bg-amber-600/80 hover:bg-amber-500 text-white text-xs disabled:opacity-40"
                  >
                    {resetting ? 'Saving…' : 'Set Password'}
                  </Button>
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => { setShowResetPw(false); setNewPassword(''); setPwMsg(''); }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}
            {pwMsg && <p className="text-xs text-emerald-400 mt-1">{pwMsg}</p>}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Add Agent Dialog ───────────────────────────────── */

function AddAgentDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<'operator' | 'viewer'>('operator');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [createdToken, setCreatedToken] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setDisplayName('');
      setRole('operator');
      setSaving(false);
      setError('');
      setCreatedToken('');
      setCopied(false);
    }
  }, [open]);

  async function handleCreate() {
    if (!name.trim() || !displayName.trim()) {
      setError('Name and display name are required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const user = await apiFetch<{ id: string }>('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          displayName: displayName.trim(),
          type: 'operator',
          role,
          linkedAccounts: {},
          notifications: { channels: [], preferences: { gates: false, completions: false, failures: false } },
        }),
      });
      try {
        const tokenData = await apiFetch<{ token: string }>('/api/auth/tokens', {
          method: 'POST',
          body: JSON.stringify({ userId: user.id, label: `${name.trim()} API token` }),
        });
        setCreatedToken(tokenData.token);
      } catch {
        // Token generation failed — close dialog since there's nothing more to show
        onCreated();
        onClose();
        return;
      }
      onCreated();
    } catch (err: any) {
      setError(err.message || 'Failed to create agent');
    } finally {
      setSaving(false);
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(createdToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-violet-400" /> Add Agent
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-300 text-sm rounded-lg px-4 py-2">
              {error}
            </div>
          )}

          {createdToken ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-emerald-400 text-sm font-medium">
                <Check className="w-4 h-4" /> Agent created successfully
              </div>
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-3 space-y-2">
                <div className="flex items-center gap-2 text-xs text-amber-300 font-medium">
                  <Key className="w-3.5 h-3.5" /> API Token — copy now, it won't be shown again
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    readOnly
                    value={createdToken}
                    className="flex-1 bg-zinc-800/50 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono min-w-0"
                  />
                  <Button
                    variant="ghost" onClick={handleCopy}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-violet-600 hover:bg-violet-500 rounded-lg shrink-0"
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Username</label>
                <Input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  className="w-full"
                  placeholder="e.g. robin"
                />
              </div>

              <div>
                <label className="block text-sm text-zinc-400 mb-1">Display Name</label>
                <Input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full"
                  placeholder="e.g. Robin"
                />
              </div>

              <div>
                <label className="block text-sm text-zinc-400 mb-1">Role</label>
                <Select value={role} onValueChange={(v) => setRole(v as 'operator' | 'viewer')}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="operator">Operator</SelectItem>
                    <SelectItem value="viewer">Viewer</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <p className="text-xs text-zinc-500">
                An API token will be generated for this agent on creation.
              </p>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {createdToken ? 'Done' : 'Cancel'}
          </Button>
          {!createdToken && (
            <Button
              onClick={handleCreate}
              disabled={saving}
              className="bg-violet-600 hover:bg-violet-700 text-white"
            >
              {saving ? 'Creating…' : 'Create Agent'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PendingInvites({ invites, onRevoke }: { invites: Invite[]; onRevoke: (id: string) => void }) {
  const pending = invites.filter((i) => !i.used_at && new Date(i.expires_at) > new Date());
  if (pending.length === 0) return null;

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
        <Clock className="w-4 h-4" /> Pending Invites ({pending.length})
      </h2>
      <div className="space-y-2">
        {pending.map((inv) => (
          <div
            key={inv.id}
            className="bg-zinc-800/50 border border-zinc-800 rounded-lg px-4 py-3 flex items-center justify-between"
          >
            <div className="flex items-center gap-3">
              <RoleBadge role={inv.role} />
              {inv.display_name && (
                <span className="text-sm text-zinc-300">{inv.display_name}</span>
              )}
              <span className="text-xs text-zinc-500">
                expires {formatDateTime(inv.expires_at)}
              </span>
            </div>
            <Button
              variant="ghost" onClick={() => onRevoke(inv.id)}
              className="p-1.5 rounded-lg hover:bg-red-500/10 text-zinc-500 hover:text-red-400"
              title="Revoke invite"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Users() {
  const { user: authUser, hasScope } = useAuth();
  const canManageUsers = hasScope('users:write');
  const { data: users = [], isLoading: loading, refetch: fetchUsers } = useUsers();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<ArmadaUser | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<ArmadaUser | null>(null);
  const [generatingAvatar, setGeneratingAvatar] = useState<Record<string, boolean>>({});
  const [avatarConfirmUser, setAvatarConfirmUser] = useState<ArmadaUser | null>(null);
  const [avatarKeys, setAvatarKeys] = useState<Record<string, number>>({});
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [addAgentDialogOpen, setAddAgentDialogOpen] = useState(false);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [credentialsUser, setCredentialsUser] = useState<ArmadaUser | null>(null);

  useEffect(() => {
    for (const u of users) {
      if ((u as any).avatarGenerating) {
        setGeneratingAvatar(prev => ({ ...prev, [u.id]: true }));
      }
    }
  }, [users]);

  // Track user IDs for SSE callbacks (avoid stale closures)
  const generatingAvatarRef = useRef(generatingAvatar);
  generatingAvatarRef.current = generatingAvatar;

  useSSEEvent('user.avatar.generating', useCallback((data: any) => {
    setGeneratingAvatar(prev => ({ ...prev, [data.userId]: true }));
  }, []));

  useSSEEvent('user.avatar.completed', useCallback((data: any) => {
    setGeneratingAvatar(prev => ({ ...prev, [data.userId]: false }));
    setAvatarKeys(prev => ({ ...prev, [data.userId]: (prev[data.userId] || 0) + 1 }));
  }, []));

  useSSEEvent('user.avatar.failed', useCallback((data: any) => {
    setGeneratingAvatar(prev => ({ ...prev, [data.userId]: false }));
  }, []));

  async function handleGenerateAvatar(user: ArmadaUser) {
    setGeneratingAvatar(prev => ({ ...prev, [user.id]: true }));
    try {
      await apiFetch(`/api/users/${user.id}/avatar/generate`, { method: 'POST' });
    } catch (err: any) {
      if (!err.message?.includes('already in progress')) {
        setGeneratingAvatar(prev => ({ ...prev, [user.id]: false }));
      }
    }
  }

  const fetchInvites = useCallback(async () => {
    try {
      const data = await apiFetch<Invite[]>('/api/auth/invites');
      setInvites(data);
    } catch {
      // silent — user may not have permission
    }
  }, []);

  useEffect(() => {
    fetchInvites();
  }, [fetchInvites]);

  const handleRevokeInvite = async (id: string) => {
    await apiFetch(`/api/auth/invites/${id}`, { method: 'DELETE' });
    await fetchInvites();
  };

  const handleCreate = async (data: UserFormData) => {
    await apiFetch('/api/users', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    await fetchUsers();
  };

  const handleUpdate = async (data: UserFormData) => {
    if (!editingUser) return;
    await apiFetch(`/api/users/${editingUser.id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    await fetchUsers();
  };

  const handleDelete = async (user: ArmadaUser) => {
    await apiFetch(`/api/users/${user.id}`, { method: 'DELETE' });
    setDeleteConfirm(null);
    await fetchUsers();
  };

  if (!canManageUsers) {
    return (
      <div className="space-y-6">
        <PageHeader icon={UsersIcon} title="Users" subtitle="User management" />
        <EmptyState
          icon={Shield}
          title="Access Denied"
          description="Only owners can manage users. Your current role does not have permission."
        />
      </div>
    );
  }

  const isMe = (u: ArmadaUser) => authUser?.id === u.id;
  const canDelete = (u: ArmadaUser) => !isMe(u) && (u.role !== 'owner' || authUser?.role === 'owner');

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader icon={UsersIcon} title="Users" subtitle={`${users.length} user${users.length !== 1 ? 's' : ''} registered`}>
        <Button
          onClick={() => setInviteDialogOpen(true)}
          className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9"
        >
          <Mail className="w-4 h-4 mr-1.5" /> Invite User
        </Button>
        <Button
          onClick={() => setAddAgentDialogOpen(true)}
          className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9"
        >
          <Bot className="w-4 h-4 mr-1.5" /> Add Agent
        </Button>
      </PageHeader>

      {/* Pending Invites */}
      <PendingInvites invites={invites} onRevoke={handleRevokeInvite} />

      {/* Invite Dialog */}
      <InviteDialog
        open={inviteDialogOpen}
        onClose={() => setInviteDialogOpen(false)}
        onCreated={() => fetchInvites()}
      />

      {/* Add Agent Dialog */}
      <AddAgentDialog
        open={addAgentDialogOpen}
        onClose={() => setAddAgentDialogOpen(false)}
        onCreated={() => { fetchUsers(); }}
      />

      {/* Users Table */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
        <Table>
          <TableHeader>
            <TableRow className="border-b border-zinc-800">
              <TableHead className="px-4 py-3 text-left text-[11px] text-zinc-500 uppercase tracking-wider">User</TableHead>
              <TableHead className="px-4 py-3 text-left text-[11px] text-zinc-500 uppercase tracking-wider hidden sm:table-cell">Type</TableHead>
              <TableHead className="px-4 py-3 text-left text-[11px] text-zinc-500 uppercase tracking-wider hidden sm:table-cell">Role</TableHead>
              <TableHead className="px-4 py-3 text-left text-[11px] text-zinc-500 uppercase tracking-wider hidden lg:table-cell">Linked Accounts</TableHead>
              <TableHead className="px-4 py-3 text-[11px] text-zinc-500 uppercase tracking-wider"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <>
                <RowSkeleton cols={5} />
                <RowSkeleton cols={5} />
                <RowSkeleton cols={5} />
              </>
            ) : users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <EmptyState
                    icon={UsersIcon}
                    title="No users yet"
                    description="Create a user or send an invite to get started"
                    action={{ label: 'Invite User', onClick: () => setInviteDialogOpen(true) }}
                  />
                </TableCell>
              </TableRow>
            ) : (
              users.map((user) => (
                <TableRow key={user.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/40 transition-colors">
                  {/* User */}
                  <TableCell className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="relative w-8 h-8 rounded-full bg-zinc-700/50 flex items-center justify-center shrink-0 overflow-hidden">
                        {user.avatarUrl ? (
                          <img
                            src={`/api/users/${user.name}/avatar?size=sm&v=${avatarKeys[user.id] || (user as any).avatarVersion || 0}`}
                            alt={user.displayName}
                            className="w-full h-full object-cover bg-[#0a0f1e] rounded-full"
                          />
                        ) : user.type === 'human' ? (
                          <User className="w-4 h-4 text-blue-400" />
                        ) : (
                          <Bot className="w-4 h-4 text-violet-400" />
                        )}
                        {generatingAvatar[user.id] && (
                          <div className="absolute inset-0 rounded-full bg-black/50 flex items-center justify-center">
                            <Loader2 className="w-3 h-3 animate-spin text-teal-400" />
                          </div>
                        )}
                      </div>
                      <div>
                        <div className="text-sm font-medium text-zinc-100">{user.displayName}</div>
                        <div className="text-xs text-zinc-500">@{user.name}</div>
                      </div>
                    </div>
                  </TableCell>
                  {/* Type */}
                  <TableCell className="px-4 py-3 hidden sm:table-cell">
                    <TypeBadge type={user.type} />
                  </TableCell>
                  {/* Role */}
                  <TableCell className="px-4 py-3 hidden sm:table-cell">
                    <RoleBadge role={user.role} />
                  </TableCell>
                  {/* Linked Accounts */}
                  <TableCell className="px-4 py-3 hidden lg:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {user.linkedAccounts?.github && (
                        <Badge variant="secondary" className="text-xs bg-zinc-800/50 text-zinc-500">
                          GitHub: {user.linkedAccounts.github}
                        </Badge>
                      )}
                      {user.linkedAccounts?.telegram && (
                        <Badge variant="secondary" className="text-xs bg-zinc-800/50 text-zinc-500">
                          Telegram
                        </Badge>
                      )}
                      {user.linkedAccounts?.email && (
                        <Badge variant="secondary" className="text-xs bg-zinc-800/50 text-zinc-500">
                          {user.linkedAccounts.email}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  {/* Actions */}
                  <TableCell className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        onClick={() => setAvatarConfirmUser(user)}
                        disabled={generatingAvatar[user.id]}
                        className="p-1.5 rounded-lg text-zinc-500 hover:text-teal-400 hover:bg-zinc-700/50 disabled:opacity-50 disabled:cursor-not-allowed"
                        title={generatingAvatar[user.id] ? 'Generating…' : 'Generate avatar'}
                      >
                        {generatingAvatar[user.id] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Palette className="w-3.5 h-3.5" />}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => { setEditingUser(user); setDialogOpen(true); }}
                        className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700/50"
                        title="Edit"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      {canManageUsers && user.type === 'human' && (
                        <Button
                          variant="ghost"
                          onClick={() => setCredentialsUser(user)}
                          className="p-1.5 rounded-lg text-zinc-500 hover:text-violet-400 hover:bg-zinc-700/50"
                          title="Manage credentials"
                        >
                          <Key className="w-3.5 h-3.5" />
                        </Button>
                      )}
                      {canDelete(user) && (
                        <Button
                          variant="ghost"
                          onClick={() => setDeleteConfirm(user)}
                          className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create/Edit Dialog */}
      <UserDialog
        open={dialogOpen}
        user={editingUser}
        onClose={() => { setDialogOpen(false); setEditingUser(null); }}
        onSave={editingUser ? handleUpdate : handleCreate}
      />

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={!!deleteConfirm}
        title="Delete User"
        message={`Are you sure you want to delete "${deleteConfirm?.displayName}"?`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => deleteConfirm && handleDelete(deleteConfirm)}
        onCancel={() => setDeleteConfirm(null)}
      />

      <ConfirmDialog
        open={!!avatarConfirmUser}
        title="Regenerate Avatar"
        message={`Generate a new AI avatar for "${avatarConfirmUser?.displayName || avatarConfirmUser?.name}"? This will replace the current avatar and costs ~$0.02.`}
        confirmLabel="Generate"
        onConfirm={() => {
          if (avatarConfirmUser) handleGenerateAvatar(avatarConfirmUser);
          setAvatarConfirmUser(null);
        }}
        onCancel={() => setAvatarConfirmUser(null)}
      />

      {/* Credentials Dialog */}
      <CredentialsDialog
        user={credentialsUser}
        onClose={() => setCredentialsUser(null)}
      />
    </div>
  );
}

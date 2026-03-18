import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '../hooks/useApi';
import { Shield, Fingerprint, Trash2, User, Key, Lock, Save, Loader2, Bell, Link, Unlink, CheckCircle, MessageCircle, Send } from 'lucide-react';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import RegisterPasskey from '../components/RegisterPasskey';
import ConfirmDialog from '../components/ConfirmDialog';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';

interface UserChannels {
  [type: string]: {
    platformId: string;
    verified: boolean;
    linkedAt: string;
  };
}

interface NotificationPreferences {
  preferences: {
    gates: boolean;
    completions: boolean;
    failures: boolean;
    quietHours?: { start: string; end: string };
  };
  defaultChannel?: string;
}

interface CallerInfo {
  id: string;
  name: string;
  displayName: string;
  role: string;
  type: string;
  hasPassword?: boolean;
  linkedAccounts?: {
    github?: string;
    email?: string;
  };
  notifications?: NotificationPreferences & { channels?: string[] };
  channels?: UserChannels;
}

interface Passkey {
  id: string;
  label: string;
  created_at: string;
}

interface ApiToken {
  id: string;
  label: string;
  scopes: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

const isHttpsContext = window.location.protocol === 'https:' || window.location.hostname === 'localhost';

export default function Account() {
  const [caller, setCaller] = useState<CallerInfo | null>(null);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [showRegister, setShowRegister] = useState(false);
  const [showCreateToken, setShowCreateToken] = useState(false);
  const [tokenLabel, setTokenLabel] = useState('');
  const [newToken, setNewToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [deletingPk, setDeletingPk] = useState<string | null>(null);
  const [deletingTk, setDeletingTk] = useState<string | null>(null);

  // Profile edit state
  const [profileEdit, setProfileEdit] = useState({ displayName: '', email: '', github: '' });
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileSuccess, setProfileSuccess] = useState('');

  // Notification preferences state
  const [notifPrefs, setNotifPrefs] = useState<NotificationPreferences>({
    preferences: { gates: true, completions: true, failures: true },
  });
  const [notifSaving, setNotifSaving] = useState(false);
  const [notifError, setNotifError] = useState('');
  const [notifSuccess, setNotifSuccess] = useState('');

  // Channel linking state
  const [systemChannels, setSystemChannels] = useState<string[]>([]);
  const [linkingChannel, setLinkingChannel] = useState<string | null>(null);
  const [linkCode, setLinkCode] = useState('');
  const [linkingInProgress, setLinkingInProgress] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [linkSuccess, setLinkSuccess] = useState('');
  const [unlinkingChannel, setUnlinkingChannel] = useState<string | null>(null);
  const [testingChannel, setTestingChannel] = useState<string | null>(null);
  const [channelIds, setChannelIds] = useState<Record<string, string>>({});

  // Password state
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');
  const [removingPassword, setRemovingPassword] = useState(false);
  const [showRemovePasswordConfirm, setShowRemovePasswordConfirm] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [me, pks, tks, sysChannels] = await Promise.all([
        apiFetch<CallerInfo>('/api/auth/me').catch(() => null),
        apiFetch<Passkey[]>('/api/auth/passkeys').catch(() => []),
        apiFetch<ApiToken[]>('/api/auth/tokens').catch(() => []),
        apiFetch<any>('/api/notification-channels').catch(() => null),
      ]);
      if (me) setCaller(me);
      setPasskeys(pks);
      setTokens(tks);
      if (sysChannels) {
        if (Array.isArray(sysChannels)) {
          setSystemChannels(sysChannels.map((c: any) => typeof c === 'string' ? c : c.type).filter(Boolean));
          const idMap: Record<string, string> = {};
          for (const c of sysChannels) {
            if (c && typeof c === 'object' && c.type && c.id) idMap[c.type] = c.id;
          }
          setChannelIds(idMap);
        } else {
          const chList = sysChannels.channels ?? Object.keys(sysChannels);
          setSystemChannels(chList.filter((c: any) => typeof c === 'string'));
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Pre-fill profile form when caller data loads
  useEffect(() => {
    if (caller) {
      setProfileEdit({
        displayName: caller.displayName ?? '',
        email: caller.linkedAccounts?.email ?? '',
        github: caller.linkedAccounts?.github ?? '',
      });
      if (caller.notifications) {
        const notifs = caller.notifications as any;
        setNotifPrefs({
          preferences: {
            gates: notifs.preferences?.gates ?? true,
            completions: notifs.preferences?.completions ?? true,
            failures: notifs.preferences?.failures ?? true,
            quietHours: notifs.preferences?.quietHours,
          },
          defaultChannel: notifs.defaultChannel,
        });
      }
    }
  }, [caller]);

  async function handleProfileSave() {
    setProfileSaving(true);
    setProfileError('');
    setProfileSuccess('');
    try {
      await apiFetch('/api/auth/me', {
        method: 'PUT',
        body: JSON.stringify({
          displayName: profileEdit.displayName.trim() || undefined,
          linkedAccounts: {
            email: profileEdit.email.trim() || undefined,
            github: profileEdit.github.trim() || undefined,
          },
        }),
      });
      setProfileSuccess('Profile updated');
      await fetchData();
    } catch (err: any) {
      setProfileError(err.message || 'Failed to update profile');
    } finally {
      setProfileSaving(false);
    }
  }

  async function handleNotifSave() {
    setNotifSaving(true);
    setNotifError('');
    setNotifSuccess('');
    try {
      await apiFetch('/api/auth/me', {
        method: 'PUT',
        body: JSON.stringify({
          notifications: {
            preferences: notifPrefs.preferences,
            defaultChannel: notifPrefs.defaultChannel || undefined,
          },
        }),
      });
      setNotifSuccess('Notification preferences saved');
      await fetchData();
    } catch (err: any) {
      setNotifError(err.message || 'Failed to save notification preferences');
    } finally {
      setNotifSaving(false);
    }
  }

  async function handleLink(channel: string, code: string) {
    setLinkingInProgress(true);
    setLinkError('');
    setLinkSuccess('');
    try {
      await apiFetch('/api/auth/me/link', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      setLinkSuccess(`${channel.charAt(0).toUpperCase() + channel.slice(1)} linked successfully`);
      setLinkingChannel(null);
      setLinkCode('');
      await fetchData();
    } catch (err: any) {
      setLinkError(err.message || 'Failed to link channel');
    } finally {
      setLinkingInProgress(false);
    }
  }

  async function handleUnlink(channel: string) {
    setUnlinkingChannel(channel);
    setLinkError('');
    setLinkSuccess('');
    try {
      await apiFetch('/api/auth/me/unlink', {
        method: 'POST',
        body: JSON.stringify({ channel }),
      });
      setLinkSuccess(`${channel.charAt(0).toUpperCase() + channel.slice(1)} unlinked`);
      await fetchData();
    } catch (err: any) {
      setLinkError(err.message || 'Failed to unlink channel');
    } finally {
      setUnlinkingChannel(null);
    }
  }

  function getChannelIcon(type: string) {
    if (type === 'telegram') return <MessageCircle className="w-4 h-4 text-blue-400" />;
    return <MessageCircle className="w-4 h-4 text-zinc-400" />;
  }

  async function handleTestChannel(channelType: string) {
    setTestingChannel(channelType);
    setLinkError('');
    setLinkSuccess('');
    try {
      await apiFetch('/api/auth/me/test-notification', {
        method: 'POST',
        body: JSON.stringify({ channel: channelType }),
      });
      setLinkSuccess(`Test message sent to your ${channelType}`);
    } catch (err: any) {
      setLinkError(err.message || `Failed to send test via ${channelType}`);
    } finally {
      setTestingChannel(null);
    }
  }

  async function deletePasskey(id: string) {
    setDeletingPk(id);
    try {
      await apiFetch(`/api/auth/passkeys/${id}`, { method: 'DELETE' });
      await fetchData();
    } finally { setDeletingPk(null); }
  }

  const [tokenError, setTokenError] = useState('');

  async function createToken() {
    setTokenError('');
    try {
      const res = await apiFetch<{ token: string; id: string }>('/api/auth/tokens', {
        method: 'POST',
        body: JSON.stringify({ label: tokenLabel.trim() || 'API Token' }),
      });
      setNewToken(res.token);
      setTokenLabel('');
      setShowCreateToken(false);
      // Refresh token list
      const tks = await apiFetch<ApiToken[]>('/api/auth/tokens').catch(() => []);
      setTokens(tks);
    } catch (err: any) {
      setTokenError(err.message || 'Failed to create token');
    }
  }

  async function deleteToken(id: string) {
    setDeletingTk(id);
    try {
      await apiFetch(`/api/auth/tokens/${id}`, { method: 'DELETE' });
      await fetchData();
    } finally { setDeletingTk(null); }
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError('');
    setPasswordSuccess('');
    if (newPassword.length < 8) {
      setPasswordError('Password must be at least 8 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match');
      return;
    }
    setPasswordSaving(true);
    try {
      await apiFetch('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({
          password: newPassword,
          ...(caller?.hasPassword ? { currentPassword } : {}),
        }),
      });
      setPasswordSuccess(caller?.hasPassword ? 'Password changed' : 'Password set');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setShowPasswordForm(false);
      await fetchData();
    } catch (err: any) {
      setPasswordError(err.message || 'Failed to update password');
    } finally {
      setPasswordSaving(false);
    }
  }

  async function handleRemovePassword() {
    setRemovingPassword(true);
    setPasswordError('');
    setPasswordSuccess('');
    try {
      await apiFetch('/api/auth/password', { method: 'DELETE' });
      setPasswordSuccess('Password removed');
      await fetchData();
    } catch (err: any) {
      setPasswordError(err.message || 'Failed to remove password');
    } finally {
      setRemovingPassword(false);
    }
  }

  if (loading) {
    return (
      <LoadingState message="Loading account…" />
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <PageHeader icon={User} title="My Account" subtitle="Manage your profile and security settings" />

      {/* Profile card + edit */}
      {caller && (
        <div className="bg-zinc-800/50 border border-zinc-800 rounded-lg p-5 space-y-5">
          {/* Avatar + identity row */}
          <div className="flex items-center gap-4">
            <img
              src={`/api/users/${caller.id}/avatar`}
              alt=""
              className="w-14 h-14 rounded-full bg-zinc-700/50 object-cover shrink-0"
              onError={(e) => {
                const el = e.target as HTMLImageElement;
                el.style.display = 'none';
              }}
            />
            <div>
              <p className="text-lg font-semibold text-zinc-100">{caller.displayName}</p>
              <p className="text-sm text-zinc-400">@{caller.name}</p>
              <Badge variant="secondary" className="inline-block mt-1 text-[10px] bg-violet-500/20 text-violet-300 -violet-500/30 uppercase tracking-wider">
                {caller.role}
              </Badge>
            </div>
          </div>

          {/* Editable profile fields */}
          <div className="border-t border-zinc-800 pt-4 space-y-3">
            <div className="flex items-center gap-2 mb-3">
              <User className="w-4 h-4 text-blue-400" />
              <h2 className="text-sm font-semibold text-zinc-200">Profile</h2>
            </div>

            {profileError && (
              <p className="text-xs text-red-400">{profileError}</p>
            )}
            {profileSuccess && (
              <p className="text-xs text-emerald-400">{profileSuccess}</p>
            )}

            <div>
              <label className="block text-xs text-zinc-400 mb-1">Display Name</label>
              <Input
                type="text"
                value={profileEdit.displayName}
                onChange={(e) => setProfileEdit({ ...profileEdit, displayName: e.target.value })}
                placeholder="Your display name"
              />
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1">Email</label>
              <Input
                type="email"
                value={profileEdit.email}
                onChange={(e) => setProfileEdit({ ...profileEdit, email: e.target.value })}
                placeholder="your@email.com"
              />
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1">GitHub Username</label>
              <Input
                type="text"
                value={profileEdit.github}
                onChange={(e) => setProfileEdit({ ...profileEdit, github: e.target.value })}
                placeholder="e.g. octocat"
              />
            </div>

            <div className="flex justify-end pt-1">
              <Button
                onClick={handleProfileSave}
                disabled={profileSaving}
                className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9 disabled:opacity-50"
              >
                {profileSaving ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
                ) : (
                  <><Save className="w-4 h-4" /> Save Profile</>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Linked Channels */}
      <div className="bg-zinc-800/50 border border-zinc-800 rounded-lg p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Link className="w-5 h-5 text-blue-400" />
          <h2 className="text-sm font-semibold text-zinc-200">Linked Channels</h2>
        </div>

        {linkError && <p className="text-xs text-red-400">{linkError}</p>}
        {linkSuccess && <p className="text-xs text-emerald-400">{linkSuccess}</p>}

        {systemChannels.length === 0 ? (
          <p className="text-xs text-zinc-500">No notification channels configured by the administrator.</p>
        ) : (
          <div className="space-y-1">
            {systemChannels.map((channelType) => {
              const linked = caller?.channels?.[channelType];
              const isLinking = linkingChannel === channelType;
              const isUnlinking = unlinkingChannel === channelType;

              return (
                <div key={channelType} className="flex flex-col gap-2 py-3 border-b border-zinc-800 last:border-0">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      {getChannelIcon(channelType)}
                      <span className="text-sm text-zinc-200 capitalize">{channelType}</span>
                      {linked ? (
                        <>
                          <Badge className="text-xs bg-emerald-500/20 text-emerald-300 border-emerald-500/30 flex items-center gap-1">
                            <CheckCircle className="w-3 h-3" /> Linked
                          </Badge>
                          <span className="text-xs text-zinc-500">{linked.platformId}</span>
                        </>
                      ) : (
                        <Badge variant="secondary" className="text-xs bg-zinc-700/50 text-zinc-400 border-zinc-700">
                          Not linked
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {linked ? (
                        <>
                        <Button
                          variant="ghost"
                          onClick={() => handleTestChannel(channelType)}
                          disabled={testingChannel === channelType}
                          className="flex items-center gap-1 text-[11px] font-medium text-emerald-300 hover:text-emerald-200 bg-emerald-500/10 hover:bg-emerald-500/20 px-2 py-1 rounded-md transition disabled:opacity-50"
                        >
                          <Send className="w-3 h-3" />
                          {testingChannel === channelType ? '…' : 'Test'}
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => handleUnlink(channelType)}
                          disabled={isUnlinking}
                          className="flex items-center gap-1 text-[11px] font-medium text-red-400/70 hover:text-red-400 bg-red-500/10 hover:bg-red-500/20 px-2 py-1 rounded-md transition disabled:opacity-50"
                        >
                          <Unlink className="w-3 h-3" />
                          {isUnlinking ? '…' : 'Unlink'}
                        </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setLinkingChannel(isLinking ? null : channelType);
                            setLinkCode('');
                            setLinkError('');
                          }}
                          className="flex items-center gap-1.5 text-xs font-medium text-blue-300 hover:text-blue-200 bg-blue-500/10 hover:bg-blue-500/20 px-3 py-1.5 rounded-lg transition"
                        >
                          <Link className="w-3.5 h-3.5" />
                          {isLinking ? 'Cancel' : `Link ${channelType.charAt(0).toUpperCase() + channelType.slice(1)}`}
                        </Button>
                      )}
                    </div>
                  </div>

                  {channelType === 'telegram' && !linked && (
                    <p className="text-xs text-zinc-500">Send /start to the Armada Telegram bot to get a linking code.</p>
                  )}

                  {isLinking && (
                    <div className="flex items-center gap-2 animate-in fade-in duration-150">
                      <Input
                        type="text"
                        value={linkCode}
                        onChange={(e) => setLinkCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="6-digit code"
                        maxLength={6}
                        className="w-36"
                        autoFocus
                      />
                      <Button
                        variant="ghost"
                        onClick={() => handleLink(channelType, linkCode)}
                        disabled={linkCode.length !== 6 || linkingInProgress}
                        className="flex items-center gap-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 px-3 py-1.5 rounded-lg transition disabled:opacity-50"
                      >
                        {linkingInProgress && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        Verify
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Notification Preferences */}
      <div className="bg-zinc-800/50 border border-zinc-800 rounded-lg p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Bell className="w-5 h-5 text-blue-400" />
          <h2 className="text-sm font-semibold text-zinc-200">Notification Preferences</h2>
        </div>

        {notifError && <p className="text-xs text-red-400">{notifError}</p>}
        {notifSuccess && <p className="text-xs text-emerald-400">{notifSuccess}</p>}

        <div className="space-y-3">
          <p className="text-xs text-zinc-500">Choose which events trigger notifications.</p>

          <div className="flex items-center justify-between py-2 border-b border-zinc-800">
            <div>
              <p className="text-sm text-zinc-200">Gate approvals</p>
              <p className="text-xs text-zinc-500">Notify when a workflow gate needs approval</p>
            </div>
            <Switch
              checked={notifPrefs.preferences.gates}
              onCheckedChange={(v) => setNotifPrefs(p => ({ ...p, preferences: { ...p.preferences, gates: v } }))}
            />
          </div>

          <div className="flex items-center justify-between py-2 border-b border-zinc-800">
            <div>
              <p className="text-sm text-zinc-200">Workflow completions</p>
              <p className="text-xs text-zinc-500">Notify when a workflow run completes</p>
            </div>
            <Switch
              checked={notifPrefs.preferences.completions}
              onCheckedChange={(v) => setNotifPrefs(p => ({ ...p, preferences: { ...p.preferences, completions: v } }))}
            />
          </div>

          <div className="flex items-center justify-between py-2 border-b border-zinc-800">
            <div>
              <p className="text-sm text-zinc-200">Workflow failures</p>
              <p className="text-xs text-zinc-500">Notify when a workflow run fails</p>
            </div>
            <Switch
              checked={notifPrefs.preferences.failures}
              onCheckedChange={(v) => setNotifPrefs(p => ({ ...p, preferences: { ...p.preferences, failures: v } }))}
            />
          </div>

          <div className="pt-2 border-t border-zinc-800">
            <p className="text-sm text-zinc-200 mb-2">Quiet hours</p>
            <div className="flex items-center gap-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Start</label>
                <Input
                  type="text"
                  value={notifPrefs.preferences.quietHours?.start ?? ''}
                  onChange={(e) => setNotifPrefs(p => ({
                    ...p,
                    preferences: {
                      ...p.preferences,
                      quietHours: { start: e.target.value, end: p.preferences.quietHours?.end ?? '' },
                    },
                  }))}
                  placeholder="23:00"
                  className="w-24"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">End</label>
                <Input
                  type="text"
                  value={notifPrefs.preferences.quietHours?.end ?? ''}
                  onChange={(e) => setNotifPrefs(p => ({
                    ...p,
                    preferences: {
                      ...p.preferences,
                      quietHours: { start: p.preferences.quietHours?.start ?? '', end: e.target.value },
                    },
                  }))}
                  placeholder="08:00"
                  className="w-24"
                />
              </div>
            </div>
            <p className="text-xs text-zinc-500 mt-1">Suppress notifications during these hours (e.g. 23:00 – 08:00).</p>
          </div>

          {caller?.channels && Object.keys(caller.channels).length > 0 && (
            <div className="pt-2">
              <label className="block text-xs text-zinc-400 mb-1">Default channel</label>
              <Select
                value={notifPrefs.defaultChannel ?? ''}
                onValueChange={(v) => setNotifPrefs(p => ({ ...p, defaultChannel: v || undefined }))}
              >
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="Select channel" />
                </SelectTrigger>
                <SelectContent>
                  {Object.keys(caller.channels).map((ch) => (
                    <SelectItem key={ch} value={ch}>
                      {ch.charAt(0).toUpperCase() + ch.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <div className="flex justify-end pt-1">
          <Button
            onClick={handleNotifSave}
            disabled={notifSaving}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm px-4 h-9 disabled:opacity-50"
          >
            {notifSaving ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
            ) : (
              <><Save className="w-4 h-4" /> Save Preferences</>
            )}
          </Button>
        </div>
      </div>

      {/* Passkeys */}
      <div className="bg-zinc-800/50 border border-zinc-800 rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Fingerprint className="w-5 h-5 text-violet-400" />
            <h2 className="text-sm font-semibold text-zinc-200">Passkeys</h2>
          </div>
          {isHttpsContext && !showRegister && (
            <Button
              variant="ghost" onClick={() => setShowRegister(true)}
              className="flex items-center gap-1.5 text-xs font-medium text-violet-300 hover:text-violet-200 bg-violet-500/10 hover:bg-violet-500/20 px-3 py-1.5 rounded-lg transition"
            >
              <Fingerprint className="w-3.5 h-3.5" /> Add Passkey
            </Button>
          )}
        </div>

        {!isHttpsContext ? (
          <div className="flex items-center gap-2 text-sm text-zinc-400 bg-zinc-500/10 border border-zinc-500/20 rounded-lg px-4 py-3">
            <Shield className="w-4 h-4 shrink-0" />
            Passkeys require HTTPS
          </div>
        ) : passkeys.length === 0 && !showRegister ? (
          <div className="flex items-center gap-2 text-sm text-amber-400/80 bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-3">
            <Shield className="w-4 h-4 shrink-0" />
            No passkeys registered. Add one to enable passwordless login.
          </div>
        ) : (
          <div className="space-y-2">
            {passkeys.map(pk => (
              <div key={pk.id} className="flex items-center justify-between bg-zinc-800/50 rounded-lg px-4 py-2.5">
                <div className="flex items-center gap-2.5">
                  <Fingerprint className="w-4 h-4 text-violet-400" />
                  <span className="text-sm text-zinc-200">{pk.label || 'Passkey'}</span>
                  <span className="text-[10px] text-zinc-500">
                    Added {new Date(pk.created_at || pk.created_at).toLocaleDateString()}
                  </span>
                </div>
                <Button
                  variant="ghost" onClick={() => deletePasskey(pk.id)}
                  disabled={deletingPk === pk.id}
                  className="p-1.5 rounded-lg text-red-400/50 hover:text-red-400 hover:bg-red-500/10 transition disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {isHttpsContext && showRegister && (
          <div className="border-t border-zinc-800 pt-4">
            <RegisterPasskey
              onSuccess={() => {
                setShowRegister(false);
                fetchData();
              }}
            />
          </div>
        )}
      </div>

      {/* Password */}
      <div className="bg-zinc-800/50 border border-zinc-800 rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Lock className="w-5 h-5 text-amber-400" />
            <h2 className="text-sm font-semibold text-zinc-200">Password</h2>
          </div>
          {caller?.hasPassword ? (
            <div className="flex items-center gap-2">
              {!showPasswordForm && (
                <Button
                  variant="ghost" onClick={() => { setShowPasswordForm(true); setPasswordError(''); setPasswordSuccess(''); }}
                  className="flex items-center gap-1.5 text-xs font-medium text-amber-300 hover:text-amber-200 bg-amber-500/10 hover:bg-amber-500/20 px-3 py-1.5 rounded-lg transition"
                >
                  Change Password
                </Button>
              )}
              <Button
                variant="ghost" onClick={() => setShowRemovePasswordConfirm(true)}
                disabled={removingPassword}
                className="flex items-center gap-1.5 text-xs font-medium text-red-400/70 hover:text-red-400 bg-red-500/10 hover:bg-red-500/20 px-3 py-1.5 rounded-lg transition disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                {removingPassword ? 'Removing…' : 'Remove'}
              </Button>
            </div>
          ) : (
            !showPasswordForm && (
              <Button
                variant="ghost" onClick={() => { setShowPasswordForm(true); setPasswordError(''); setPasswordSuccess(''); }}
                className="flex items-center gap-1.5 text-xs font-medium text-amber-300 hover:text-amber-200 bg-amber-500/10 hover:bg-amber-500/20 px-3 py-1.5 rounded-lg transition"
              >
                <Lock className="w-3.5 h-3.5" /> Set Password
              </Button>
            )
          )}
        </div>

        {!caller?.hasPassword && !showPasswordForm && (
          <p className="text-xs text-zinc-500">No password set. You can add one as an alternative login method.</p>
        )}

        {caller?.hasPassword && !showPasswordForm && (
          <p className="text-xs text-zinc-500">Password is set. You can sign in with your username and password.</p>
        )}

        {passwordSuccess && (
          <p className="text-xs text-emerald-400">{passwordSuccess}</p>
        )}
        {passwordError && (
          <p className="text-xs text-red-400">{passwordError}</p>
        )}

        {showPasswordForm && (
          <form onSubmit={handlePasswordSubmit} className="border-t border-zinc-800 pt-4 space-y-3">
            {caller?.hasPassword && (
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Current Password</label>
                <Input
                  type="password"
                  value={currentPassword}
                  onChange={e => setCurrentPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
            )}
            <div>
              <label className="block text-xs text-zinc-400 mb-1">New Password</label>
              <Input
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Confirm Password</label>
              <Input
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost" type="submit"
                disabled={passwordSaving}
                className="px-4 py-2 text-xs font-medium text-white bg-amber-600 hover:bg-amber-500 rounded-lg disabled:opacity-50 transition-colors"
              >
                {passwordSaving ? 'Saving…' : (caller?.hasPassword ? 'Change Password' : 'Set Password')}
              </Button>
              <Button
                variant="ghost" type="button"
                onClick={() => { setShowPasswordForm(false); setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); setPasswordError(''); }}
                className="px-4 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>

      {/* API Tokens */}
      <div className="bg-zinc-800/50 border border-zinc-800 rounded-lg p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Key className="w-5 h-5 text-emerald-400" />
          <h2 className="text-sm font-semibold text-zinc-200">API Tokens</h2>
        </div>

        {newToken && (
          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4 space-y-2">
            <p className="text-xs text-emerald-400 font-medium">Token created — copy it now, it won't be shown again:</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs text-zinc-200 bg-black/30 rounded-lg px-3 py-2 font-mono break-all select-all border border-zinc-800">{newToken}</code>
              <Button
                variant="ghost" onClick={() => { navigator.clipboard.writeText(newToken); }}
                className="px-3 py-2 text-xs rounded-lg bg-zinc-700/50 hover:bg-zinc-700/50 text-zinc-200 transition"
              >
                Copy
              </Button>
            </div>
            <Button variant="ghost" onClick={() => setNewToken('')} className="text-xs text-zinc-500 hover:text-zinc-400">Dismiss</Button>
          </div>
        )}

        {tokens.length === 0 && !newToken ? (
          <p className="text-xs text-zinc-500">No API tokens</p>
        ) : (
          <div className="space-y-2">
            {tokens.map(tk => (
              <div key={tk.id} className="flex items-center justify-between bg-zinc-800/50 rounded-lg px-4 py-2.5">
                <div className="flex items-center gap-2.5">
                  <Key className="w-4 h-4 text-emerald-400" />
                  <span className="text-sm text-zinc-200">{tk.label || 'API Token'}</span>
                  <span className="text-[10px] text-zinc-500">
                    Created {new Date(tk.created_at || tk.created_at).toLocaleDateString()}
                    {(tk as any).lastUsedAt && ` · Last used ${new Date((tk as any).lastUsedAt).toLocaleDateString()}`}
                  </span>
                  {tk.expires_at && new Date(tk.expires_at) < new Date() && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">Expired</span>
                  )}
                </div>
                <Button
                  variant="ghost" onClick={() => deleteToken(tk.id)}
                  disabled={deletingTk === tk.id}
                  className="p-1.5 rounded-lg text-red-400/50 hover:text-red-400 hover:bg-red-500/10 transition disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {showCreateToken ? (
          <div className="border-t border-zinc-800 pt-4 space-y-2">
            <div className="flex items-center gap-2">
              <Input
                type="text"
                placeholder="Token label (e.g. CI, CLI, Robin…)"
                value={tokenLabel}
                onChange={e => setTokenLabel(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && createToken()}
                className="flex-1"
                autoFocus
              />
              <Button variant="ghost" onClick={createToken} className="px-4 py-2 text-sm rounded-lg bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition">
                Create
              </Button>
              <Button variant="ghost" onClick={() => { setShowCreateToken(false); setTokenLabel(''); setTokenError(''); }} className="px-3 py-2 text-sm text-zinc-500 hover:text-zinc-400">
                Cancel
              </Button>
            </div>
            {tokenError && (
              <p className="text-xs text-red-400">{tokenError}</p>
            )}
          </div>
        ) : (
          <Button
            variant="ghost" onClick={() => setShowCreateToken(true)}
            className="text-xs text-emerald-400/70 hover:text-emerald-400 transition"
          >
            + Create API Token
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={showRemovePasswordConfirm}
        title="Remove Password"
        message="Remove your password? You will only be able to sign in with a passkey or API token."
        confirmLabel="Remove Password"
        destructive
        loading={removingPassword}
        onConfirm={() => { setShowRemovePasswordConfirm(false); handleRemovePassword(); }}
        onCancel={() => setShowRemovePasswordConfirm(false)}
      />
    </div>
  );
}

import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '../hooks/useApi';
import { Shield, Fingerprint, Trash2, User, Key, Lock, Save, Loader2 } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import RegisterPasskey from '../components/RegisterPasskey';
import ConfirmDialog from '../components/ConfirmDialog';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';

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
      const [me, pks, tks] = await Promise.all([
        apiFetch<CallerInfo>('/api/auth/me').catch(() => null),
        apiFetch<Passkey[]>('/api/auth/passkeys').catch(() => []),
        apiFetch<ApiToken[]>('/api/auth/tokens').catch(() => []),
      ]);
      if (me) setCaller(me);
      setPasskeys(pks);
      setTokens(tks);
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
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-violet-500" />
      </div>
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

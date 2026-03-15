import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Loader2, AlertCircle, UserPlus, CheckCircle } from 'lucide-react';
import RegisterPasskey from '../components/RegisterPasskey';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';

interface InviteInfo {
  valid: boolean;
  role?: string;
  displayName?: string;
  error?: string;
}

export default function AcceptInvite() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [passkeyDone, setPasskeyDone] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/auth/invites/${token}/validate`)
      .then((res) => res.json())
      .then((data) => {
        setInvite(data);
        if (data.displayName) setDisplayName(data.displayName);
      })
      .catch(() => setInvite({ valid: false, error: 'Failed to validate invite' }))
      .finally(() => setLoading(false));
  }, [token]);

  async function handleAccept(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !name.trim()) return;
    setSubmitting(true);
    setError('');

    try {
      const res = await fetch(`/api/auth/invites/${token}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), displayName: displayName.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to accept invite');
      }
      // Session cookie is set by the server — mark as authed for the SPA
      localStorage.setItem('armada_authed', '1');

      // If password was provided, set it on the new account
      if (password.trim()) {
        try {
          await fetch('/api/auth/password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: password.trim() }),
          });
        } catch {
          // Non-fatal — user can set password later from account page
        }
      }

      setAccepted(true);
    } catch (err: any) {
      setError(err.message || 'Failed to accept invite');
    } finally {
      setSubmitting(false);
    }
  }

  function handlePasskeySuccess() {
    setPasskeyDone(true);
    setTimeout(() => {
      window.location.href = '/';
    }, 1500);
  }

  function handleSkipPasskey() {
    window.location.href = '/';
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-violet-500" />
      </div>
    );
  }

  if (!invite || !invite.valid) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
        <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-8 max-w-md w-full text-center">
          <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
          <h1 className="text-xl font-bold text-zinc-100 mb-2">Invalid Invite</h1>
          <p className="text-zinc-400 text-sm">
            {invite?.error || 'This invite link is invalid, expired, or has already been used.'}
          </p>
        </div>
      </div>
    );
  }

  if (accepted && passkeyDone) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
        <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-8 max-w-md w-full text-center">
          <CheckCircle className="w-12 h-12 text-emerald-400 mx-auto mb-4" />
          <h1 className="text-xl font-bold text-zinc-100 mb-2">You're all set!</h1>
          <p className="text-zinc-400 text-sm">Redirecting to dashboard…</p>
        </div>
      </div>
    );
  }

  if (accepted) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
        <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-8 max-w-md w-full">
          <CheckCircle className="w-10 h-10 text-emerald-400 mx-auto mb-4" />
          <h1 className="text-xl font-bold text-zinc-100 text-center mb-2">Account Created!</h1>
          <p className="text-zinc-400 text-sm text-center mb-6">
            Register a passkey to secure your account and enable quick login.
          </p>
          <RegisterPasskey onSuccess={handlePasskeySuccess} />
          <Button
            variant="ghost" onClick={handleSkipPasskey}
            className="mt-4 w-full text-center text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Skip for now →
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-8 max-w-md w-full">
        <UserPlus className="w-10 h-10 text-violet-400 mx-auto mb-4" />
        <h1 className="text-xl font-bold text-zinc-100 text-center mb-1">You've been invited</h1>
        <p className="text-zinc-400 text-sm text-center mb-6">
          You'll be joining as <span className="text-violet-300 font-medium">{invite.role}</span>
          {invite.displayName && (
            <> — invited as <span className="text-zinc-200">{invite.displayName}</span></>
          )}
        </p>

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 text-red-300 text-sm rounded-xl px-4 py-2 mb-4 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        <form onSubmit={handleAccept} className="space-y-4">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Username</label>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              className="w-full bg-zinc-800/50 border border-zinc-700 rounded-xl px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-violet-500/50"
              placeholder="e.g. jane"
              required
              autoFocus
            />
            <p className="text-xs text-zinc-600 mt-1">Lowercase letters, numbers, and hyphens only</p>
          </div>

          <div>
            <label className="block text-sm text-zinc-400 mb-1">Display Name</label>
            <Input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full bg-zinc-800/50 border border-zinc-700 rounded-xl px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-violet-500/50"
              placeholder="e.g. Jane"
            />
          </div>

          <div>
            <label className="block text-sm text-zinc-400 mb-1">Password <span className="text-zinc-600">(optional)</span></label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-zinc-800/50 border border-zinc-700 rounded-xl px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-violet-500/50"
              placeholder="Set a password for login"
              autoComplete="new-password"
              minLength={8}
            />
            <p className="text-xs text-zinc-600 mt-1">At least 8 characters. You can also set this later.</p>
          </div>

          <Button
            variant="ghost" type="submit"
            disabled={submitting || !name.trim()}
            className="w-full px-4 py-2.5 text-sm font-medium text-white bg-violet-600 hover:bg-violet-500 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Creating account…
              </>
            ) : (
              'Accept Invite'
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}

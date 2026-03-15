import { useState, FormEvent } from 'react';
import { Rocket, Fingerprint, Key, ChevronDown, ChevronUp, Lock } from 'lucide-react';
import { startAuthentication } from '@simplewebauthn/browser';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';

interface Props {
  onLogin: (token?: string) => void;
}

const isHttpsContext = window.location.protocol === 'https:' || window.location.hostname === 'localhost';

export default function Login({ onLogin }: Props) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [showTokenLogin, setShowTokenLogin] = useState(false);
  const [showPasswordLogin, setShowPasswordLogin] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);

  // Password login state
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);

  async function handlePasskeyLogin() {
    setError('');
    setPasskeyLoading(true);

    try {
      // 1. Get login options from server
      const optionsRes = await fetch('/api/auth/passkey/login-options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!optionsRes.ok) {
        const body = await optionsRes.json().catch(() => ({}));
        throw new Error(body.error || `Server error: ${optionsRes.status}`);
      }
      const options = await optionsRes.json();

      // 2. Trigger browser WebAuthn prompt
      const authResponse = await startAuthentication({ optionsJSON: options });

      // 3. Verify with server
      const verifyRes = await fetch('/api/auth/passkey/login-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authResponse),
      });
      if (!verifyRes.ok) {
        const body = await verifyRes.json().catch(() => ({}));
        throw new Error(body.error || 'Verification failed');
      }

      const result = await verifyRes.json();
      if (result.ok) {
        // Store auth state — cookie is set by server
        localStorage.setItem('armada_authed', 'passkey');
        onLogin();
      } else {
        throw new Error('Login failed');
      }
    } catch (err: any) {
      if (err.name === 'NotAllowedError') {
        setError('Authentication was cancelled');
      } else if (err.name === 'SecurityError') {
        setError('WebAuthn is not supported in this context');
      } else {
        setError(err.message || 'Passkey authentication failed');
      }
    } finally {
      setPasskeyLoading(false);
    }
  }

  async function handlePasswordLogin(e: FormEvent) {
    e.preventDefault();
    setError('');
    setPasswordLoading(true);

    try {
      const res = await fetch('/api/auth/login/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: username.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Login failed');
      }
      if (data.ok) {
        localStorage.setItem('armada_authed', 'password');
        onLogin();
      } else {
        throw new Error('Login failed');
      }
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setPasswordLoading(false);
    }
  }

  async function handleTokenSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setTesting(true);

    try {
      const res = await fetch('/api/status', {
        headers: { Authorization: `Bearer ${token.trim()}` },
      });
      if (res.ok) {
        localStorage.setItem('armada_token', token.trim());
        onLogin(token.trim());
      } else if (res.status === 401 || res.status === 403) {
        setError('Invalid token');
      } else {
        setError(`Unexpected response: ${res.status}`);
      }
    } catch {
      setError('Cannot reach Armada API');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
    }}>
      <div style={{
        background: 'rgba(255,255,255,0.05)',
        backdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '16px',
        padding: '40px',
        width: '100%',
        maxWidth: '400px',
        display: 'flex',
        flexDirection: 'column',
        gap: '24px',
      }}>
        {/* Header */}
        <div style={{ textAlign: 'center' }}>
          <h1 style={{
            color: '#f1f5f9',
            fontSize: '24px',
            margin: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
          }}>
            <Rocket size={24} /> <span style={{ color: "#a78bfa" }}>Armada</span>
          </h1>
          <p style={{ color: '#94a3b8', fontSize: '14px', marginTop: '8px' }}>
            Agent orchestration platform
          </p>
        </div>

        {/* Passkey Login Button */}
        {isHttpsContext ? (
          <Button
            variant="ghost" type="button"
            onClick={handlePasskeyLogin}
            disabled={passkeyLoading}
            style={{
              background: passkeyLoading ? '#475569' : 'linear-gradient(135deg, #5eead4, #2563eb)',
              border: 'none',
              borderRadius: '10px',
              padding: '14px 20px',
              color: '#fff',
              fontSize: '15px',
              fontWeight: 600,
              cursor: passkeyLoading ? 'wait' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '10px',
              transition: 'opacity 0.2s',
            }}
          >
            <Fingerprint size={20} />
            {passkeyLoading ? 'Authenticating…' : 'Sign in with Passkey'}
          </Button>
        ) : (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '12px 16px',
            borderRadius: '10px',
            background: 'rgba(100,116,139,0.15)',
            border: '1px solid rgba(100,116,139,0.2)',
            color: '#64748b',
            fontSize: '13px',
          }}>
            <Fingerprint size={16} />
            Passkeys require HTTPS
          </div>
        )}

        {/* Error */}
        {error && (
          <p style={{ color: '#f87171', fontSize: '13px', margin: 0, textAlign: 'center' }}>{error}</p>
        )}

        {/* Password Login (collapsible) */}
        <div>
          <Button
            variant="ghost" type="button"
            onClick={() => { setShowPasswordLogin(!showPasswordLogin); setShowTokenLogin(false); }}
            style={{
              background: 'none',
              border: 'none',
              color: '#64748b',
              fontSize: '13px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px',
              width: '100%',
              padding: '4px 0',
            }}
          >
            <Lock size={14} />
            Or use password
            {showPasswordLogin ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </Button>

          {showPasswordLogin && (
            <form onSubmit={handlePasswordLogin} style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              marginTop: '12px',
            }}>
              <Input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="Username"
                autoFocus
                autoComplete="username"
                style={{
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: '8px',
                  padding: '12px 16px',
                  color: '#f1f5f9',
                  fontSize: '14px',
                  outline: 'none',
                }}
              />
              <Input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Password"
                autoComplete="current-password"
                style={{
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: '8px',
                  padding: '12px 16px',
                  color: '#f1f5f9',
                  fontSize: '14px',
                  outline: 'none',
                }}
              />
              <Button
                variant="ghost" type="submit"
                disabled={!username.trim() || !password || passwordLoading}
                style={{
                  background: passwordLoading ? '#475569' : '#334155',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '8px',
                  padding: '10px',
                  color: '#e2e8f0',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: passwordLoading ? 'wait' : 'pointer',
                  opacity: (!username.trim() || !password) ? 0.5 : 1,
                }}
              >
                {passwordLoading ? 'Signing in…' : 'Sign In'}
              </Button>
            </form>
          )}
        </div>

        {/* Token Login (collapsible) */}
        <div>
          <Button
            variant="ghost" type="button"
            onClick={() => { setShowTokenLogin(!showTokenLogin); setShowPasswordLogin(false); }}
            style={{
              background: 'none',
              border: 'none',
              color: '#64748b',
              fontSize: '13px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px',
              width: '100%',
              padding: '4px 0',
            }}
          >
            <Key size={14} />
            Or use API token
            {showTokenLogin ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </Button>

          {showTokenLogin && (
            <form onSubmit={handleTokenSubmit} style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              marginTop: '12px',
            }}>
              <Input
                type="password"
                value={token}
                onChange={e => setToken(e.target.value)}
                placeholder="API Token"
                autoFocus
                style={{
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: '8px',
                  padding: '12px 16px',
                  color: '#f1f5f9',
                  fontSize: '14px',
                  outline: 'none',
                }}
              />
              <Button
                variant="ghost" type="submit"
                disabled={!token.trim() || testing}
                style={{
                  background: testing ? '#475569' : '#334155',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '8px',
                  padding: '10px',
                  color: '#e2e8f0',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: testing ? 'wait' : 'pointer',
                  opacity: !token.trim() ? 0.5 : 1,
                }}
              >
                {testing ? 'Verifying…' : 'Sign In with Token'}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

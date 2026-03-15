import { useState, useEffect, FormEvent } from 'react';
import { Rocket, User, Fingerprint, Lock, Globe, Cpu, CheckCircle, ArrowRight } from 'lucide-react';
import RegisterPasskey from '../components/RegisterPasskey';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';

interface Props {
  onComplete: () => void;
}

type Step = 'welcome' | 'url-check' | 'account' | 'security' | 'provider' | 'complete';
const STEPS: Step[] = ['welcome', 'url-check', 'account', 'security', 'provider', 'complete'];

function StepIndicator({ current }: { current: Step }) {
  const labels = ['Welcome', 'URL', 'Account', 'Security', 'Provider', 'Done'];
  const idx = STEPS.indexOf(current);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '4px',
      marginBottom: '32px',
      position: 'relative',
    }}>
      {STEPS.map((step, i) => (
        <div key={step} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <div style={{
            width: '26px',
            height: '26px',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '11px',
            fontWeight: 600,
            flexShrink: 0,
            background: i <= idx
              ? 'linear-gradient(135deg, #5eead4, #2563eb)'
              : 'rgba(255,255,255,0.05)',
            border: i <= idx ? 'none' : '1px solid rgba(255,255,255,0.15)',
            color: i <= idx ? '#fff' : '#64748b',
            transition: 'all 0.3s',
          }}>
            {i < idx ? <CheckCircle size={13} /> : i + 1}
          </div>
          {i < STEPS.length - 1 && (
            <div style={{
              width: '16px',
              height: '2px',
              flexShrink: 0,
              background: i < idx ? '#2563eb' : 'rgba(255,255,255,0.1)',
              transition: 'background 0.3s',
            }} />
          )}
        </div>
      ))}
      <span style={{
        position: 'absolute',
        bottom: '-20px',
        color: '#94a3b8',
        fontSize: '12px',
      }}>{labels[idx]}</span>
    </div>
  );
}

const PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic', description: 'Claude models', placeholder: 'sk-ant-...' },
  { id: 'openai', name: 'OpenAI', description: 'GPT models', placeholder: 'sk-...' },
  { id: 'openrouter', name: 'OpenRouter', description: 'Multi-provider', placeholder: 'sk-or-...' },
  { id: 'ollama', name: 'Ollama', description: 'Local models', placeholder: 'http://localhost:11434' },
];

export default function SetupWizard({ onComplete }: Props) {
  const [step, setStep] = useState<Step>('welcome');
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [createdUser, setCreatedUser] = useState<any>(null);

  // URL check state
  const [detectedUrl, setDetectedUrl] = useState('');
  const [isLocalhost, setIsLocalhost] = useState(false);
  const [isHttps, setIsHttps] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [urlConfirmed, setUrlConfirmed] = useState(false);
  const [urlLoading, setUrlLoading] = useState(false);
  const [urlError, setUrlError] = useState('');

  // Security state
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSet, setPasswordSet] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passkeyRegistered, setPasskeyRegistered] = useState(false);

  // Provider state
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [providerLoading, setProviderLoading] = useState(false);
  const [providerError, setProviderError] = useState('');
  const [providerAdded, setProviderAdded] = useState(false);

  // Detect HTTPS from current page
  useEffect(() => {
    setIsHttps(window.location.protocol === 'https:');
  }, []);

  // Fetch detected URL when entering url-check step
  useEffect(() => {
    if (step === 'url-check') {
      fetch('/api/auth/detected-url')
        .then(r => r.json())
        .then(data => {
          setDetectedUrl(data.detectedUrl || '');
          setUrlInput(data.detectedUrl || '');
          setIsLocalhost(!!data.isLocalhost);
          if (data.stored) setUrlConfirmed(true);
        })
        .catch(() => {});
    }
  }, [step]);

  async function handleCreateAccount(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.toLowerCase().trim(), displayName: displayName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Server error: ${res.status}`);
      }
      setCreatedUser(data.user);
      // Session cookie is set by server — we're now authenticated
      localStorage.setItem('armada_authed', 'session');
      setStep('security');
    } catch (err: any) {
      setError(err.message || 'Failed to create account');
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirmUrl() {
    setUrlError('');
    setUrlLoading(true);
    try {
      const res = await fetch('/api/auth/confirm-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlInput }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to confirm URL');
      setUrlConfirmed(true);
      setIsHttps(urlInput.startsWith('https://'));
    } catch (err: any) {
      setUrlError(err.message || 'Invalid URL');
    } finally {
      setUrlLoading(false);
    }
  }

  async function handleSetPassword() {
    if (password.length < 8) {
      setPasswordError('Password must be at least 8 characters');
      return;
    }
    if (password !== confirmPassword) {
      setPasswordError('Passwords do not match');
      return;
    }
    setPasswordError('');
    setPasswordLoading(true);
    try {
      const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to set password');
      setPasswordSet(true);
    } catch (err: any) {
      setPasswordError(err.message || 'Failed to set password');
    } finally {
      setPasswordLoading(false);
    }
  }

  async function handleAddProvider() {
    if (!selectedProvider || !apiKeyInput.trim()) return;
    setProviderError('');
    setProviderLoading(true);
    try {
      const res = await fetch('/api/auth/setup-provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: selectedProvider, apiKey: apiKeyInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add provider');
      setProviderAdded(true);
      setStep('complete');
    } catch (err: any) {
      setProviderError(err.message || 'Failed to add provider');
    } finally {
      setProviderLoading(false);
    }
  }

  function handleComplete() {
    onComplete();
  }

  // Can proceed from security step if they have at least one auth method
  const hasAuth = passwordSet || passkeyRegistered;

  const cardStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.05)',
    backdropFilter: 'blur(20px)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '16px',
    padding: '40px',
    width: '100%',
    maxWidth: '480px',
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
    position: 'relative',
  };

  const inputStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: '8px',
    padding: '12px 16px',
    color: '#f1f5f9',
    fontSize: '14px',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  };

  const primaryBtnStyle: React.CSSProperties = {
    background: loading ? '#475569' : 'linear-gradient(135deg, #5eead4, #2563eb)',
    border: 'none',
    borderRadius: '10px',
    padding: '14px 20px',
    color: '#fff',
    fontSize: '15px',
    fontWeight: 600,
    cursor: loading ? 'wait' : 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '10px',
    transition: 'opacity 0.2s',
    width: '100%',
  };

  const skipBtnStyle: React.CSSProperties = {
    background: 'none',
    border: 'none',
    color: '#64748b',
    fontSize: '13px',
    cursor: 'pointer',
    padding: '4px 0',
    textAlign: 'center',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    color: '#94a3b8',
    fontSize: '12px',
    fontWeight: 500,
    marginBottom: '6px',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
      padding: '20px',
    }}>
      <div style={cardStyle}>
        <StepIndicator current={step} />

        {/* Step 1: Welcome */}
        {step === 'welcome' && (
          <>
            <div style={{ textAlign: 'center' }}>
              <div style={{
                width: '64px',
                height: '64px',
                borderRadius: '16px',
                background: 'linear-gradient(135deg, #5eead4, #2563eb)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 16px',
              }}>
                <Rocket size={32} color="#fff" />
              </div>
              <h1 style={{
                color: '#f1f5f9',
                fontSize: '24px',
                margin: '0 0 8px',
                fontWeight: 700,
              }}>
                Welcome to Armada
              </h1>
              <p style={{ color: '#94a3b8', fontSize: '14px', margin: 0, lineHeight: '1.5' }}>
                Let's set up your Armada control plane. You'll confirm your URL,
                create an owner account, and configure your AI providers.
              </p>
            </div>
            <Button
              variant="ghost" type="button"
              onClick={() => setStep('url-check')}
              style={primaryBtnStyle}
            >
              Get Started <ArrowRight size={18} />
            </Button>
          </>
        )}

        {/* Step 2: URL Check (moved before account so RP ID is set for passkey) */}
        {step === 'url-check' && (
          <>
            <div style={{ textAlign: 'center' }}>
              <Globe size={28} color="#5eead4" style={{ marginBottom: '8px' }} />
              <h2 style={{
                color: '#f1f5f9',
                fontSize: '20px',
                margin: '0 0 4px',
                fontWeight: 600,
              }}>
                Confirm Public URL
              </h2>
              <p style={{ color: '#94a3b8', fontSize: '13px', margin: 0 }}>
                Armada needs to know its public URL for authentication and invite links.
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {isLocalhost && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  background: 'rgba(16, 185, 129, 0.1)',
                  border: '1px solid rgba(16, 185, 129, 0.3)',
                  borderRadius: '8px',
                  padding: '12px 16px',
                }}>
                  <CheckCircle size={18} color="#6ee7b7" />
                  <span style={{ color: '#6ee7b7', fontSize: '13px' }}>
                    Localhost detected — works out of the box
                  </span>
                </div>
              )}

              <div>
                <label style={labelStyle}>Public URL</label>
                <Input
                  type="text"
                  value={urlInput}
                  onChange={e => { setUrlInput(e.target.value); setUrlConfirmed(false); }}
                  placeholder="https://armada.example.com"
                  autoFocus
                  style={inputStyle}
                />
              </div>

              {urlError && (
                <p style={{ color: '#f87171', fontSize: '13px', margin: 0, textAlign: 'center' }}>{urlError}</p>
              )}

              {urlConfirmed ? (
                <>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    color: '#6ee7b7',
                    fontSize: '13px',
                    justifyContent: 'center',
                  }}>
                    <CheckCircle size={16} /> URL saved
                  </div>
                  <Button
                    variant="ghost" type="button"
                    onClick={() => setStep('account')}
                    style={{ ...primaryBtnStyle, background: 'linear-gradient(135deg, #5eead4, #2563eb)' }}
                  >
                    Continue <ArrowRight size={18} />
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost" type="button"
                  disabled={!urlInput.trim() || urlLoading}
                  onClick={handleConfirmUrl}
                  style={{
                    ...primaryBtnStyle,
                    background: urlLoading ? '#475569' : 'linear-gradient(135deg, #5eead4, #2563eb)',
                    opacity: !urlInput.trim() ? 0.5 : 1,
                  }}
                >
                  {urlLoading ? 'Saving…' : 'Confirm URL'}
                  {!urlLoading && <ArrowRight size={18} />}
                </Button>
              )}
            </div>

            <Button
              variant="ghost" type="button"
              onClick={() => setStep('account')}
              style={skipBtnStyle}
            >
              I'll set this later →
            </Button>
          </>
        )}

        {/* Step 3: Create Account */}
        {step === 'account' && (
          <>
            <div style={{ textAlign: 'center' }}>
              <User size={28} color="#5eead4" style={{ marginBottom: '8px' }} />
              <h2 style={{
                color: '#f1f5f9',
                fontSize: '20px',
                margin: '0 0 4px',
                fontWeight: 600,
              }}>
                Create Owner Account
              </h2>
              <p style={{ color: '#94a3b8', fontSize: '13px', margin: 0 }}>
                This will be the primary admin account for your armada.
              </p>
            </div>

            <form onSubmit={handleCreateAccount} style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}>
              <div>
                <label style={labelStyle}>Username</label>
                <Input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  placeholder="e.g. admin"
                  autoFocus
                  required
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>Display Name</label>
                <Input
                  type="text"
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  placeholder="e.g. Chris"
                  required
                  style={inputStyle}
                />
              </div>

              {error && (
                <p style={{
                  color: '#f87171',
                  fontSize: '13px',
                  margin: 0,
                  textAlign: 'center',
                }}>{error}</p>
              )}

              <Button
                variant="ghost" type="submit"
                disabled={!name.trim() || !displayName.trim() || loading}
                style={{
                  ...primaryBtnStyle,
                  opacity: (!name.trim() || !displayName.trim()) ? 0.5 : 1,
                }}
              >
                {loading ? 'Creating…' : 'Create Account'}
                {!loading && <ArrowRight size={18} />}
              </Button>
            </form>
          </>
        )}

        {/* Step 4: Security — passkey (HTTPS only) OR password */}
        {step === 'security' && (
          <>
            <div style={{ textAlign: 'center' }}>
              {isHttps ? <Fingerprint size={28} color="#5eead4" style={{ marginBottom: '8px' }} /> : <Lock size={28} color="#5eead4" style={{ marginBottom: '8px' }} />}
              <h2 style={{
                color: '#f1f5f9',
                fontSize: '20px',
                margin: '0 0 4px',
                fontWeight: 600,
              }}>
                Secure Your Account
              </h2>
              <p style={{ color: '#94a3b8', fontSize: '13px', margin: 0 }}>
                {isHttps
                  ? 'Set up a passkey and/or password to sign in.'
                  : 'Set a password to sign in. Passkeys require HTTPS.'}
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Passkey section — only on HTTPS */}
              {isHttps && (
                <div style={{
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '10px',
                  padding: '16px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                    <Fingerprint size={18} color="#5eead4" />
                    <span style={{ color: '#f1f5f9', fontSize: '14px', fontWeight: 600 }}>Passkey</span>
                    {passkeyRegistered && <CheckCircle size={14} color="#6ee7b7" />}
                  </div>
                  {passkeyRegistered ? (
                    <p style={{ color: '#6ee7b7', fontSize: '13px', margin: 0 }}>
                      ✓ Passkey registered
                    </p>
                  ) : (
                    <RegisterPasskey
                      onSuccess={() => setPasskeyRegistered(true)}
                      label="Register passkey"
                    />
                  )}
                </div>
              )}

              {/* Password section — always available */}
              <div style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '10px',
                padding: '16px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                  <Lock size={18} color="#5eead4" />
                  <span style={{ color: '#f1f5f9', fontSize: '14px', fontWeight: 600 }}>Password</span>
                  {passwordSet && <CheckCircle size={14} color="#6ee7b7" />}
                </div>
                {passwordSet ? (
                  <p style={{ color: '#6ee7b7', fontSize: '13px', margin: 0 }}>
                    ✓ Password set
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div>
                      <label style={labelStyle}>Password</label>
                      <Input
                        type="password"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder="At least 8 characters"
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>Confirm Password</label>
                      <Input
                        type="password"
                        value={confirmPassword}
                        onChange={e => setConfirmPassword(e.target.value)}
                        placeholder="Confirm password"
                        style={inputStyle}
                      />
                    </div>
                    {passwordError && (
                      <p style={{ color: '#f87171', fontSize: '13px', margin: 0 }}>{passwordError}</p>
                    )}
                    <Button
                      variant="ghost" type="button"
                      disabled={!password || !confirmPassword || passwordLoading}
                      onClick={handleSetPassword}
                      style={{
                        ...primaryBtnStyle,
                        background: passwordLoading ? '#475569' : 'rgba(94, 234, 212, 0.2)',
                        border: '1px solid rgba(94, 234, 212, 0.3)',
                        opacity: (!password || !confirmPassword) ? 0.5 : 1,
                      }}
                    >
                      {passwordLoading ? 'Setting…' : 'Set Password'}
                    </Button>
                  </div>
                )}
              </div>

              {!hasAuth && !isHttps && (
                <p style={{ color: '#f59e0b', fontSize: '12px', margin: 0, textAlign: 'center' }}>
                  ⚠ You must set a password to continue. Passkeys are only available over HTTPS.
                </p>
              )}

              {!hasAuth && isHttps && (
                <p style={{ color: '#94a3b8', fontSize: '12px', margin: 0, textAlign: 'center' }}>
                  Set at least one authentication method to continue.
                </p>
              )}
            </div>

            <Button
              variant="ghost" type="button"
              disabled={!hasAuth}
              onClick={() => setStep('provider')}
              style={{
                ...primaryBtnStyle,
                opacity: hasAuth ? 1 : 0.4,
              }}
            >
              Continue <ArrowRight size={18} />
            </Button>
          </>
        )}

        {/* Step 5: AI Provider */}
        {step === 'provider' && (
          <>
            <div style={{ textAlign: 'center' }}>
              <Cpu size={28} color="#5eead4" style={{ marginBottom: '8px' }} />
              <h2 style={{
                color: '#f1f5f9',
                fontSize: '20px',
                margin: '0 0 4px',
                fontWeight: 600,
              }}>
                Add an AI Provider
              </h2>
              <p style={{ color: '#94a3b8', fontSize: '13px', margin: 0 }}>
                Connect an AI provider to power your agents. You can add more later in Settings.
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {PROVIDERS.map(p => (
                <div
                  key={p.id}
                  onClick={() => {
                    setSelectedProvider(selectedProvider === p.id ? null : p.id);
                    setApiKeyInput('');
                    setProviderError('');
                  }}
                  style={{
                    background: selectedProvider === p.id
                      ? 'rgba(94, 234, 212, 0.1)'
                      : 'rgba(255,255,255,0.03)',
                    border: `1px solid ${selectedProvider === p.id ? 'rgba(94, 234, 212, 0.4)' : 'rgba(255,255,255,0.1)'}`,
                    borderRadius: '10px',
                    padding: '14px 16px',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ color: '#f1f5f9', fontSize: '14px', fontWeight: 600 }}>{p.name}</div>
                      <div style={{ color: '#64748b', fontSize: '12px' }}>{p.description}</div>
                    </div>
                    {selectedProvider === p.id && <CheckCircle size={16} color="#5eead4" />}
                  </div>

                  {selectedProvider === p.id && (
                    <div style={{ marginTop: '12px', display: 'flex', gap: '8px' }} onClick={e => e.stopPropagation()}>
                      <Input
                        type="text"
                        value={apiKeyInput}
                        onChange={e => setApiKeyInput(e.target.value)}
                        placeholder={p.placeholder}
                        autoFocus
                        style={{ ...inputStyle, flex: 1 }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>

            {providerError && (
              <p style={{ color: '#f87171', fontSize: '13px', margin: 0, textAlign: 'center' }}>{providerError}</p>
            )}

            {selectedProvider && apiKeyInput.trim() && (
              <Button
                variant="ghost" type="button"
                disabled={providerLoading}
                onClick={handleAddProvider}
                style={{
                  ...primaryBtnStyle,
                  background: providerLoading ? '#475569' : 'linear-gradient(135deg, #5eead4, #2563eb)',
                }}
              >
                {providerLoading ? 'Adding…' : 'Add Provider'}
                {!providerLoading && <ArrowRight size={18} />}
              </Button>
            )}

            <Button
              variant="ghost" type="button"
              onClick={() => setStep('complete')}
              style={skipBtnStyle}
            >
              Skip for now →
            </Button>
          </>
        )}

        {/* Step 6: Complete */}
        {step === 'complete' && (
          <>
            <div style={{ textAlign: 'center' }}>
              <div style={{
                width: '64px',
                height: '64px',
                borderRadius: '50%',
                background: 'rgba(16, 185, 129, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 16px',
              }}>
                <CheckCircle size={32} color="#6ee7b7" />
              </div>
              <h2 style={{
                color: '#f1f5f9',
                fontSize: '20px',
                margin: '0 0 4px',
                fontWeight: 600,
              }}>
                You're All Set!
              </h2>
              <p style={{ color: '#94a3b8', fontSize: '13px', margin: 0, lineHeight: '1.5' }}>
                {createdUser
                  ? `Welcome, ${createdUser.displayName}. Your Armada control plane is ready.`
                  : 'Your Armada control plane is ready.'}
              </p>
            </div>

            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '10px',
              padding: '16px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#94a3b8', fontSize: '13px' }}>
                <CheckCircle size={14} color="#6ee7b7" />
                <span>Owner account created</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#94a3b8', fontSize: '13px' }}>
                {urlConfirmed
                  ? <CheckCircle size={14} color="#6ee7b7" />
                  : <CheckCircle size={14} color="#475569" />}
                <span style={{ color: urlConfirmed ? '#94a3b8' : '#475569' }}>
                  {urlConfirmed ? 'Public URL configured' : 'Public URL not set (localhost)'}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#94a3b8', fontSize: '13px' }}>
                {(passkeyRegistered || passwordSet)
                  ? <CheckCircle size={14} color="#6ee7b7" />
                  : <CheckCircle size={14} color="#475569" />}
                <span style={{ color: (passkeyRegistered || passwordSet) ? '#94a3b8' : '#475569' }}>
                  {passkeyRegistered && passwordSet
                    ? 'Passkey + password configured'
                    : passkeyRegistered
                    ? 'Passkey configured'
                    : passwordSet
                    ? 'Password configured'
                    : 'No auth method set'}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#94a3b8', fontSize: '13px' }}>
                {providerAdded
                  ? <CheckCircle size={14} color="#6ee7b7" />
                  : <CheckCircle size={14} color="#475569" />}
                <span style={{ color: providerAdded ? '#94a3b8' : '#475569' }}>
                  {providerAdded ? 'AI provider configured' : 'No AI provider added yet'}
                </span>
              </div>
            </div>

            <Button
              variant="ghost" type="button"
              onClick={handleComplete}
              style={primaryBtnStyle}
            >
              Go to Dashboard <ArrowRight size={18} />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

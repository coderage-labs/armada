import { useState, FormEvent } from 'react';
import { Rocket, User, Fingerprint, CheckCircle, ArrowRight } from 'lucide-react';
import RegisterPasskey from '../components/RegisterPasskey';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';

interface Props {
  onComplete: () => void;
}

type Step = 'welcome' | 'account' | 'passkey' | 'complete';
const STEPS: Step[] = ['welcome', 'account', 'passkey', 'complete'];

function StepIndicator({ current }: { current: Step }) {
  const labels = ['Welcome', 'Account', 'Passkey', 'Done'];
  const idx = STEPS.indexOf(current);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '8px',
      marginBottom: '32px',
    }}>
      {STEPS.map((step, i) => (
        <div key={step} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{
            width: '32px',
            height: '32px',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '13px',
            fontWeight: 600,
            background: i <= idx
              ? 'linear-gradient(135deg, #5eead4, #2563eb)'
              : 'rgba(255,255,255,0.05)',
            border: i <= idx ? 'none' : '1px solid rgba(255,255,255,0.15)',
            color: i <= idx ? '#fff' : '#64748b',
            transition: 'all 0.3s',
          }}>
            {i < idx ? <CheckCircle size={16} /> : i + 1}
          </div>
          {i < STEPS.length - 1 && (
            <div style={{
              width: '32px',
              height: '2px',
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

export default function SetupWizard({ onComplete }: Props) {
  const [step, setStep] = useState<Step>('welcome');
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [createdUser, setCreatedUser] = useState<any>(null);

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
      localStorage.setItem('armada_authed', 'passkey');
      setStep('passkey');
    } catch (err: any) {
      setError(err.message || 'Failed to create account');
    } finally {
      setLoading(false);
    }
  }

  function handleComplete() {
    onComplete();
  }

  const cardStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.05)',
    backdropFilter: 'blur(20px)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '16px',
    padding: '40px',
    width: '100%',
    maxWidth: '440px',
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
                Let's set up your armada control plane. You'll create an owner account
                and secure it with a passkey.
              </p>
            </div>
            <Button
              variant="ghost" type="button"
              onClick={() => setStep('account')}
              style={primaryBtnStyle}
            >
              Get Started <ArrowRight size={18} />
            </Button>
          </>
        )}

        {/* Step 2: Create Account */}
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
                <label style={{
                  display: 'block',
                  color: '#94a3b8',
                  fontSize: '12px',
                  fontWeight: 500,
                  marginBottom: '6px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}>Username</label>
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
                <label style={{
                  display: 'block',
                  color: '#94a3b8',
                  fontSize: '12px',
                  fontWeight: 500,
                  marginBottom: '6px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}>Display Name</label>
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

        {/* Step 3: Register Passkey */}
        {step === 'passkey' && (
          <>
            <div style={{ textAlign: 'center' }}>
              <Fingerprint size={28} color="#5eead4" style={{ marginBottom: '8px' }} />
              <h2 style={{
                color: '#f1f5f9',
                fontSize: '20px',
                margin: '0 0 4px',
                fontWeight: 600,
              }}>
                Secure Your Account
              </h2>
              <p style={{ color: '#94a3b8', fontSize: '13px', margin: 0 }}>
                Register a passkey to sign in securely. Use your fingerprint,
                face recognition, or a security key.
              </p>
            </div>

            <RegisterPasskey
              onSuccess={() => setStep('complete')}
              label="Setup passkey"
            />

            {/* TODO: Generate and display backup codes */}

            <Button
              variant="ghost" type="button"
              onClick={() => setStep('complete')}
              style={{
                background: 'none',
                border: 'none',
                color: '#64748b',
                fontSize: '13px',
                cursor: 'pointer',
                padding: '4px 0',
                textAlign: 'center',
              }}
            >
              Skip for now →
            </Button>
          </>
        )}

        {/* Step 4: Complete */}
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
                  ? `Welcome, ${createdUser.displayName}. Your armada control plane is ready.`
                  : 'Your armada control plane is ready.'}
              </p>
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

import { useState } from 'react';
import { Fingerprint, CheckCircle, AlertCircle } from 'lucide-react';
import { startRegistration } from '@simplewebauthn/browser';
import { apiFetch } from '../hooks/useApi';
import { Button } from './ui/button';
import { Input } from './ui/input';

interface Props {
  onSuccess?: () => void;
  label?: string;
}

export default function RegisterPasskey({ onSuccess, label: labelProp }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [passkeyName, setPasskeyName] = useState(labelProp || '');

  async function handleRegister() {
    setError('');
    setSuccess(false);
    setLoading(true);

    const label = passkeyName.trim() || undefined;

    try {
      // 1. Get registration options from server (auth required — apiFetch adds Bearer token)
      const options = await apiFetch('/api/auth/passkey/register-options', {
        method: 'POST',
      });

      // 2. Trigger browser WebAuthn prompt
      const regResponse = await startRegistration({ optionsJSON: options });

      // 3. Verify with server
      const body = label ? { ...regResponse, label } : regResponse;
      const result = await apiFetch('/api/auth/passkey/register-verify', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (result.ok) {
        setSuccess(true);
        onSuccess?.();
      } else {
        throw new Error('Registration failed');
      }
    } catch (err: any) {
      if (err.name === 'NotAllowedError') {
        setError('Registration was cancelled');
      } else if (err.name === 'InvalidStateError') {
        setError('A passkey already exists for this authenticator');
      } else {
        setError(err.message || 'Passkey registration failed');
      }
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div style={{
        background: 'rgba(16, 185, 129, 0.1)',
        border: '1px solid rgba(16, 185, 129, 0.3)',
        borderRadius: '10px',
        padding: '16px 20px',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        color: '#6ee7b7',
        fontSize: '14px',
      }}>
        <CheckCircle size={18} />
        Passkey registered successfully!
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <Input
        type="text"
        placeholder="e.g. Chrome Desktop, iPhone, YubiKey…"
        value={passkeyName}
        onChange={e => setPasskeyName(e.target.value)}
        disabled={loading}
        style={{
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: '10px',
          padding: '10px 14px',
          color: '#e2e8f0',
          fontSize: '14px',
          outline: 'none',
        }}
      />
      <Button
        type="button"
        onClick={handleRegister}
        disabled={loading}
        variant="outline"
        className="w-full py-3 text-sm"
      >
        <Fingerprint size={18} />
        {loading ? 'Waiting for authenticator…' : 'Register a Passkey'}
      </Button>

      {error && (
        <div style={{
          background: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.3)',
          borderRadius: '8px',
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          color: '#fca5a5',
          fontSize: '13px',
        }}>
          <AlertCircle size={16} />
          {error}
        </div>
      )}
    </div>
  );
}

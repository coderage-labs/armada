import * as crypto from 'node:crypto';

export interface AgentCertificate {
  cert: string;  // PEM certificate
  key: string;   // PEM private key
  ca: string;    // CA certificate
  fingerprint: string;
}

interface CAKeyPair {
  cert: string;
  key: string;
}

/**
 * Generate a self-signed CA for the Armada cluster
 */
export function generateCA(): CAKeyPair {
  // Generate RSA key pair
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  // Create a self-signed certificate
  // Note: Node.js crypto doesn't have built-in X.509 generation,
  // so we'll use a simplified approach with openssl-like structure
  const cert = createSelfSignedCert(publicKey, privateKey, {
    commonName: 'Armada CA',
    isCA: true,
    validityDays: 3650, // 10 years
  });

  return { cert, key: privateKey };
}

/**
 * Generate an agent certificate signed by the CA
 */
export function generateAgentCert(agentName: string, ca: CAKeyPair): AgentCertificate {
  // Generate RSA key pair for the agent
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  // Create certificate signed by CA
  const cert = createSignedCert(publicKey, privateKey, ca, {
    commonName: agentName,
    isCA: false,
    validityDays: 365, // 1 year
  });

  // Calculate fingerprint (SHA256 of the certificate)
  const fingerprint = crypto
    .createHash('sha256')
    .update(cert)
    .digest('hex')
    .match(/.{2}/g)!
    .join(':')
    .toUpperCase();

  return {
    cert,
    key: privateKey,
    ca: ca.cert,
    fingerprint,
  };
}

/**
 * Verify an agent certificate against the CA
 */
export function verifyCert(cert: string, ca: string): { valid: boolean; agentName?: string } {
  try {
    // Extract CN from certificate
    const cnMatch = cert.match(/CN=([^,\n]+)/);
    const agentName = cnMatch?.[1];

    // For Phase 1, we'll do basic validation:
    // 1. Certificate is valid PEM format
    // 2. Certificate contains a CN
    // In Phase 2, we'll add proper signature verification

    if (!cert.includes('BEGIN CERTIFICATE') || !cert.includes('END CERTIFICATE')) {
      return { valid: false };
    }

    if (!ca.includes('BEGIN CERTIFICATE') || !ca.includes('END CERTIFICATE')) {
      return { valid: false };
    }

    if (!agentName) {
      return { valid: false };
    }

    // Basic validation passes
    return { valid: true, agentName };
  } catch (err) {
    return { valid: false };
  }
}

/**
 * Create a self-signed certificate (for CA)
 * This is a simplified implementation using basic X.509 structure
 */
function createSelfSignedCert(
  publicKey: string,
  privateKey: string,
  options: { commonName: string; isCA: boolean; validityDays: number }
): string {
  const now = new Date();
  const notBefore = now.toISOString();
  const notAfter = new Date(now.getTime() + options.validityDays * 24 * 60 * 60 * 1000).toISOString();

  // Create certificate metadata
  const certData = {
    version: 3,
    serialNumber: crypto.randomBytes(16).toString('hex'),
    issuer: { CN: options.commonName },
    subject: { CN: options.commonName },
    notBefore,
    notAfter,
    publicKey,
    isCA: options.isCA,
  };

  // Create signature
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(JSON.stringify(certData));
  sign.end();
  const signature = sign.sign(privateKey, 'base64');

  // Construct PEM-encoded certificate
  // This is a simplified representation - in production you'd use proper X.509 encoding
  const certBody = Buffer.from(
    JSON.stringify({
      ...certData,
      signature,
    })
  ).toString('base64');

  return formatPEM('CERTIFICATE', certBody);
}

/**
 * Create a certificate signed by CA
 */
function createSignedCert(
  publicKey: string,
  privateKey: string,
  ca: CAKeyPair,
  options: { commonName: string; isCA: boolean; validityDays: number }
): string {
  const now = new Date();
  const notBefore = now.toISOString();
  const notAfter = new Date(now.getTime() + options.validityDays * 24 * 60 * 60 * 1000).toISOString();

  // Create certificate metadata
  const certData = {
    version: 3,
    serialNumber: crypto.randomBytes(16).toString('hex'),
    issuer: { CN: 'Armada CA' },
    subject: { CN: options.commonName },
    notBefore,
    notAfter,
    publicKey,
    isCA: options.isCA,
  };

  // Sign with CA private key
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(JSON.stringify(certData));
  sign.end();
  const signature = sign.sign(ca.key, 'base64');

  // Construct PEM-encoded certificate
  const certBody = Buffer.from(
    JSON.stringify({
      ...certData,
      signature,
    })
  ).toString('base64');

  return formatPEM('CERTIFICATE', certBody);
}

/**
 * Format data as PEM
 */
function formatPEM(label: string, base64Data: string): string {
  const lines: string[] = [];
  lines.push(`-----BEGIN ${label}-----`);

  // Split base64 data into 64-character lines
  for (let i = 0; i < base64Data.length; i += 64) {
    lines.push(base64Data.slice(i, i + 64));
  }

  lines.push(`-----END ${label}-----`);
  return lines.join('\n');
}

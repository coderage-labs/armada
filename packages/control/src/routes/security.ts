import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { settingsRepo } from '../repositories/index.js';
import { generateCA, generateAgentCert, verifyCert } from '../services/cert-manager.js';
import { logActivity } from '../services/activity-service.js';
import { registerToolDef } from '../utils/tool-registry.js';

registerToolDef({
  category: 'system',
  name: 'armada_security_ca_generate',
  description: 'Generate a new CA certificate for the Armada cluster (first-time setup only).',
  method: 'POST',
  path: '/api/security/ca/generate',
  parameters: [],
  scope: 'system:write',
});

registerToolDef({
  category: 'system',
  name: 'armada_security_ca_get',
  description: 'Get the CA certificate (public only, no private key).',
  method: 'GET',
  path: '/api/security/ca',
  parameters: [],
  scope: 'system:read',
});

registerToolDef({
  category: 'agents',
  name: 'armada_security_agent_cert_generate',
  description: 'Generate a certificate for an agent.',
  method: 'POST',
  path: '/api/security/agents/:name/cert',
  parameters: [
    { name: 'name', type: 'string', description: 'Agent name', required: true },
  ],
  scope: 'agents:write',
});

registerToolDef({
  category: 'agents',
  name: 'armada_security_agent_cert_get',
  description: 'Get an agent certificate.',
  method: 'GET',
  path: '/api/security/agents/:name/cert',
  parameters: [
    { name: 'name', type: 'string', description: 'Agent name', required: true },
  ],
  scope: 'agents:read',
});

const router = Router();

const CA_CERT_KEY = 'security_ca_cert';
const CA_KEY_KEY = 'security_ca_key';
const AGENT_CERT_PREFIX = 'security_agent_cert_';
const AGENT_KEY_PREFIX = 'security_agent_key_';

/**
 * POST /api/security/ca/generate — Generate a new CA (first-time setup)
 */
router.post('/ca/generate', requireScope('system:write'), (req, res, next) => {
  try {
    // Check if CA already exists
    const existingCA = settingsRepo.get(CA_CERT_KEY);
    if (existingCA) {
      res.status(409).json({ error: 'CA already exists. Delete existing CA first to regenerate.' });
      return;
    }

    // Generate new CA
    const ca = generateCA();

    // Store in settings (encrypted at rest via DB encryption)
    settingsRepo.set(CA_CERT_KEY, ca.cert);
    settingsRepo.set(CA_KEY_KEY, ca.key);

    logActivity({
      eventType: 'security.ca.generated',
      detail: 'New CA certificate generated',
    });

    res.json({
      message: 'CA generated successfully',
      cert: ca.cert,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/security/ca — Get the CA certificate (public only)
 */
router.get('/ca', requireScope('system:read'), (req, res, next) => {
  try {
    const caCert = settingsRepo.get(CA_CERT_KEY);

    if (!caCert) {
      res.status(404).json({ error: 'CA not found. Generate CA first.' });
      return;
    }

    res.json({ cert: caCert });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/security/agents/:name/cert — Generate a certificate for an agent
 */
router.post('/agents/:name/cert', requireScope('agents:write'), (req, res, next) => {
  try {
    const { name } = req.params;

    if (!name) {
      res.status(400).json({ error: 'Agent name is required' });
      return;
    }

    // Get CA
    const caCert = settingsRepo.get(CA_CERT_KEY);
    const caKey = settingsRepo.get(CA_KEY_KEY);

    if (!caCert || !caKey) {
      res.status(404).json({ error: 'CA not found. Generate CA first.' });
      return;
    }

    // Check if agent cert already exists
    const existingCert = settingsRepo.get(`${AGENT_CERT_PREFIX}${name}`);
    if (existingCert) {
      res.status(409).json({ error: 'Agent certificate already exists. Delete it first to regenerate.' });
      return;
    }

    // Generate agent certificate
    const agentCert = generateAgentCert(name, { cert: caCert, key: caKey });

    // Store in settings
    settingsRepo.set(`${AGENT_CERT_PREFIX}${name}`, agentCert.cert);
    settingsRepo.set(`${AGENT_KEY_PREFIX}${name}`, agentCert.key);

    logActivity({
      eventType: 'security.agent.cert.generated',
      detail: `Certificate generated for agent: ${name}`,
    });

    res.json({
      message: `Certificate generated for agent: ${name}`,
      cert: agentCert.cert,
      key: agentCert.key,
      ca: agentCert.ca,
      fingerprint: agentCert.fingerprint,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/security/agents/:name/cert — Get an agent's certificate
 */
router.get('/agents/:name/cert', requireScope('agents:read'), (req, res, next) => {
  try {
    const { name } = req.params;

    if (!name) {
      res.status(400).json({ error: 'Agent name is required' });
      return;
    }

    const cert = settingsRepo.get(`${AGENT_CERT_PREFIX}${name}`);
    const key = settingsRepo.get(`${AGENT_KEY_PREFIX}${name}`);
    const caCert = settingsRepo.get(CA_CERT_KEY);

    if (!cert || !key) {
      res.status(404).json({ error: `Certificate not found for agent: ${name}` });
      return;
    }

    // Verify certificate
    const verification = verifyCert(cert, caCert || '');

    res.json({
      cert,
      key,
      ca: caCert || null,
      valid: verification.valid,
      agentName: verification.agentName,
    });
  } catch (err) {
    next(err);
  }
});

export default router;

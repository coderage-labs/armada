import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { getNodeClient } from '../infrastructure/node-client.js';
import { registerToolDef } from '../utils/tool-registry.js';

const router = Router();

/**
 * POST /api/files/share
 * Proxy to node agent — agent shares a file from workspace
 */
router.post('/share', requireScope('agents:write'), async (req, res) => {
  try {
    const node = getNodeClient();
    const data = await node.shareFile(req.body);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/files/download/:ref
 * Proxy binary download from node agent
 */
router.get('/download/:ref', async (req, res) => {
  try {
    const node = getNodeClient();
    const resp = await node.downloadFile(req.params.ref);
    if (!resp.ok) {
      const data = await resp.json();
      res.status(resp.status).json(data);
      return;
    }
    const contentType = resp.headers.get('content-type') || 'application/octet-stream';
    const disposition = resp.headers.get('content-disposition');
    res.setHeader('Content-Type', contentType);
    if (disposition) res.setHeader('Content-Disposition', disposition);

    const buffer = await resp.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/files/deliver
 * Proxy to node agent — deliver a shared file to an agent's workspace
 */
router.post('/deliver', requireScope('agents:write'), async (req, res) => {
  try {
    const node = getNodeClient();
    const data = await node.deliverFile(req.body);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/files/transfer
 * High-level: share from one agent, deliver to another
 * Body: { fromAgent, path, toAgent, destPath? }
 */
router.post('/transfer', requireScope('agents:write'), async (req, res) => {
  try {
    const { fromAgent, path, toAgent, destPath } = req.body;
    if (!fromAgent || !path || !toAgent) {
      res.status(400).json({ error: 'fromAgent, path, and toAgent are required' });
      return;
    }

    const node = getNodeClient();

    // Step 1: Share the file
    let shareData: any;
    try {
      shareData = await node.shareFile({ agent: fromAgent, path });
    } catch (err: any) {
      res.status(502).json({ error: `Share failed: ${err.message}` });
      return;
    }

    // Step 2: Deliver to target
    let deliverData: any;
    try {
      deliverData = await node.deliverFile({ ref: shareData.ref, toAgent, destPath });
    } catch (err: any) {
      res.status(502).json({ error: `Deliver failed: ${err.message}` });
      return;
    }

    res.json({
      transferred: true,
      ref: shareData.ref,
      filename: shareData.filename,
      fromAgent,
      toAgent,
      containerPath: deliverData.containerPath,
      marker: shareData.marker,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/files/list/:agent
 * List shared files from an agent
 */
router.get('/list/:agent', async (req, res) => {
  try {
    const node = getNodeClient();
    const data = await node.listFiles(req.params.agent);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Tool definitions ─────────────────────────────────────────────────

registerToolDef({
  category: 'git',
  name: 'armada_transfer',
  description: 'Transfer a file from one agent\'s workspace to another. The file is copied via the node agent — works across machines.',
  method: 'POST',
  path: '/api/files/transfer',
  parameters: [
    { name: 'fromAgent', type: 'string', description: 'Source agent name', required: true },
    { name: 'path', type: 'string', description: 'File path in source agent workspace', required: true },
    { name: 'toAgent', type: 'string', description: 'Destination agent name', required: true },
    { name: 'destPath', type: 'string', description: 'Destination path in target workspace (optional, defaults to shared-files/)' },
  ],
  scope: 'agents:write',
});

registerToolDef({
  category: 'git',
  name: 'armada_share',
  description: 'Share a file from an agent\'s workspace. Returns a ref that can be used to download or deliver the file.',
  method: 'POST',
  path: '/api/files/share',
  parameters: [
    { name: 'agent', type: 'string', description: 'Agent name', required: true },
    { name: 'path', type: 'string', description: 'File path in agent workspace', required: true },
  ],
  scope: 'agents:write',
});

export default router;

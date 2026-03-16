// ── Public install script endpoint — serve node install script with token baked in ──

import { Router } from 'express';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const router = Router();

// Resolve path to install.sh in the repo root
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const INSTALL_SCRIPT_PATH = join(__dirname, '../../../../install.sh');

/**
 * Derive the WebSocket control URL from the request.
 * - Use X-Forwarded-Host if present (behind proxy/tunnel)
 * - Fall back to Host header
 * - Use wss:// if request came over HTTPS, otherwise ws://
 */
function deriveControlUrl(req: any): string {
  const host = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost:3001';
  const protocol = req.headers['x-forwarded-proto'] === 'https' || req.protocol === 'https' ? 'wss' : 'ws';
  
  // Clean up port if it's a standard port
  let cleanHost = host;
  if (protocol === 'wss' && host.endsWith(':443')) {
    cleanHost = host.replace(':443', '');
  } else if (protocol === 'ws' && host.endsWith(':80')) {
    cleanHost = host.replace(':80', '');
  }
  
  return `${protocol}://${cleanHost}/api/nodes/ws`;
}

// GET /install — helpful error (no token provided)
router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.status(400).send(
    `❌ Missing install token

To install an Armada node agent, you need an install token.

Steps:
1. Open your Armada dashboard
2. Go to Nodes → Add Node
3. Copy the install command with the token

Example:
  curl https://${req.headers['x-forwarded-host'] || req.headers['host'] || 'your-domain'}/install/YOUR_TOKEN | bash

The token is embedded in the URL, not passed as a flag.
`
  );
});

// GET /install/:token — serve the install script with token and control URL baked in
router.get('/:token', (req, res) => {
  try {
    const token = req.params.token?.trim() || '';
    
    if (!token) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(400).send('# Error: Invalid token\n');
      return;
    }
    
    // Read the install script template
    const scriptTemplate = readFileSync(INSTALL_SCRIPT_PATH, 'utf-8');
    
    // Derive the control URL from the request
    const controlUrl = deriveControlUrl(req);
    
    // Replace placeholders with actual values
    const script = scriptTemplate
      .replace(/__NODE_TOKEN__/g, token)
      .replace(/__CONTROL_URL__/g, controlUrl);
    
    // Serve as plain text
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(script);
  } catch (err: any) {
    console.error('[install-script] Failed to serve install script:', err);
    res.status(500).send('# Error: Failed to load install script\n');
  }
});

export { router as installScriptRoutes };
export default router;

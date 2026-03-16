// ── Public install script endpoint — serve node install script with derived control URL ──

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

// GET /install — serve the install script with derived control URL
router.get('/', (req, res) => {
  try {
    // Read the install script template
    const scriptTemplate = readFileSync(INSTALL_SCRIPT_PATH, 'utf-8');
    
    // Derive the control URL from the request
    const controlUrl = deriveControlUrl(req);
    
    // Replace the placeholder with the derived URL
    const script = scriptTemplate.replace(/__CONTROL_URL__/g, controlUrl);
    
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

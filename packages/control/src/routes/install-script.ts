// ── Public install script endpoint — serve node install script with token baked in ──

import { Router } from 'express';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { registerToolDef } from '../utils/tool-registry.js';

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

// ── Control plane install (must be before /:token to avoid param matching) ──

const CONTROL_INSTALL_SCRIPT = `#!/bin/bash
# Armada Control Plane Quick Install
set -e
echo "🚀 Installing Armada Control Plane..."
docker pull ghcr.io/coderage-labs/armada:latest
docker run -d \\
  --name armada-control \\
  -p 3001:3001 \\
  -v armada-data:/data \\
  --restart unless-stopped \\
  ghcr.io/coderage-labs/armada:latest
echo "✅ Armada is running at http://\\$(hostname -I | awk '{print \\$1}'):3001"
echo "   Complete setup at the URL above."
`;

const COMPOSE_TEMPLATE = `# Armada Control Plane — Docker Compose template
# Usage: docker compose up -d
#
# Data is persisted in the "armada-data" named volume.
# Port 3001: Armada dashboard + API
# First visit will trigger the setup wizard.
#
# For the node install script, visit http://localhost:3001 → Nodes → Add Node.

services:
  armada-control:
    image: ghcr.io/coderage-labs/armada:latest
    container_name: armada-control
    restart: unless-stopped
    ports:
      - "3001:3001"
    volumes:
      - armada-data:/data
    networks:
      - armada

  # ── Cloudflare Tunnel (optional) ────────────────────────────────────
  # Uncomment to expose Armada via a Cloudflare Tunnel.
  # 1. Create a tunnel at https://one.dash.cloudflare.com → Zero Trust → Tunnels
  # 2. Copy the tunnel token and replace REPLACE_WITH_YOUR_TUNNEL_TOKEN below.
  # 3. Point the tunnel's public hostname to http://armada-control:3001
  #
  # cloudflare-tunnel:
  #   image: cloudflare/cloudflared:latest
  #   container_name: armada-tunnel
  #   restart: unless-stopped
  #   command: tunnel --no-autoupdate run
  #   environment:
  #     - TUNNEL_TOKEN=REPLACE_WITH_YOUR_TUNNEL_TOKEN
  #   networks:
  #     - armada
  #   depends_on:
  #     - armada-control

volumes:
  armada-data:

networks:
  armada:
    driver: bridge
`;

// GET /control — serve the control plane install script
router.get('/control', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(CONTROL_INSTALL_SCRIPT);
});

// GET /compose — serve the docker-compose.yml template
router.get('/compose', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="docker-compose.yml"');
  res.send(COMPOSE_TEMPLATE);
});

// ── Node agent install ──────────────────────────────────────────────

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

// ── Tool definitions ──────────────────────────────────────────────────

registerToolDef({
  name: 'armada_install_control',
  description: 'Get the control plane install script — a shell script that pulls and runs the Armada control plane via Docker',
  method: 'GET',
  path: '/api/install/control',
  parameters: [],
});

registerToolDef({
  name: 'armada_install_compose',
  description: 'Get a docker-compose.yml template for the Armada control plane (includes optional Cloudflare Tunnel)',
  method: 'GET',
  path: '/api/install/compose',
  parameters: [],
});

export { router as installScriptRoutes };
export default router;

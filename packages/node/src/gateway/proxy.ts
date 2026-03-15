/**
 * gateway/proxy.ts — Local HTTP gateway proxy for instance → control plane communication.
 *
 * Instances call `http://armada-gateway:<GATEWAY_PORT>/api/...` or
 * `http://armada-gateway:<GATEWAY_PORT>/hooks` and this proxy tunnels the request
 * through the authenticated WS tunnel to the control plane, then returns the response.
 *
 * Architecture:
 *   Instance → HTTP → Gateway Proxy (this) → WS (gateway.proxy) → Control Plane → response back
 */

import http from 'node:http';
import { sendCommandToControl } from '../ws/connection.js';

const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT ?? '3002', 10);

interface GatewayProxyResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Read the full body of an incoming HTTP request as a Buffer.
 */
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Create and start the gateway proxy HTTP server.
 * Returns the server instance.
 */
export function startGatewayProxy(): http.Server {
  const server = http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const path = req.url ?? '/';

    // Determine the source instance from Host or X-Forwarded-For header
    const sourceInstance =
      (req.headers['x-armada-instance'] as string | undefined) ??
      (req.headers['host']?.split(':')[0] ?? 'unknown');

    // Forward relevant headers (exclude hop-by-hop headers)
    const hopByHop = new Set([
      'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
      'te', 'trailers', 'transfer-encoding', 'upgrade',
    ]);
    const forwardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!hopByHop.has(key.toLowerCase()) && typeof value === 'string') {
        forwardHeaders[key] = value;
      }
    }

    // Read the body
    let body: unknown = undefined;
    const rawBody = await readBody(req).catch(() => Buffer.alloc(0));
    if (rawBody.length > 0) {
      const contentType = req.headers['content-type'] ?? '';
      if (contentType.includes('application/json')) {
        try {
          body = JSON.parse(rawBody.toString('utf8'));
        } catch {
          body = rawBody.toString('utf8');
        }
      } else {
        body = rawBody.toString('utf8');
      }
    }

    try {
      const result = await sendCommandToControl('gateway.proxy', {
        method,
        path,
        headers: forwardHeaders,
        body,
        sourceInstance,
      }) as GatewayProxyResult;

      // Write response status + headers
      const responseHeaders = result.headers ?? {};
      // Remove content-encoding to avoid double-decompression issues
      delete responseHeaders['content-encoding'];
      delete responseHeaders['transfer-encoding'];

      res.writeHead(result.status ?? 200, responseHeaders);

      // Write body
      const responseBody = result.body;
      if (responseBody === undefined || responseBody === null) {
        res.end();
      } else if (typeof responseBody === 'string') {
        res.end(responseBody);
      } else {
        res.end(JSON.stringify(responseBody));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[gateway-proxy] Failed to proxy ${method} ${path}:`, message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Gateway proxy error', details: message }));
    }
  });

  server.listen(GATEWAY_PORT, '0.0.0.0', () => {
    console.log(`🌐 Armada Gateway Proxy listening on port ${GATEWAY_PORT}`);
  });

  server.on('error', (err) => {
    console.error('[gateway-proxy] Server error:', err.message);
  });

  return server;
}

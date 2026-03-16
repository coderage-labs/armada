/**
 * gateway-handler.ts — Handles `gateway.proxy` commands from node agents.
 *
 * When an instance calls the node agent's gateway proxy, the node sends a
 * `gateway.proxy` command over the WS tunnel. This handler receives it and
 * forwards the request to the appropriate internal Express route via loopback.
 *
 * Flow:
 *   Instance → Node Gateway Proxy → WS (gateway.proxy) → HERE → Express app → response
 */

import type { CommandMessage, ResponseMessage } from '@coderage-labs/armada-shared';


const CONTROL_PORT = parseInt(process.env.PORT ?? '3001', 10);
const CONTROL_HOST = process.env.GATEWAY_LOOPBACK_HOST ?? 'localhost';

interface GatewayProxyParams {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  sourceInstance?: string;
}

/**
 * Forward a gateway.proxy command to the local Express app via HTTP loopback.
 */
export async function handleGatewayProxyCommand(msg: CommandMessage): Promise<ResponseMessage> {
  const params = msg.params as Partial<GatewayProxyParams>;

  const { method, path: urlPath, headers: reqHeaders, body, sourceInstance } = params;

  if (!method || !urlPath) {
    return {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: 'Missing required params: method, path',
      code: 'UNKNOWN',
    };
  }

  const url = `http://${CONTROL_HOST}:${CONTROL_PORT}${urlPath.startsWith('/') ? urlPath : `/${urlPath}`}`;

  // Hop-by-hop headers to strip when forwarding
  const hopByHop = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade', 'host',
  ]);

  // Use the original instance's Authorization header (DB-based token issued at provisioning)
  const instanceAuthHeader = reqHeaders?.['authorization'] || reqHeaders?.['Authorization'];

  const forwardHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    // Forward the instance's own token for authentication
    ...(instanceAuthHeader ? { Authorization: instanceAuthHeader } : {}),
    // Tag the request so the control plane knows it came from an instance
    ...(sourceInstance ? { 'X-Armada-Source-Instance': sourceInstance } : {}),
  };

  // Forward safe request headers from the original instance request
  for (const [key, value] of Object.entries(reqHeaders ?? {})) {
    if (!hopByHop.has(key.toLowerCase()) && key.toLowerCase() !== 'authorization' && key.toLowerCase() !== 'content-length' && key.toLowerCase() !== 'content-type') {
      forwardHeaders[key] = value;
    }
  }

  try {
    const fetchOptions: RequestInit = {
      method: method.toUpperCase(),
      headers: forwardHeaders,
    };

    if (body !== undefined && method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') {
      fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);

    // Collect response headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // Parse the response body
    const contentType = response.headers.get('content-type') ?? '';
    let responseBody: unknown;
    if (contentType.includes('application/json')) {
      try {
        responseBody = await response.json();
      } catch (err: any) {
        console.warn('[gateway-handler] Failed to parse JSON response body:', err.message);
        responseBody = await response.text();
      }
    } else {
      responseBody = await response.text();
    }

    return {
      type: 'response',
      id: msg.id,
      status: 'ok',
      data: {
        status: response.status,
        headers: responseHeaders,
        body: responseBody,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[gateway-handler] Failed to forward ${method} ${urlPath} from ${sourceInstance ?? 'unknown'}:`, message);
    return {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: `Gateway proxy failed: ${message}`,
      code: 'UNKNOWN',
    };
  }
}

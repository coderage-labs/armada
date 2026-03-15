import { docker } from '../docker/client.js';
import type { CommandMessage, ResponseMessage } from '@coderage-labs/armada-shared';
import { WsErrorCode } from '@coderage-labs/armada-shared';
import { getPort } from '../port-pool.js';

const INSTANCE_PORT = parseInt(process.env.INSTANCE_PORT ?? '18789', 10);

interface RelayParams {
  instanceId: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

interface RelayResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Resolve a container's hostname from its name or ID.
 * Containers on the same Docker network are addressable by their name (strip leading slash).
 */
async function resolveContainerHostname(instanceId: string): Promise<string> {
  try {
    const container = docker.getContainer(instanceId);
    const info = await container.inspect();
    // Container name has a leading slash — strip it
    const name = info.Name.replace(/^\//, '');
    return name;
  } catch (err: any) {
    console.warn('[relay] container inspect failed, using instanceId as hostname:', err.message);
    return instanceId;
  }
}

export async function handleRelayCommand(msg: CommandMessage): Promise<ResponseMessage> {
  const params = msg.params as Partial<RelayParams>;

  const { instanceId, method, path: urlPath, headers: reqHeaders, body } = params;

  if (!instanceId || !method || !urlPath) {
    return {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: 'Missing required params: instanceId, method, path',
      code: 'UNKNOWN',
    };
  }

  // Prefer Docker DNS (works when node agent is containerized on same network).
  // Fall back to host port if DNS fails (cross-network / bare-metal node agent).
  const hostname = await resolveContainerHostname(instanceId);
  const pathSuffix = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
  const dnsUrl = `http://${hostname}:${INSTANCE_PORT}${pathSuffix}`;
  const allocatedPort = getPort(instanceId);
  const hostUrl = allocatedPort ? `http://127.0.0.1:${allocatedPort}${pathSuffix}` : null;

  // Try DNS first, then host port
  const urls = hostUrl ? [dnsUrl, hostUrl] : [dnsUrl];
  let url = urls[0];

  try {
    const fetchOptions: RequestInit = {
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        ...(reqHeaders ?? {}),
      },
    };

    if (body !== undefined && method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') {
      fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (dnsErr) {
      // DNS failed — try host port fallback if available
      if (urls.length > 1) {
        url = urls[1];
        response = await fetch(url, fetchOptions);
      } else {
        throw dnsErr;
      }
    }

    // Collect response headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // Try to parse body as JSON, fall back to text
    const contentType = response.headers.get('content-type') ?? '';
    let responseBody: unknown;
    if (contentType.includes('application/json')) {
      try {
        responseBody = await response.json();
      } catch (err: any) {
        console.warn('[relay] Failed to parse JSON response body:', err.message);
        responseBody = await response.text();
      }
    } else {
      responseBody = await response.text();
    }

    const result: RelayResult = {
      status: response.status,
      headers: responseHeaders,
      body: responseBody,
    };

    return {
      type: 'response',
      id: msg.id,
      status: 'ok',
      data: result,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: `Failed to relay request to instance ${instanceId}: ${message}`,
      code: WsErrorCode.INSTANCE_UNREACHABLE,
    };
  }
}

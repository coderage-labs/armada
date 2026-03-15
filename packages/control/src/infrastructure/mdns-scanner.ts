/**
 * mdns-scanner.ts — mDNS scanner for node auto-discovery.
 *
 * Periodically queries the local network for `_armada-node._tcp` services.
 * When a new node is discovered it is added to an in-memory "pending" list
 * and a `node.discovered` event is emitted on the event bus.
 *
 * Discovered nodes are NOT automatically trusted — the user must explicitly
 * add them via the UI or API.
 */

// Dynamic import — multicast-dns is optional (not installed in Docker image)
let mdns: any = null;
import { eventBus } from './event-bus.js';
import { EVENT_NAMES } from './event-names.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DiscoveredNode {
  /** Unique key: ip:port */
  id: string;
  name: string;
  ip: string;
  port: number;
  /** ISO timestamp of first/last discovery */
  firstSeenAt: string;
  lastSeenAt: string;
}

// ── State ─────────────────────────────────────────────────────────────────────

const SERVICE_TYPE = '_armada-node._tcp';
const SCAN_INTERVAL_MS = 30_000;  // scan every 30 seconds
const STALE_AFTER_MS = 5 * 60_000; // remove if not seen for 5 minutes

/** In-memory map of discovered nodes (key = `ip:port`) */
const discovered = new Map<string, DiscoveredNode>();

let mdnsInstance: ReturnType<typeof mdns> | null = null;
let scanTimer: ReturnType<typeof setInterval> | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseAnswers(answers: any[]): { name?: string; ip?: string; port?: number } {
  let name: string | undefined;
  let ip: string | undefined;
  let port: number | undefined;

  for (const ans of answers) {
    if (ans.type === 'SRV' && ans.data) {
      port = ans.data.port;
    }
    if (ans.type === 'A' && ans.data) {
      ip = ans.data;
    }
    if (ans.type === 'TXT' && ans.data) {
      const entries: string[] = (ans.data as Buffer[]).map((b) => b.toString());
      for (const entry of entries) {
        if (entry.startsWith('name=')) {
          name = entry.slice('name='.length);
        }
        if (entry.startsWith('port=')) {
          port = parseInt(entry.slice('port='.length), 10);
        }
      }
    }
  }

  return { name, ip, port };
}

function upsertDiscovered(name: string, ip: string, port: number): void {
  const id = `${ip}:${port}`;
  const existing = discovered.get(id);
  const now = new Date().toISOString();

  if (!existing) {
    const node: DiscoveredNode = { id, name, ip, port, firstSeenAt: now, lastSeenAt: now };
    discovered.set(id, node);

    console.log(`[mdns-scanner] Discovered new node: ${name} @ ${ip}:${port}`);

    // Emit node.discovered event
    eventBus.emit(EVENT_NAMES.NODE_DISCOVERED, { node });
  } else {
    // Update last seen timestamp and name (in case it changed)
    existing.lastSeenAt = now;
    existing.name = name;
  }
}

/** Remove nodes not seen for STALE_AFTER_MS */
function pruneStale(): void {
  const cutoff = Date.now() - STALE_AFTER_MS;
  for (const [id, node] of discovered) {
    if (new Date(node.lastSeenAt).getTime() < cutoff) {
      console.log(`[mdns-scanner] Removing stale discovered node: ${node.name} @ ${id}`);
      discovered.delete(id);
    }
  }
}

/** Send a PTR query for our service type */
function sendQuery(instance: ReturnType<typeof mdns>): void {
  instance.query({
    questions: [
      { name: `${SERVICE_TYPE}.local`, type: 'PTR' },
    ],
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start scanning for nodes via mDNS.
 * Non-fatal: if mDNS is unavailable, logs a warning and returns.
 */
export async function startMdnsScanner(): Promise<void> {
  if (mdnsInstance) return;

  console.log('[mdns-scanner] Starting mDNS discovery for armada nodes');

  try {
    if (!mdns) {
      try {
        mdns = (await import('multicast-dns')).default;
      } catch {
        console.log('[mdns-scanner] multicast-dns not installed — mDNS discovery disabled');
        return;
      }
    }
    mdnsInstance = mdns();

    // Listen for responses
    mdnsInstance.on('response', (response: any) => {
      const allAnswers = [...(response.answers ?? []), ...(response.additionals ?? [])];

      // Only process armada-node responses
      const hasarmadaService = allAnswers.some(
        (a) =>
          (a.type === 'PTR' && typeof a.data === 'string' && a.data.includes(SERVICE_TYPE)) ||
          (typeof a.name === 'string' && a.name.includes(SERVICE_TYPE)),
      );
      if (!hasarmadaService) return;

      const { name, ip, port } = parseAnswers(allAnswers);
      if (ip && port) {
        upsertDiscovered(name ?? 'unknown', ip, port);
      }
    });

    mdnsInstance.on('error', (err: any) => {
      console.warn('[mdns-scanner] mDNS error (non-fatal):', err.message);
    });

    // Initial scan
    sendQuery(mdnsInstance);

    // Periodic scans
    scanTimer = setInterval(() => {
      if (mdnsInstance) sendQuery(mdnsInstance);
    }, SCAN_INTERVAL_MS);

    // Prune stale entries every minute
    pruneTimer = setInterval(pruneStale, 60_000);
  } catch (err: any) {
    console.warn('[mdns-scanner] Failed to start mDNS scanner (non-fatal):', err.message);
  }
}

/**
 * Stop the mDNS scanner.
 */
export function stopMdnsScanner(): void {
  if (scanTimer !== null) { clearInterval(scanTimer); scanTimer = null; }
  if (pruneTimer !== null) { clearInterval(pruneTimer); pruneTimer = null; }
  if (mdnsInstance) {
    try { mdnsInstance.destroy(); } catch { /* ignore */ }
    mdnsInstance = null;
    console.log('[mdns-scanner] Stopped');
  }
}

/**
 * Return a snapshot of currently-discovered nodes.
 */
export function getDiscoveredNodes(): DiscoveredNode[] {
  return Array.from(discovered.values()).sort((a, b) =>
    a.firstSeenAt.localeCompare(b.firstSeenAt),
  );
}

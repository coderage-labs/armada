/**
 * mdns.ts — mDNS service advertiser for the fleet node agent.
 *
 * Advertises the node as `_fleet-node._tcp.local` so that fleet control
 * planes on the same LAN can discover it without manual registration.
 *
 * This is purely informational — the control plane must still explicitly
 * add a discovered node before it can be managed.
 */

import mdns from 'multicast-dns';
import os from 'node:os';
import { loadCredentials } from './credentials.js';

// ── Config ────────────────────────────────────────────────────────────────────

/** Resolvable service type — standard mDNS service type */
const SERVICE_TYPE = '_fleet-node._tcp';
const SERVICE_DOMAIN = 'local';
const PTR_NAME = `${SERVICE_TYPE}.${SERVICE_DOMAIN}`;

/** The port advertised — informational (gateway proxy port) */
const AGENT_PORT = parseInt(process.env.FLEET_AGENT_PORT ?? '3002', 10);

/** Node display name — prefer env var, fall back to OS hostname */
function getNodeName(): string {
  return (
    process.env.FLEET_NODE_NAME ??
    loadCredentials()?.nodeId ??
    os.hostname()
  );
}

// ── State ─────────────────────────────────────────────────────────────────────

let mdnsInstance: ReturnType<typeof mdns> | null = null;
let announceTimer: ReturnType<typeof setInterval> | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Get the primary non-loopback IPv4 address */
function getLocalIp(): string {
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return '127.0.0.1';
}

/** Build the full service instance name: `<nodeName>._fleet-node._tcp.local` */
function getServiceName(nodeName: string): string {
  return `${nodeName}.${PTR_NAME}`;
}

/**
 * Emit a single mDNS announcement for our service.
 * Sends PTR, SRV, TXT, and A records in one multicast packet.
 */
function announce(instance: ReturnType<typeof mdns>, nodeName: string): void {
  const ip = getLocalIp();
  const serviceName = getServiceName(nodeName);
  const hostFqdn = `${os.hostname()}.${SERVICE_DOMAIN}`;

  instance.respond({
    answers: [
      // PTR: service type → instance name
      {
        name: PTR_NAME,
        type: 'PTR',
        ttl: 120,
        data: serviceName,
      },
      // SRV: instance name → host + port
      {
        name: serviceName,
        type: 'SRV',
        ttl: 120,
        data: {
          priority: 0,
          weight: 0,
          port: AGENT_PORT,
          target: hostFqdn,
        },
      },
      // TXT: instance metadata
      {
        name: serviceName,
        type: 'TXT',
        ttl: 120,
        data: [
          Buffer.from(`name=${nodeName}`),
          Buffer.from(`port=${AGENT_PORT}`),
          Buffer.from(`fleet=1`),
        ],
      },
      // A: hostname → IP
      {
        name: hostFqdn,
        type: 'A',
        ttl: 120,
        data: ip,
      },
    ],
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start advertising this node via mDNS.
 * Announces immediately and re-announces every 60 seconds to keep TTLs fresh.
 * Also responds to incoming mDNS queries for our service type.
 */
export function startMdnsAdvertiser(): void {
  if (mdnsInstance) return; // already running

  const nodeName = getNodeName();
  console.log(`[mdns] Advertising as '${nodeName}' on ${PTR_NAME}`);

  try {
    mdnsInstance = mdns();

    // Respond to queries for our service type
    mdnsInstance.on('query', (query) => {
      const isOurService = query.questions.some(
        (q) => q.name === PTR_NAME || q.name === `${PTR_NAME}.` || q.type === 'PTR',
      );
      if (isOurService) {
        announce(mdnsInstance!, getNodeName());
      }
    });

    mdnsInstance.on('error', (err) => {
      console.warn('[mdns] mDNS error (non-fatal):', err.message);
    });

    // Initial announcement
    announce(mdnsInstance, nodeName);

    // Periodic re-announcement (TTL = 120s, re-announce every 60s)
    announceTimer = setInterval(() => {
      if (mdnsInstance) {
        announce(mdnsInstance, getNodeName());
      }
    }, 60_000);
  } catch (err: any) {
    console.warn('[mdns] Failed to start mDNS advertiser (non-fatal):', err.message);
  }
}

/**
 * Stop mDNS advertising and release the multicast socket.
 * Call on graceful shutdown.
 */
export function stopMdnsAdvertiser(): void {
  if (announceTimer !== null) {
    clearInterval(announceTimer);
    announceTimer = null;
  }
  if (mdnsInstance) {
    try {
      mdnsInstance.destroy();
    } catch {
      // ignore
    }
    mdnsInstance = null;
    console.log('[mdns] Advertiser stopped');
  }
}

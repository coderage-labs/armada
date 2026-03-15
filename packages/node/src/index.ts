/**
 * Armada Node Agent — entry point (WP7: HTTP server removed)
 *
 * The node agent now operates exclusively via WebSocket:
 *   - Connects to the control plane WS endpoint
 *   - Handles commands via WS handlers
 *   - Sends heartbeats
 *   - Starts the gateway proxy on port 3002 (HTTP bridge for agent containers)
 *
 * No Express HTTP server. Zero listening ports except the gateway proxy (3002).
 */

import './log-buffer.js';
import { connectToControlPlane } from './ws/connection.js';
import { startGatewayProxy } from './gateway/proxy.js';
import { docker } from './docker/client.js';
import { StatsCollector } from './stats.js';
import { ensureCredentialHelper } from './credential-helper.js';
import { startStatsStreamer } from './services/stats-streamer.js';
// Dynamic import — multicast-dns may not be installed in all environments
let startMdnsAdvertiser: () => void = () => {};
let stopMdnsAdvertiser: () => void = () => {};
try {
  const mdnsMod = await import('./mdns.js');
  startMdnsAdvertiser = mdnsMod.startMdnsAdvertiser;
  stopMdnsAdvertiser = mdnsMod.stopMdnsAdvertiser;
} catch {
  console.log('[node] mDNS not available — skipping discovery advertisement');
}

// ── Deploy credential helper on startup ─────────────────────────────
try {
  ensureCredentialHelper();
} catch (err) {
  console.warn('⚠️  Could not deploy credential helper:', err);
}

// ── Stats Collector ─────────────────────────────────────────────────

const stats = new StatsCollector(docker);
stats.start();

console.log('🐳 Armada Node Agent starting (WS-only mode)');
console.log(`   Stats collector: active (30s interval)`);

// ── mDNS service advertisement ───────────────────────────────────────
// Advertise this node so fleet control planes on the same LAN can discover it.
// Non-fatal: if mDNS fails (e.g. no multicast support) the agent still works.

startMdnsAdvertiser();

// ── Graceful shutdown ────────────────────────────────────────────────

function shutdown(signal: string): void {
  console.log(`\n[fleet-node] Received ${signal} — shutting down`);
  stopMdnsAdvertiser();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── WebSocket client to control plane ───────────────────────────────

connectToControlPlane();

// ── Live stats streaming (push-based, 10s interval) ─────────────────
// Started after connectToControlPlane so the WS connection is being established.
// The streamer skips sends when the socket isn't open yet.

startStatsStreamer();

// ── Gateway proxy (instance → control plane HTTP bridge) ────────────

startGatewayProxy();

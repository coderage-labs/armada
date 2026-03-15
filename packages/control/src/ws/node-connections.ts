import type WebSocket from 'ws';
import { randomBytes } from 'crypto';
import bcrypt from 'bcrypt';
import { eventBus } from '../infrastructure/event-bus.js';
import { nodesRepo } from '../repositories/node-repo.js';
import { instancesRepo } from '../repositories/index.js';

// How often to check for stale connections (ms)
const STALE_CHECK_INTERVAL_MS = 30_000;
// How long without a heartbeat before marking as stale (ms)
const STALE_THRESHOLD_MS = 90_000;

export interface NodeConnection {
  ws: WebSocket;
  nodeId: string;
  connectedAt: Date;
  lastHeartbeat: Date;
  /** Latest stats snapshot pushed by the node agent (null until first push) */
  liveStats: Record<string, unknown> | null;
}

export interface NodeVersionInfo {
  version: string;
  protocolVersion: number;
  compatible: boolean;
}

/**
 * Manages persistent WebSocket connections from node agents.
 * Tracks connection state and emits events on lifecycle changes.
 */
export class NodeConnectionManager {
  readonly connections: Map<string, NodeConnection> = new Map();
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private versionInfo = new Map<string, NodeVersionInfo>();

  constructor() {
    this.startStaleCheck();
  }

  /**
   * Register a new node WebSocket connection.
   */
  register(nodeId: string, ws: WebSocket): void {
    // If there's an existing connection for this node, close it first
    const existing = this.connections.get(nodeId);
    if (existing && existing.ws !== ws) {
      try {
        existing.ws.close(1000, 'Replaced by new connection');
      } catch (err: any) {
        console.warn('[node-connections] ws.close failed:', err.message);
      }
    }

    const connection: NodeConnection = {
      ws,
      nodeId,
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      liveStats: null,
    };

    this.connections.set(nodeId, connection);

    eventBus.emit('node.connected', { nodeId, connectedAt: connection.connectedAt.toISOString() });
  }

  /**
   * Unregister a node connection (e.g. on WebSocket close).
   */
  unregister(nodeId: string): void {
    if (!this.connections.has(nodeId)) return;
    this.connections.delete(nodeId);
    this.versionInfo.delete(nodeId);
    eventBus.emit('node.disconnected', { nodeId, disconnectedAt: new Date().toISOString() });
  }

  /**
   * Get the WebSocket for a connected node, or undefined if not connected.
   */
  getConnection(nodeId: string): WebSocket | undefined {
    return this.connections.get(nodeId)?.ws;
  }

  /**
   * Returns true if the node is currently connected and not stale.
   */
  isOnline(nodeId: string): boolean {
    return this.getStatus(nodeId) === 'online';
  }

  /**
   * Returns the connection status of a node.
   * - 'online'  — connected and heartbeat is recent
   * - 'stale'   — connected but no heartbeat for >90s
   * - 'offline' — not connected
   */
  getStatus(nodeId: string): 'online' | 'offline' | 'stale' {
    const conn = this.connections.get(nodeId);
    if (!conn) return 'offline';

    const now = Date.now();
    const age = now - conn.lastHeartbeat.getTime();
    if (age > STALE_THRESHOLD_MS) return 'stale';
    return 'online';
  }

  /**
   * Update the last heartbeat timestamp for a node.
   */
  handleHeartbeat(nodeId: string, data?: { containers?: Array<{ name: string; state: string; status: string }> }): void {
    const conn = this.connections.get(nodeId);
    if (!conn) return;
    conn.lastHeartbeat = new Date();

    // Reconcile instance status from container state
    if (data?.containers) {
      this.reconcileContainers(nodeId, data.containers);
    }
  }

  /**
   * Reconcile instance statuses based on actual container state from node.
   */
  private reconcileContainers(nodeId: string, containers: Array<{ name: string; state: string; status: string }>): void {
    try {
      const instances = instancesRepo.getAll().filter((i: any) => i.nodeId === nodeId);
      const containerMap = new Map(containers.map(c => [c.name, c]));

      for (const instance of instances) {
        const containerName = `armada-instance-${instance.name}`;
        const container = containerMap.get(containerName);
        const dbStatus = instance.status;

        if (dbStatus === 'running' && (!container || container.state !== 'running')) {
          // DB says running but container is missing or stopped
          console.warn(`[node-heartbeat] Instance ${instance.name} marked running but container ${container ? 'state=' + container.state : 'missing'} on node ${nodeId}. Marking stopped.`);
          instancesRepo.updateStatus(instance.id, 'stopped');
        } else if (dbStatus === 'stopped' && container?.state === 'running') {
          // Container running but DB says stopped — update to running
          console.log(`[node-heartbeat] Instance ${instance.name} container is running but DB says stopped. Marking running.`);
          instancesRepo.updateStatus(instance.id, 'running');
        }
      }
    } catch (err: any) {
      console.warn('[node-heartbeat] Container reconciliation failed:', err.message);
    }
  }

  /**
   * Store version info for a node (from node.hello event).
   */
  setNodeVersion(nodeId: string, info: NodeVersionInfo): void {
    this.versionInfo.set(nodeId, info);
  }

  /**
   * Retrieve stored version info for a node, or undefined if not yet received.
   */
  getNodeVersion(nodeId: string): NodeVersionInfo | undefined {
    return this.versionInfo.get(nodeId);
  }

  /**
   * Store a fresh stats snapshot pushed by the node agent.
   */
  updateLiveStats(nodeId: string, stats: Record<string, unknown>): void {
    const conn = this.connections.get(nodeId);
    if (!conn) return;
    conn.liveStats = stats;
  }

  /**
   * Retrieve the latest cached stats for a node, or null if none received yet.
   */
  getLiveStats(nodeId: string): Record<string, unknown> | null {
    return this.connections.get(nodeId)?.liveStats ?? null;
  }

  /**
   * Rotate the session credential for a connected node.
   * Generates a new 32-byte credential, hashes it, sends it to the node via WS,
   * and updates the DB hash on successful acknowledgement.
   *
   * Returns the new credential on success, throws on failure.
   */
  async rotateCredential(nodeId: string): Promise<{ sessionCredential: string }> {
    const conn = this.connections.get(nodeId);
    if (!conn || conn.ws.readyState !== conn.ws.OPEN) {
      throw new Error(`Node ${nodeId} is not connected`);
    }

    const sessionCredential = randomBytes(32).toString('hex');
    const newHash = await bcrypt.hash(sessionCredential, 10);

    // Send credential.rotate command to node; await ack
    await new Promise<void>((resolve, reject) => {
      const cmdId = crypto.randomUUID();
      const timeout = setTimeout(() => reject(new Error('credential.rotate timed out')), 15_000);

      const msg = JSON.stringify({
        type: 'command',
        id: cmdId,
        action: 'credential.rotate',
        params: { sessionCredential },
        timeout: 15_000,
      });

      // One-shot response listener
      const onMessage = (raw: WebSocket.RawData) => {
        try {
          const parsed = JSON.parse(raw.toString()) as { type: string; id: string; status: string };
          if (parsed.type === 'response' && parsed.id === cmdId) {
            conn.ws.off('message', onMessage);
            clearTimeout(timeout);
            if (parsed.status === 'ok') resolve();
            else reject(new Error('credential.rotate rejected by node'));
          }
        } catch (err: any) { console.warn('[node-connections] Failed to parse credential rotate response:', err.message); }
      };

      conn.ws.on('message', onMessage);
      conn.ws.send(msg, (err) => {
        if (err) {
          conn.ws.off('message', onMessage);
          clearTimeout(timeout);
          reject(err);
        }
      });
    });

    // Node acked — update DB
    nodesRepo.rotateSessionCredential(nodeId, newHash);
    return { sessionCredential };
  }

  /**
   * Clean up resources (stop stale check timer).
   */
  destroy(): void {
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }
  }

  private startStaleCheck(): void {
    this.staleCheckTimer = setInterval(() => {
      const now = Date.now();
      for (const [nodeId, conn] of this.connections) {
        const age = now - conn.lastHeartbeat.getTime();
        if (age > STALE_THRESHOLD_MS) {
          eventBus.emit('node.stale', {
            nodeId,
            lastHeartbeat: conn.lastHeartbeat.toISOString(),
            ageMs: age,
          });
        }
      }
    }, STALE_CHECK_INTERVAL_MS);

    // Don't block process exit
    if (this.staleCheckTimer.unref) {
      this.staleCheckTimer.unref();
    }
  }
}

/** Singleton NodeConnectionManager instance */
export const nodeConnectionManager = new NodeConnectionManager();

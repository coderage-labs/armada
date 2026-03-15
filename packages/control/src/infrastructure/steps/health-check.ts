import type { StepHandler } from '../step-registry.js';
import { eventBus } from '../event-bus.js';
import { instancesRepo } from '../../repositories/index.js';

export const healthCheckHandler: StepHandler = {
  name: 'health_check',
  async execute(ctx) {
    const { nodeId, instanceId, containerName, timeoutMs = 60_000 } = ctx.params;
    const node = ctx.services.nodeClient(nodeId);
    const start = Date.now();

    ctx.emit(`Waiting for ${containerName} to become healthy`, { containerName, timeoutMs });

    // Race: plugin-based reporting (fast, authoritative) vs HTTP polling (fallback)
    const readyFromPlugin = new Promise<{ source: 'plugin'; data: any }>((resolve) => {
      let unsub: (() => void) | null = null;
      const handler = (event: any) => {
        const data = event.data ?? event;
        if (data.instanceId === instanceId || data.instanceName === containerName.replace('armada-instance-', '')) {
          unsub?.();
          resolve({ source: 'plugin', data });
        }
      };
      unsub = eventBus.on('instance.ready', handler);
      // Cleanup on timeout
      setTimeout(() => unsub?.(), timeoutMs);
    });

    const readyFromProbe = (async (): Promise<{ source: 'probe'; data: any }> => {
      // Wait a few seconds for SIGUSR1 restart to complete before probing
      await new Promise(r => setTimeout(r, 3000));
      while (Date.now() - start < timeoutMs) {
        try {
          const probe = await node.relayRequest(containerName, 'GET', '/api/health') as any;
          if (probe?.status >= 200 && probe?.status < 500) {
            return { source: 'probe', data: { status: probe.status } };
          }
        } catch (err: any) { console.warn('[health-check] probe failed, retrying:', err.message); }
        await new Promise(r => setTimeout(r, 2000));
      }
      throw new Error('probe timeout');
    })();

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Health check timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    // Prevent unhandled rejection if the probe promise outlives the race
    // (e.g. when the main timeout wins first and readyFromProbe later rejects with 'probe timeout')
    readyFromProbe.catch(() => {});

    try {
      const result = await Promise.race([readyFromPlugin, readyFromProbe, timeout]);
      const elapsed = Date.now() - start;

      if (result.source === 'plugin') {
        const agents = result.data.agents || [];
        const healthy = agents.filter((a: any) => a.healthy).length;
        const total = agents.length;
        ctx.emit(`Instance ${containerName} ready (plugin) — ${healthy}/${total} agents healthy (${elapsed}ms)`, {
          containerName, agents, version: result.data.version,
        });
        const missing = agents.filter((a: any) => !a.reported);
        if (missing.length > 0) {
          ctx.emit(`Warning: ${missing.length} agent(s) not loaded: ${missing.map((a: any) => a.name).join(', ')}`, { missing });
        }
      } else {
        ctx.emit(`Instance ${containerName} ready (HTTP probe, ${elapsed}ms) — plugin not reporting yet`, { containerName });
      }

      // Mark instance as running — don't rely solely on heartbeats
      // (heartbeats may not arrive if plugin can't reach control plane)
      try {
        instancesRepo.update(instanceId, { status: 'running', statusMessage: '' });
        eventBus.emit('agent.updated', { instanceId });
      } catch (err: any) { console.warn('[health-check] Failed to update instance status:', err.message); }
    } catch (err: any) {
      throw new Error(`Container ${containerName} failed health check within ${timeoutMs}ms: ${err.message}`);
    }
  },
};

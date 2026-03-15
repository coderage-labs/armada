import os from 'node:os';
import { execSync } from 'node:child_process';
import type Docker from 'dockerode';
import { formatBytes } from '@coderage-labs/armada-shared';
import type {
  HostStats,
  ContainerResourceStats,
  ResourceSnapshot,
  CapacityResult,
} from '@coderage-labs/armada-shared';

export class StatsCollector {
  private history: ResourceSnapshot[] = [];
  private readonly maxSnapshots = 120; // 1 hour at 30s intervals
  private interval: ReturnType<typeof setInterval> | null = null;
  private docker: Docker;

  constructor(docker: Docker) {
    this.docker = docker;
  }

  start() {
    this.collect(); // immediate first collection
    this.interval = setInterval(() => this.collect(), 30_000);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
  }

  async collect() {
    try {
      const host = await this.collectHost();
      const containers = await this.collectContainers();
      const armada = {
        running: containers.length,
        allocatedMemory: containers.reduce((sum, c) => sum + c.memory.limit, 0),
        allocatedCpu: 0,
      };
      const snapshot: ResourceSnapshot = { timestamp: Date.now(), host, containers, armada };
      this.history.push(snapshot);
      if (this.history.length > this.maxSnapshots) this.history.shift();
    } catch (err) {
      console.error('Stats collection error:', err);
    }
  }

  private async collectHost(): Promise<HostStats> {
    const cpus = os.cpus();
    const loadAvg = os.loadavg() as [number, number, number];
    const usage = Math.min(100, (loadAvg[0] / cpus.length) * 100);

    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    let disk = { total: 0, used: 0, available: 0 };
    try {
      const df = execSync('df -B1 / | tail -1').toString().trim().split(/\s+/);
      disk = {
        total: parseInt(df[1]),
        used: parseInt(df[2]),
        available: parseInt(df[3]),
      };
    } catch {
      // Disk stats unavailable
    }

    return {
      cpu: { cores: cpus.length, usage: Math.round(usage * 10) / 10, loadAvg },
      memory: { total: totalMem, used: totalMem - freeMem, available: freeMem },
      disk,
    };
  }

  private async collectContainers(): Promise<ContainerResourceStats[]> {
    const containers = await this.docker.listContainers({
      filters: { label: ['armada.agent'] },
    });

    const stats: ContainerResourceStats[] = [];
    for (const c of containers) {
      try {
        const container = this.docker.getContainer(c.Id);
        const s = await container.stats({ stream: false }) as any;
        const cpuDelta =
          s.cpu_stats.cpu_usage.total_usage -
          (s.precpu_stats?.cpu_usage?.total_usage || 0);
        const systemDelta =
          s.cpu_stats.system_cpu_usage -
          (s.precpu_stats?.system_cpu_usage || 0);
        const cpuPercent =
          systemDelta > 0
            ? (cpuDelta / systemDelta) * (s.cpu_stats.online_cpus || 1) * 100
            : 0;

        stats.push({
          id: c.Id.slice(0, 12),
          name: c.Names[0]?.replace('/', '') || c.Id.slice(0, 12),
          cpu: Math.round(cpuPercent * 10) / 10,
          memory: {
            usage: s.memory_stats.usage || 0,
            limit: s.memory_stats.limit || 0,
          },
          network: {
            rx: Object.values(s.networks || {}).reduce(
              (sum: number, n: any) => sum + (n.rx_bytes || 0),
              0,
            ),
            tx: Object.values(s.networks || {}).reduce(
              (sum: number, n: any) => sum + (n.tx_bytes || 0),
              0,
            ),
          },
          uptime: Math.floor(
            Date.now() / 1000 - new Date(c.Created * 1000).getTime() / 1000,
          ),
        });
      } catch {
        // Skip containers we can't stat
      }
    }
    return stats;
  }

  getLatest(): ResourceSnapshot | null {
    return this.history.length
      ? this.history[this.history.length - 1]
      : null;
  }

  getHistory(periodMs: number = 3600_000): ResourceSnapshot[] {
    const since = Date.now() - periodMs;
    return this.history.filter((s) => s.timestamp >= since);
  }

  getCapacity(
    requestedMemory: number = 2 * 1024 * 1024 * 1024,
  ): CapacityResult {
    const latest = this.getLatest();
    if (!latest) {
      return {
        canSpawn: false,
        availableMemory: 0,
        reason: 'No stats available yet',
      };
    }
    const availableMemory = latest.host.memory.available;
    const canSpawn = availableMemory > requestedMemory * 1.2; // 20% headroom
    return {
      canSpawn,
      availableMemory,
      reason: canSpawn
        ? undefined
        : `Need ${formatBytes(requestedMemory)} but only ${formatBytes(availableMemory)} available`,
    };
  }
}

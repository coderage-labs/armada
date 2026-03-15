import Docker from 'dockerode';
import { mkdirSync, writeFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import { SHARED_HELPER_PATH } from '../credential-helper.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

export { docker };


export interface CreateContainerOptions {
  name: string;
  image: string;
  port: number;
  env: string[];
  volumes: {
    data: string;
    plugins: string;
  };
  resources: {
    memory: string;
    cpus: string;
  };
  network: string;
  labels: Record<string, string>;
}

/**
 * Parse a memory string like "4g", "512m", "1024k" into bytes.
 */
function parseMemory(mem: string): number {
  const match = mem.match(/^(\d+(?:\.\d+)?)\s*([kmgt])?b?$/i);
  if (!match) throw new Error(`Invalid memory format: ${mem}`);
  const value = parseFloat(match[1]);
  const unit = (match[2] || '').toLowerCase();
  const multipliers: Record<string, number> = {
    '': 1,
    k: 1024,
    m: 1024 ** 2,
    g: 1024 ** 3,
    t: 1024 ** 4,
  };
  return Math.floor(value * (multipliers[unit] ?? 1));
}

/**
 * Parse a CPU string like "2" or "0.5" into Docker's NanoCpus value.
 */
function parseCpus(cpus: string): number {
  return Math.floor(parseFloat(cpus) * 1e9);
}

/**
 * Create and start a container. Returns the container ID.
 */
export async function createContainer(opts: CreateContainerOptions): Promise<string> {
  // Docker bind mounts use HOST paths, not container paths.
  // The node agent's /data maps to HOST_DATA_DIR on the host (default /opt/armada-data).
  const hostDataDir = process.env.HOST_DATA_DIR || '/opt/armada-data';
  const toHostPath = (containerPath: string) =>
    containerPath.replace(/^\/data\//, `${hostDataDir}/`);

  // Ensure credentials directory exists with empty credentials + helper
  // Agent name is derived from labels or container name (strip armada- prefix)
  const agentName = opts.labels?.['armada.agent']?.replace(/^armada-/, '') || opts.name.replace(/^armada-/, '');
  const credDir = `/data/armada/${agentName}/credentials`;
  mkdirSync(credDir, { recursive: true });
  const credFile = `${credDir}/git-credentials.json`;
  if (!existsSync(credFile)) {
    writeFileSync(credFile, JSON.stringify({ credentials: [] }), { mode: 0o644 });
  }
  const helperDst = `${credDir}/armada-credential-helper`;
  if (existsSync(SHARED_HELPER_PATH) && (!existsSync(helperDst) || true)) {
    copyFileSync(SHARED_HELPER_PATH, helperDst);
    chmodSync(helperDst, 0o755);
  }

  const container = await docker.createContainer({
    name: opts.name,
    Hostname: opts.name,
    Image: opts.image,

    Cmd: ['node', 'openclaw.mjs', 'gateway', '--allow-unconfigured', '--bind', 'lan'],
    Env: [
      'PATH=/usr/local/armada-tools:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      ...(opts.env || []),
      `OPENCLAW_MDNS_HOSTNAME=${opts.name}`,
    ],
    Labels: {
      'armada.agent': opts.name,
      ...opts.labels,
    },
    ExposedPorts: { '18789/tcp': {} },
    HostConfig: {
      PortBindings: {
        '18789/tcp': [{ HostPort: String(opts.port) }],
      },
      Binds: [
        // Official OpenClaw image: HOME=/home/node, config at ~/.openclaw
        // Paths translated from container paths to host paths for Docker bind mounts
        `${toHostPath(opts.volumes.data)}:/home/node/.openclaw`,
        `${toHostPath(opts.volumes.plugins)}:/home/node/.openclaw/extensions`,
        `${hostDataDir}/tools/bin:/usr/local/armada-tools:ro`,
        // Git credential helper + credentials file
        `${toHostPath(credDir)}:/etc/armada:ro`,
      ],
      Memory: parseMemory(opts.resources.memory),
      NanoCpus: parseCpus(opts.resources.cpus),
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: opts.network,
    },
  });

  await container.start();

  // Fix volume permissions — Docker creates host dirs as root,
  // but the OpenClaw image runs as node (uid 1000)
  try {
    const exec = await container.exec({
      Cmd: ['chown', '-R', 'node:node', '/home/node/.openclaw'],
      User: 'root',
    });
    await exec.start({ Detach: false });
  } catch {
    // Best-effort — some setups may not need this
  }

  // Configure git to use the armada credential helper (as node user, the default runtime user)
  try {
    const gitExec = await container.exec({
      Cmd: ['git', 'config', '--global', 'credential.helper', '/etc/armada/armada-credential-helper'],
      User: 'node',
    });
    await gitExec.start({ Detach: false });
  } catch {
    // Best-effort — git may not be installed yet
  }



  return container.id;
}

/**
 * Start a stopped container.
 */
export async function startContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  await container.start();
}

/**
 * Stop a running container.
 */
export async function stopContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  await container.stop();
}

/**
 * Remove a container (force removes if still running).
 */
export async function removeContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  await container.remove({ force: true });
}

/**
 * Restart a container.
 */
export async function restartContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  await container.restart();
}

/**
 * Get buffered logs from a container as a string.
 */
export async function getContainerLogs(
  containerId: string,
  opts?: { tail?: number; since?: number },
): Promise<string> {
  const container = docker.getContainer(containerId);
  const logs = await container.logs({
    stdout: true,
    stderr: true,
    tail: opts?.tail ?? 200,
    since: opts?.since ?? 0,
  });
  return typeof logs === 'string' ? logs : logs.toString('utf-8');
}


export interface ContainerStats {
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRx: number;
  networkTx: number;
}

/**
 * Get point-in-time resource stats for a container.
 */
export async function getContainerStats(containerId: string): Promise<ContainerStats> {
  const container = docker.getContainer(containerId);
  const stats = (await container.stats({ stream: false })) as Docker.ContainerStats;

  const cpuDelta =
    stats.cpu_stats.cpu_usage.total_usage -
    stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta =
    (stats.cpu_stats.system_cpu_usage ?? 0) -
    (stats.precpu_stats.system_cpu_usage ?? 0);
  const onlineCpus =
    stats.cpu_stats.online_cpus ??
    stats.cpu_stats.cpu_usage.percpu_usage?.length ??
    1;
  const cpuPercent =
    systemDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus * 100 : 0;

  const memoryUsage = stats.memory_stats.usage ?? 0;
  const memoryLimit = stats.memory_stats.limit ?? 0;
  const memoryPercent = memoryLimit > 0 ? (memoryUsage / memoryLimit) * 100 : 0;

  let networkRx = 0;
  let networkTx = 0;
  if (stats.networks) {
    for (const iface of Object.values(stats.networks)) {
      networkRx += iface.rx_bytes;
      networkTx += iface.tx_bytes;
    }
  }

  return {
    cpuPercent: Math.round(cpuPercent * 100) / 100,
    memoryUsage,
    memoryLimit,
    memoryPercent: Math.round(memoryPercent * 100) / 100,
    networkRx,
    networkTx,
  };
}

/**
 * List all containers managed by the armada (labelled armada.agent).
 */
export async function listarmadaContainers(): Promise<Docker.ContainerInfo[]> {
  return docker.listContainers({
    all: true,
    filters: { label: ['armada.agent'] },
  });
}

/**
 * Pull a Docker image. Resolves when pull is complete.
 * The optional `onProgress` callback is called for each Docker progress event
 * (layer status updates, pull progress bars, etc.).
 */
export async function pullImage(
  image: string,
  onProgress?: (event: { status: string; progress?: string; id?: string }) => void,
): Promise<void> {
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null) => (err ? reject(err) : resolve()),
      onProgress,
    );
  });
}

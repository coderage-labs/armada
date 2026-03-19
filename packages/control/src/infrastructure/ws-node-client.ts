/**
 * WsNodeClient — WebSocket-based client for node agent communication.
 *
 * Mirrors the NodeClient interface but routes all commands through the
 * WebSocket CommandDispatcher instead of HTTP. WP7 will swap the active
 * client; for now this lives alongside the existing NodeClient.
 */

import { commandDispatcher } from '../ws/command-dispatcher.js';
import type { ProgressMessage, RepoDiscovery } from '@coderage-labs/armada-shared';

export class WsNodeClient {
  constructor(public readonly nodeId: string) {}

  // ── Internal helper ─────────────────────────────────────────────────────────

  private send(action: string, params: object, timeoutMs: number, onProgress: (msg: ProgressMessage) => void): Promise<unknown>;
  private send(action: string, params?: object, timeoutMs?: number): Promise<unknown>;
  private send(action: string, params: object = {}, timeoutMs?: number, onProgress?: (msg: ProgressMessage) => void): Promise<unknown> {
    if (onProgress) {
      return commandDispatcher.send(this.nodeId, action, params, timeoutMs ?? 30_000, onProgress);
    }
    return commandDispatcher.send(this.nodeId, action, params, timeoutMs);
  }

  // === Instance Lifecycle ===

  async createInstance(name: string, config: any): Promise<any> {
    // Instance lifecycle maps to container.create with armada defaults
    return this.send('container.create', { name, ...config }, 120_000);
  }

  async destroyInstance(name: string): Promise<void> {
    await this.send('container.remove', { id: name, force: true }, 60_000);
  }

  async startInstance(name: string): Promise<void> {
    await this.send('container.start', { id: name });
  }

  async stopInstance(name: string): Promise<void> {
    await this.send('container.stop', { id: name });
  }

  async restartInstance(name: string): Promise<void> {
    await this.send('container.restart', { id: name });
  }

  async reloadInstance(name: string): Promise<void> {
    await this.send('container.signal', { id: name, signal: 'SIGUSR1' });
  }

  async upgradeInstance(
    name: string,
    opts: { imageTag?: string; image?: string; tag?: string } = {},
  ): Promise<any> {
    const tag = opts.imageTag ?? opts.tag ?? 'latest';
    return this.send('container.upgrade', { containerId: name, tag }, 300_000);
  }

  async getInstanceHealth(name: string): Promise<any> {
    return this.send('container.inspect', { id: name });
  }

  // === Plugins ===

  async installPlugin(opts: {
    name: string;
    npmPkg?: string | null;
    source?: string | null;
    url?: string | null;
    version?: string | null;
    directory?: string | null;
  }): Promise<any> {
    // Send the npm package name (or name) + optional version to node agent.
    // Node agent defaults directory to the shared plugins dir.
    return this.send('plugin.install', {
      name: opts.npmPkg || opts.name,
      version: opts.version || undefined,
      directory: opts.directory || undefined,
    }, 180_000);
  }

  async backupPlugin(name: string): Promise<void> {
    await this.send('plugin.backup', { name }, 60_000);
  }

  async restorePlugin(name: string): Promise<void> {
    await this.send('plugin.restore', { name }, 60_000);
  }

  async deletePluginBackup(name: string): Promise<void> {
    await this.send('plugin.deleteBackup', { name });
  }

  async cleanupPlugins(keep: string[]): Promise<any> {
    return this.send('plugin.cleanup', { keep });
  }

  async listPlugins(directory?: string): Promise<any[]> {
    return this.send('plugin.list', directory ? { directory } : {}) as Promise<any[]>;
  }

  // === Instance Files ===

  async readInstanceFile(instanceName: string, path: string): Promise<any> {
    return this.send('file.read', { instance: instanceName, path });
  }

  async writeInstanceFile(instanceName: string, path: string, content: string): Promise<void> {
    await this.send('file.write', { instance: instanceName, path, content });
  }

  // === Credentials ===

  async syncCredentials(instanceName: string, agentName: string, credentials?: any): Promise<void> {
    const containerName = `armada-instance-${instanceName}`;
    const body = JSON.stringify({ agentName, credentials });
    await this.relayRequest(containerName, 'POST', '/armada/credentials', body);
  }

  // === Skills (per-container) ===

  async listContainerSkills(containerId: string): Promise<any[]> {
    return this.send('skill.list', { containerId }) as Promise<any[]>;
  }

  async installContainerSkill(containerId: string, opts: any): Promise<any> {
    return this.send('skill.install', { containerId, ...opts }, 120_000);
  }

  async removeContainerSkill(containerId: string, name: string): Promise<void> {
    await this.send('skill.remove', { containerId, name });
  }

  // === Containers ===

  async listContainers(): Promise<any> {
    return this.send('container.list', {});
  }

  async createContainer(opts: any): Promise<any> {
    return this.send('container.create', opts, 120_000);
  }

  async startContainer(id: string): Promise<void> {
    await this.send('container.start', { id });
  }

  async stopContainer(id: string): Promise<void> {
    await this.send('container.stop', { id });
  }

  async restartContainer(id: string): Promise<void> {
    await this.send('container.restart', { id });
  }

  async removeContainer(id: string): Promise<void> {
    await this.send('container.remove', { id }, 60_000);
  }

  async getContainerLogs(name: string, tail = 100, since?: number): Promise<string> {
    const params: Record<string, unknown> = { id: name, tail };
    if (since !== undefined) params.since = since;
    const result = (await this.send('container.logs', params)) as { logs: string };
    return result?.logs ?? '';
  }

  async getContainerStats(id: string): Promise<any> {
    return this.send('container.stats', { id });
  }

  /**
   * Stream live container logs via `logs.stream` command.
   * Each log line is delivered to the `onLine` callback via ProgressMessage.
   * Returns a cleanup function that stops forwarding lines after the client disconnects.
   *
   * The returned Promise rejects (quickly, within ~200ms) if the node returns an error
   * for the `logs.stream` action (e.g. unknown action on older nodes), allowing the
   * caller to fall back to polling.
   */
  streamContainerLogs(
    name: string,
    onLine: (line: string) => void,
    timeoutMs = 3_600_000, // 1 hour max stream
  ): Promise<() => void> {
    let active = true;

    return new Promise<() => void>((resolve, reject) => {
      let resolved = false;

      const onProgress = (msg: ProgressMessage) => {
        if (!active) return;
        if (msg.data?.step === 'log_line' && typeof msg.data.message === 'string') {
          onLine(msg.data.message);
        }
        // Confirm that the node supports logs.stream on first progress message
        if (!resolved) {
          resolved = true;
          resolve(() => { active = false; });
        }
      };

      // Wait briefly before resolving; if the node immediately errors, reject instead
      const startTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(() => { active = false; });
        }
      }, 500);

      this.send('logs.stream', { id: name }, timeoutMs, onProgress)
        .then(() => {
          clearTimeout(startTimer);
          if (!resolved) {
            resolved = true;
            resolve(() => { active = false; });
          }
        })
        .catch((err) => {
          clearTimeout(startTimer);
          if (!resolved) {
            resolved = true;
            // Reject so the route can fall back to polling
            reject(err);
          }
          // If already resolved (stream started), swallow the error
        });
    });
  }

  async signalContainer(name: string, signal = 'SIGUSR1'): Promise<void> {
    await this.send('container.signal', { id: name, signal });
  }

  async drainContainer(containerName: string, reason?: string): Promise<any> {
    const body = JSON.stringify({ reason });
    return this.relayRequest(containerName, 'POST', '/armada/drain', body);
  }

  /**
   * Relay an HTTP request to an instance's gateway.
   * Uses the node agent's instance.relay handler.
   */
  async relayRequest(containerName: string, method: string, path: string, body?: any): Promise<any> {
    return this.send('instance.relay', { instanceId: containerName, method, path, body });
  }

  async getContainerConfig(id: string): Promise<any> {
    return this.send('container.inspect', { id });
  }

  async putContainerConfig(id: string, config: any): Promise<void> {
    await this.send('file.write', {
      instance: id,
      path: '/etc/openclaw/config.json',
      content: JSON.stringify(config),
    });
  }

  async getContainerFile(id: string, path: string): Promise<any> {
    return this.send('file.read', { instance: id, path });
  }

  async putContainerFile(id: string, path: string, content: string): Promise<void> {
    await this.send('file.write', { instance: id, path, content });
  }

  async reloadContainer(id: string): Promise<void> {
    await this.send('container.restart', { id });
  }

  async recreateContainer(id: string, opts: any): Promise<any> {
    await this.send('container.remove', { id, force: true }, 60_000);
    return this.send('container.create', { id, ...opts }, 120_000);
  }

  // === Node Health ===

  async healthCheck(): Promise<any> {
    const [info, stats] = await Promise.all([
      this.send('node.info', {}) as Promise<Record<string, unknown>>,
      this.send('node.stats', {}).catch(() => null) as Promise<Record<string, unknown> | null>,
    ]);
    return { ...(info ?? {}), ...(stats ?? {}) };
  }

  async getStats(): Promise<any> {
    return this.send('node.stats', {});
  }

  async getStatsHistory(_period?: string): Promise<any> {
    return this.send('node.statsHistory', {});
  }

  async getCapacity(_memory?: number): Promise<any> {
    return this.send('node.capacity', {});
  }

  async getNodeLogs(limit = 100, since?: string): Promise<Array<{ timestamp: string; level: string; message: string }>> {
    const result = await this.send('node.logs', { limit, since }) as { logs: Array<{ timestamp: string; level: string; message: string }> };
    return result.logs;
  }

  // === Images & Networks ===

  async pullImage(image: string): Promise<any> {
    return this.send('image.pull', { image }, 120_000);
  }

  async ensureNetwork(name: string): Promise<any> {
    return this.send('network.ensure', { name });
  }

  // === Tools ===

  async ensureTools(
    tools: string[],
    binDir?: string,
  ): Promise<{ installed: string[]; failed: string[] }> {
    return this.send('tool.ensure', { tools, binDir }, 300_000) as Promise<
      { installed: string[]; failed: string[] }
    >;
  }

  async listTools(binDir?: string): Promise<{ tools: Array<{ name: string; size: number }> }> {
    return this.send('tool.list', { binDir }) as Promise<
      { tools: Array<{ name: string; size: number }> }
    >;
  }

  async updateTool(tool: string, binDir?: string): Promise<any> {
    return this.send('tool.update', { tool, binDir });
  }

  // === Skills (shared library) ===

  async listLibrarySkills(): Promise<any[]> {
    return this.send('skill.list', { scope: 'library' }) as Promise<any[]>;
  }

  async installLibrarySkill(opts: any): Promise<any> {
    return this.send('skill.install', { scope: 'library', ...opts }, 120_000);
  }

  async removeLibrarySkill(name: string): Promise<void> {
    await this.send('skill.remove', { scope: 'library', name });
  }

  // === File proxy ===

  async shareFile(body: any): Promise<any> {
    return this.send('file.share', body);
  }

  async downloadFile(ref: string): Promise<Response> {
    const result = await this.send('file.download', { path: ref }) as {
      data: string;
      size: number;
      mimeType: string;
    };
    const buf = Buffer.from(result.data, 'base64');
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': result.mimeType,
        'Content-Length': String(result.size),
      },
    });
  }

  async deliverFile(body: any): Promise<any> {
    return this.send('file.deliver', body);
  }

  async listFiles(agent: string): Promise<any> {
    return this.send('file.list', { agent });
  }

  async deleteFile(path: string, recursive = false): Promise<void> {
    await this.send('file.delete', { path, recursive });
  }

  // === Workspace Provisioning ===

  /**
   * Clone a git repo into an instance container and create a feature branch.
   * Runs `git clone` + `git checkout -b` (+ optional `npm install`) inside the container.
   *
   * @param instanceName  Instance name (without the armada-instance- prefix)
   * @param repo          GitHub repo in "owner/repo" format
   * @param branch        Branch name to create in the cloned repo
   * @param path          Optional target path inside the container (default: /tmp/work/<repoName>)
   */
  async cloneWorkspace(
    instanceName: string,
    repo: string,
    branch: string,
    path?: string,
  ): Promise<{ path: string; branch: string; status: string }> {
    const containerName = `armada-instance-${instanceName}`;
    return this.send('workspace.clone', { instanceId: containerName, repo, branch, path }, 300_000) as Promise<{
      path: string;
      branch: string;
      status: string;
    }>;
  }

  /**
   * Execute a shell command inside an instance container at a given working directory.
   * Returns exit code and combined stdout/stderr output.
   *
   * @param instanceName  Instance name (without the armada-instance- prefix)
   * @param path          Working directory inside the container
   * @param cmd           Shell command string to execute (run via sh -c)
   */
  async execInWorkspace(
    instanceName: string,
    path: string,
    cmd: string,
    timeoutMs = 120_000,
  ): Promise<{ exitCode: number; output: string }> {
    const containerName = `armada-instance-${instanceName}`;
    return this.send('workspace.exec', { instanceId: containerName, path, cmd }, timeoutMs) as Promise<{
      exitCode: number;
      output: string;
    }>;
  }

  /**
   * Discover workspace stacks and armada.json config inside a container.
   * Walks up to 2 levels deep detecting Node, Go, Python, Rust, Terraform, Java, etc.
   *
   * @param instanceName  Instance name (without the armada-instance- prefix)
   * @param path          Absolute path inside the container to discover from
   */
  async discoverWorkspace(instanceName: string, path: string): Promise<RepoDiscovery> {
    const containerName = `armada-instance-${instanceName}`;
    return this.send('workspace.discover', { instanceId: containerName, path }, 30_000) as Promise<RepoDiscovery>;
  }

  // === Instance event relay ===

  /**
   * Ask the node agent to start relaying SSE events from the given instance
   * back to the control plane over the WS tunnel.
   */
  async subscribeInstanceEvents(
    instanceId: string,
    instanceName: string,
    containerHostname: string,
  ): Promise<void> {
    await this.send('events.subscribe', { instanceId, instanceName, containerHostname });
  }

  /**
   * Ask the node agent to stop relaying SSE events from the given instance.
   */
  async unsubscribeInstanceEvents(instanceId: string): Promise<void> {
    await this.send('events.unsubscribe', { instanceId });
  }
}

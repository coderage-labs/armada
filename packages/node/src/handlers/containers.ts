import {
  WsErrorCode,
  type CommandMessage,
  type ResponseMessage,
  type ProgressMessage,
} from '@coderage-labs/armada-shared';

/** Context passed to command handlers for side-channel communication (e.g. progress). */
export interface ContainerHandlerContext {
  /** Send a progress update back over the same WS connection. */
  sendProgress?: (msg: ProgressMessage) => void;
}
import { ensureNetwork } from '../docker/network.js';
import {
  docker,
  listFleetContainers,
  createContainer,
  startContainer,
  stopContainer,
  restartContainer,
  removeContainer,
  getContainerLogs,
  getContainerStats,
  pullImage,
} from '../docker/index.js';
import { allocatePort, releasePort } from '../port-pool.js';

export async function handleContainerCommand(
  msg: CommandMessage,
  ctx?: ContainerHandlerContext,
): Promise<ResponseMessage> {
  const subAction = msg.action.split('.')[1]; // 'create', 'start', etc.

  try {
    switch (subAction) {
      case 'list': {
        const containers = await listFleetContainers();
        return ok(msg.id, containers);
      }

      case 'create': {
        const p = msg.params as any;
        if (!p.name || !p.image) {
          return error(msg.id, 'name and image are required', WsErrorCode.DOCKER_ERROR);
        }
        // Allocate port from local pool (idempotent — returns existing if already allocated)
        const containerName = p.name as string;
        const port = allocatePort(containerName);
        // Ensure the target network exists before creating
        const network = p.network ?? 'bridge';
        if (network !== 'bridge' && network !== 'host' && network !== 'none') {
          await ensureNetwork(network);
        }

        const containerId = await createContainer({
          name: containerName,
          image: p.image,
          port,
          env: p.env ?? [],
          volumes: p.volumes ?? {
            data: `/data/fleet/${containerName}`,
            plugins: '/data/fleet-plugins',
          },
          resources: p.resources ?? { memory: '512m', cpus: '0.5' },
          network,
          labels: p.labels ?? {},
        });
        return ok(msg.id, { containerId, port });
      }

      case 'start': {
        const { id } = msg.params as { id: string };
        if (!id) return error(msg.id, 'id is required', WsErrorCode.DOCKER_ERROR);
        await startContainer(id);
        return ok(msg.id, { status: 'started' });
      }

      case 'stop': {
        const { id, timeout } = msg.params as { id: string; timeout?: number };
        if (!id) return error(msg.id, 'id is required', WsErrorCode.DOCKER_ERROR);
        const container = docker.getContainer(id);
        await container.stop(timeout !== undefined ? { t: timeout } : undefined);
        return ok(msg.id, { status: 'stopped' });
      }

      case 'restart': {
        const { id } = msg.params as { id: string };
        if (!id) return error(msg.id, 'id is required', WsErrorCode.DOCKER_ERROR);
        await restartContainer(id);
        return ok(msg.id, { status: 'restarted' });
      }

      case 'remove': {
        const { id, force } = msg.params as { id: string; force?: boolean };
        if (!id) return error(msg.id, 'id is required', WsErrorCode.DOCKER_ERROR);
        const container = docker.getContainer(id);
        await container.remove({ force: force ?? false });
        releasePort(id);
        return ok(msg.id, { status: 'removed' });
      }

      case 'logs': {
        const { id, tail, since } = msg.params as { id: string; tail?: number; since?: number };
        if (!id) return error(msg.id, 'id is required', WsErrorCode.DOCKER_ERROR);
        const logs = await getContainerLogs(id, { tail: tail ?? 100, since });
        return ok(msg.id, { logs });
      }

      case 'stats': {
        const { id } = msg.params as { id: string };
        if (!id) return error(msg.id, 'id is required', WsErrorCode.DOCKER_ERROR);
        const stats = await getContainerStats(id);
        return ok(msg.id, stats);
      }

      case 'signal': {
        const { id, signal: sig } = msg.params as { id: string; signal?: string };
        if (!id) return error(msg.id, 'id is required', WsErrorCode.DOCKER_ERROR);
        const sigName = sig ?? 'SIGUSR1';
        // Docker's kill API sends signals to PID 1 (openclaw CLI wrapper),
        // but SIGUSR1 needs to reach the gateway process (openclaw-gateway).
        // Use exec to find and signal the gateway process directly.
        const container = docker.getContainer(id);
        const exec = await container.exec({
          Cmd: ['sh', '-c', `kill -${sigName.replace('SIG', '')} $(pgrep -x openclaw-gateway 2>/dev/null || pgrep -f "openclaw-gateway" 2>/dev/null | head -1) 2>/dev/null || kill -${sigName.replace('SIG', '')} 1`],
          AttachStdout: true,
          AttachStderr: true,
        });
        await exec.start({});
        return ok(msg.id, { status: 'signalled', signal: sigName });
      }

      case 'inspect': {
        const { id } = msg.params as { id: string };
        if (!id) return error(msg.id, 'id is required', WsErrorCode.DOCKER_ERROR);
        const container = docker.getContainer(id);
        const info = await container.inspect();
        return ok(msg.id, info);
      }

      case 'pull': {
        const { image } = msg.params as { image: string };
        if (!image) return error(msg.id, 'image is required', WsErrorCode.DOCKER_ERROR);

        // Throttled progress sender — max 1 event per second to avoid flooding
        let lastProgressAt = 0;
        const sendProgress = ctx?.sendProgress;

        await pullImage(image, sendProgress ? (event) => {
          const now = Date.now();
          if (now - lastProgressAt < 1000) return;
          lastProgressAt = now;
          sendProgress({
            type: 'progress',
            id: msg.id,
            data: {
              step: 'pull_image',
              message: event.status || '',
              detail: event.progress || undefined,
            },
          });
        } : undefined);

        return ok(msg.id, { status: 'pulled', image });
      }

      case 'upgrade': {
        const { containerId, tag } = msg.params as { containerId: string; tag?: string };
        if (!containerId) return error(msg.id, 'containerId is required', WsErrorCode.DOCKER_ERROR);

        // Inspect the existing container to capture its full config
        const container = docker.getContainer(containerId);
        const info = await container.inspect();

        const currentImage: string = info.Config.Image;
        const imageBase = currentImage.includes(':')
          ? currentImage.split(':').slice(0, -1).join(':')
          : currentImage;
        const newTag = tag ?? 'latest';
        const newImage = `${imageBase}:${newTag}`;

        // Pull new image first (fail fast before touching the running container)
        // Forward progress events if a sendProgress callback is available
        {
          let lastProgressAt = 0;
          const sendProgress = ctx?.sendProgress;
          await pullImage(newImage, sendProgress ? (event) => {
            const now = Date.now();
            if (now - lastProgressAt < 1000) return;
            lastProgressAt = now;
            sendProgress({
              type: 'progress',
              id: msg.id,
              data: {
                step: 'pull_image',
                message: event.status || '',
                detail: event.progress || undefined,
              },
            });
          } : undefined);
        }

        // Gracefully stop then remove the old container
        try { await container.stop({ t: 10 }); } catch (err: any) { console.warn('[containers] stop failed (already stopped?):', err.message); }
        await container.remove({ force: true });

        // Recreate with the new image, preserving the original config
        const newContainer = await docker.createContainer({
          ...info.Config,
          name: containerId,
          Image: newImage,
          HostConfig: info.HostConfig,
          NetworkingConfig: {
            EndpointsConfig: info.NetworkSettings.Networks,
          },
        });
        await newContainer.start();

        return ok(msg.id, { status: 'upgraded', image: newImage, containerId: newContainer.id });
      }

      default:
        return error(msg.id, `Unknown container action: ${msg.action}`, WsErrorCode.UNKNOWN);
    }
  } catch (err: any) {
    const isNotFound =
      err?.statusCode === 404 || err?.message?.includes('No such container');
    return {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: err?.message ?? String(err),
      code: isNotFound ? WsErrorCode.CONTAINER_NOT_FOUND : WsErrorCode.DOCKER_ERROR,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(id: string, data: unknown): ResponseMessage {
  return { type: 'response', id, status: 'ok', data };
}

function error(id: string, message: string, code: WsErrorCode): ResponseMessage {
  return { type: 'response', id, status: 'error', error: message, code };
}

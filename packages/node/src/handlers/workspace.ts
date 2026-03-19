/**
 * Workspace handler — pre-provisions git workspaces inside instance containers
 * before workflow steps are dispatched.
 *
 * Command: workspace.clone
 * Params:  { instanceId: string, repo: string, branch: string, path?: string }
 * Returns: { path: string, branch: string, status: 'ready' }
 */

import Docker from 'dockerode';
import type { CommandMessage, ResponseMessage } from '@coderage-labs/armada-shared';
import { WsErrorCode } from '@coderage-labs/armada-shared';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

/** Run a shell command inside a container and return stdout + stderr as a string. */
async function containerExec(containerId: string, cmd: string[]): Promise<{ exitCode: number; output: string }> {
  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    User: 'node',
  });

  return new Promise((resolve, reject) => {
    exec.start({ hijack: true, stdin: false }, (err: Error | null, stream: NodeJS.ReadableStream | undefined) => {
      if (err) return reject(err);
      if (!stream) return resolve({ exitCode: 0, output: '' });

      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', async () => {
        const raw = Buffer.concat(chunks);
        // Docker multiplexed stream: each frame has an 8-byte header
        // Byte 0: stream type (0=stdin, 1=stdout, 2=stderr)
        // Bytes 4-7: payload size (big-endian uint32)
        let output = '';
        let offset = 0;
        while (offset < raw.length) {
          if (offset + 8 > raw.length) break;
          const size = raw.readUInt32BE(offset + 4);
          const payload = raw.slice(offset + 8, offset + 8 + size);
          output += payload.toString('utf-8');
          offset += 8 + size;
        }

        try {
          const inspectResult = await exec.inspect();
          resolve({ exitCode: inspectResult.ExitCode ?? 0, output: output.trim() });
        } catch {
          resolve({ exitCode: 0, output: output.trim() });
        }
      });
    });
  });
}

export async function handleWorkspaceClone(msg: CommandMessage): Promise<ResponseMessage> {
  const params = msg.params as {
    instanceId: string;
    repo: string;
    branch: string;
    path?: string;
  };

  const { instanceId, repo, branch } = params;
  if (!instanceId || !repo || !branch) {
    return {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: 'instanceId, repo, and branch are required',
      code: WsErrorCode.UNKNOWN,
    };
  }

  const repoName = repo.split('/').pop() || 'work';
  const workPath = params.path || `/tmp/work/${repoName}`;

  console.log(`[workspace] Cloning ${repo} into ${instanceId}:${workPath} (branch: ${branch})`);

  try {
    // Ensure parent directory exists
    const mkdirResult = await containerExec(instanceId, ['mkdir', '-p', workPath]);
    if (mkdirResult.exitCode !== 0) {
      console.warn(`[workspace] mkdir failed (exit ${mkdirResult.exitCode}): ${mkdirResult.output}`);
    }

    // Clone the repo
    const cloneResult = await containerExec(instanceId, [
      'git', 'clone', `https://github.com/${repo}.git`, workPath,
    ]);

    if (cloneResult.exitCode !== 0) {
      return {
        type: 'response',
        id: msg.id,
        status: 'error',
        error: `git clone failed: ${cloneResult.output}`,
        code: WsErrorCode.UNKNOWN,
      };
    }

    // Create and checkout the branch
    const checkoutResult = await containerExec(instanceId, [
      'git', '-C', workPath, 'checkout', '-b', branch,
    ]);

    if (checkoutResult.exitCode !== 0) {
      // Branch might already exist — try checking it out without -b
      const checkoutExisting = await containerExec(instanceId, [
        'git', '-C', workPath, 'checkout', branch,
      ]);
      if (checkoutExisting.exitCode !== 0) {
        console.warn(`[workspace] git checkout failed: ${checkoutExisting.output}`);
        // Non-fatal — the repo is still cloned, agent can handle the branch
      }
    }

    // Check if package.json exists and run npm install if so
    const checkPkg = await containerExec(instanceId, [
      'sh', '-c', `test -f "${workPath}/package.json" && echo "yes" || echo "no"`,
    ]);

    if (checkPkg.output.trim() === 'yes') {
      console.log(`[workspace] Found package.json in ${workPath} — running npm install`);
      const npmResult = await containerExec(instanceId, [
        'npm', 'install', '--prefix', workPath,
      ]);
      if (npmResult.exitCode !== 0) {
        console.warn(`[workspace] npm install failed (non-fatal): ${npmResult.output}`);
      }
    }

    console.log(`[workspace] Workspace ready at ${instanceId}:${workPath}`);

    return {
      type: 'response',
      id: msg.id,
      status: 'ok',
      data: { path: workPath, branch, status: 'ready' },
    };
  } catch (err: any) {
    return {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: `Workspace clone failed: ${err.message}`,
      code: WsErrorCode.UNKNOWN,
    };
  }
}

export async function handleWorkspaceCommand(msg: CommandMessage): Promise<ResponseMessage> {
  switch (msg.action) {
    case 'workspace.clone':
      return handleWorkspaceClone(msg);
    default:
      return {
        type: 'response',
        id: msg.id,
        status: 'error',
        error: `Unknown workspace action: ${msg.action}`,
        code: WsErrorCode.UNKNOWN,
      };
  }
}

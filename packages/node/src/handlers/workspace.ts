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
import { discoverWorkspace } from './workspace-discovery.js';

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

export async function handleWorkspaceExec(msg: CommandMessage): Promise<ResponseMessage> {
  const params = msg.params as {
    instanceId: string;
    path: string;
    cmd: string;
  };

  const { instanceId, path: workPath, cmd } = params;
  if (!instanceId || !workPath || !cmd) {
    return {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: 'instanceId, path, and cmd are required',
      code: WsErrorCode.UNKNOWN,
    };
  }

  console.log(`[workspace] Exec in ${instanceId}:${workPath}: ${cmd}`);

  try {
    const result = await containerExec(instanceId, [
      'sh', '-c', `cd "${workPath}" && ${cmd}`,
    ]);

    return {
      type: 'response',
      id: msg.id,
      status: 'ok',
      data: { exitCode: result.exitCode, output: result.output },
    };
  } catch (err: any) {
    return {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: `Workspace exec failed: ${err.message}`,
      code: WsErrorCode.UNKNOWN,
    };
  }
}

export async function handleWorkspaceDiscover(msg: CommandMessage): Promise<ResponseMessage> {
  const params = msg.params as {
    instanceId: string;
    path: string;
  };

  const { instanceId, path: workPath } = params;
  if (!instanceId || !workPath) {
    return {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: 'instanceId and path are required',
      code: WsErrorCode.UNKNOWN,
    };
  }

  console.log(`[workspace] Discovering workspace in ${instanceId}:${workPath}`);

  try {
    // Create an exec function bound to this container
    const exec = (cmd: string[]) => containerExec(instanceId, cmd);
    const discovery = await discoverWorkspace(exec, workPath);

    console.log(`[workspace] Discovery complete: rootConfig=${!!discovery.rootConfig}, detected=${discovery.detected.length} packages`);

    return {
      type: 'response',
      id: msg.id,
      status: 'ok',
      data: discovery,
    };
  } catch (err: any) {
    return {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: `Workspace discovery failed: ${err.message}`,
      code: WsErrorCode.UNKNOWN,
    };
  }
}

export async function handleWorkspaceProvision(msg: CommandMessage): Promise<ResponseMessage> {
  const params = msg.params as {
    instanceId: string;
    repo: string;
    branch: string;
    stepId: string;
    runId: string;
    installCmd?: string;
  };

  const { instanceId, repo, branch, stepId, runId, installCmd } = params;
  if (!instanceId || !repo || !branch || !stepId || !runId) {
    return {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: 'instanceId, repo, branch, stepId, and runId are required',
      code: WsErrorCode.UNKNOWN,
    };
  }

  // Parse org and repo name from "owner/repo" or full https URL
  let repoOrg: string;
  let repoName: string;
  try {
    if (repo.startsWith('https://') || repo.startsWith('git@')) {
      const urlPart = repo.replace(/\.git$/, '').split(/[:/]/).slice(-2);
      repoOrg = urlPart[0];
      repoName = urlPart[1];
    } else {
      const parts = repo.split('/');
      repoOrg = parts[parts.length - 2] || 'org';
      repoName = parts[parts.length - 1] || 'repo';
    }
  } catch {
    repoOrg = 'org';
    repoName = repo.split('/').pop() || 'repo';
  }

  const basePath = `/data/repos/${repoOrg}/${repoName}`;
  const runPrefix = runId.slice(0, 8);
  const worktreePath = `/data/worktrees/${runPrefix}/${stepId}`;

  console.log(`[workspace] Provisioning worktree for run ${runPrefix}, step ${stepId}: ${worktreePath}`);

  try {
    // Step 1: Ensure base repo exists or clone it
    const checkBase = await containerExec(instanceId, [
      'sh', '-c', `test -d "${basePath}/.git" && echo "exists" || echo "missing"`,
    ]);

    if (checkBase.output.trim() === 'missing') {
      console.log(`[workspace] Base repo not found — cloning ${repo} to ${basePath}`);
      const mkdirResult = await containerExec(instanceId, ['mkdir', '-p', `/data/repos/${repoOrg}`]);
      if (mkdirResult.exitCode !== 0) {
        console.warn(`[workspace] mkdir failed: ${mkdirResult.output}`);
      }
      const cloneUrl = repo.startsWith('https://') || repo.startsWith('git@')
        ? repo
        : `https://github.com/${repo}.git`;
      const cloneResult = await containerExec(instanceId, ['git', 'clone', cloneUrl, basePath]);
      if (cloneResult.exitCode !== 0) {
        return {
          type: 'response',
          id: msg.id,
          status: 'error',
          error: `git clone failed: ${cloneResult.output}`,
          code: WsErrorCode.UNKNOWN,
        };
      }
    } else {
      // Fetch latest changes
      console.log(`[workspace] Fetching latest changes in ${basePath}`);
      const fetchResult = await containerExec(instanceId, [
        'git', '-C', basePath, 'fetch', 'origin',
      ]);
      if (fetchResult.exitCode !== 0) {
        console.warn(`[workspace] git fetch failed (non-fatal): ${fetchResult.output}`);
      }
    }

    // Step 2: Create worktree directory parent
    const mkWorktreeParent = await containerExec(instanceId, [
      'mkdir', '-p', `/data/worktrees/${runPrefix}`,
    ]);
    if (mkWorktreeParent.exitCode !== 0) {
      console.warn(`[workspace] mkdir for worktrees dir failed: ${mkWorktreeParent.output}`);
    }

    // Step 3: Add worktree
    const worktreeResult = await containerExec(instanceId, [
      'git', '-C', basePath, 'worktree', 'add', worktreePath, '-b', branch, 'origin/main',
    ]);
    if (worktreeResult.exitCode !== 0) {
      return {
        type: 'response',
        id: msg.id,
        status: 'error',
        error: `git worktree add failed: ${worktreeResult.output}`,
        code: WsErrorCode.UNKNOWN,
      };
    }

    // Step 4: Run install
    if (installCmd) {
      console.log(`[workspace] Running custom install command in ${worktreePath}`);
      const installResult = await containerExec(instanceId, [
        'sh', '-c', `cd "${worktreePath}" && ${installCmd}`,
      ]);
      if (installResult.exitCode !== 0) {
        console.warn(`[workspace] Custom install failed (non-fatal): ${installResult.output}`);
      }
    } else {
      // Check for armada.json first
      const checkArmada = await containerExec(instanceId, [
        'sh', '-c', `test -f "${worktreePath}/armada.json" && echo "yes" || echo "no"`,
      ]);

      if (checkArmada.output.trim() === 'yes') {
        // Read install command from armada.json
        const armadaReadResult = await containerExec(instanceId, [
          'sh', '-c', `cat "${worktreePath}/armada.json"`,
        ]);
        if (armadaReadResult.exitCode === 0) {
          try {
            const armadaConfig = JSON.parse(armadaReadResult.output);
            if (armadaConfig.install) {
              console.log(`[workspace] Running armada.json install: ${armadaConfig.install}`);
              const armadaInstallResult = await containerExec(instanceId, [
                'sh', '-c', `cd "${worktreePath}" && ${armadaConfig.install}`,
              ]);
              if (armadaInstallResult.exitCode !== 0) {
                console.warn(`[workspace] armada.json install failed (non-fatal): ${armadaInstallResult.output}`);
              }
            }
          } catch {
            console.warn(`[workspace] Failed to parse armada.json`);
          }
        }
      } else {
        // Check for package.json and run npm ci
        const checkPkg = await containerExec(instanceId, [
          'sh', '-c', `test -f "${worktreePath}/package.json" && echo "yes" || echo "no"`,
        ]);

        if (checkPkg.output.trim() === 'yes') {
          console.log(`[workspace] Found package.json — running npm ci in ${worktreePath}`);
          // Use base repo's node_modules cache via npm cache
          const npmCiResult = await containerExec(instanceId, [
            'sh', '-c', `cd "${worktreePath}" && npm ci --prefer-offline 2>&1 || npm install 2>&1`,
          ]);
          if (npmCiResult.exitCode !== 0) {
            console.warn(`[workspace] npm ci failed (non-fatal): ${npmCiResult.output}`);
          }
        }
      }
    }

    console.log(`[workspace] Worktree ready: ${instanceId}:${worktreePath} (branch: ${branch})`);

    return {
      type: 'response',
      id: msg.id,
      status: 'ok',
      data: { path: worktreePath, branch, status: 'ready' },
    };
  } catch (err: any) {
    return {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: `Workspace provision failed: ${err.message}`,
      code: WsErrorCode.UNKNOWN,
    };
  }
}

export async function handleWorkspaceCleanup(msg: CommandMessage): Promise<ResponseMessage> {
  const params = msg.params as {
    instanceId: string;
    runId: string;
  };

  const { instanceId, runId } = params;
  if (!instanceId || !runId) {
    return {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: 'instanceId and runId are required',
      code: WsErrorCode.UNKNOWN,
    };
  }

  const runPrefix = runId.slice(0, 8);
  const runDir = `/data/worktrees/${runPrefix}`;

  console.log(`[workspace] Cleaning up worktrees for run ${runPrefix} in ${instanceId}`);

  try {
    // Find all worktrees under the run directory
    const listResult = await containerExec(instanceId, [
      'sh', '-c', `find "${runDir}" -maxdepth 1 -mindepth 1 -type d 2>/dev/null || echo ""`,
    ]);

    const worktreePaths = listResult.output
      .split('\n')
      .map(p => p.trim())
      .filter(p => p.length > 0);

    let cleaned = 0;

    for (const wt of worktreePaths) {
      // Identify the base repo for this worktree (by checking which repo manages it)
      // Use git worktree remove from within the worktree's git directory
      const removeResult = await containerExec(instanceId, [
        'sh', '-c', `
          BASE=$(git -C "${wt}" rev-parse --git-common-dir 2>/dev/null | sed 's|/.git||' | sed 's|/\\.git$||')
          if [ -n "$BASE" ] && [ "$BASE" != "." ]; then
            git -C "$BASE" worktree remove "${wt}" --force 2>&1
          else
            rm -rf "${wt}"
          fi
        `,
      ]);

      if (removeResult.exitCode !== 0) {
        console.warn(`[workspace] Failed to remove worktree ${wt} (non-fatal): ${removeResult.output}`);
        // Force remove the directory as fallback
        await containerExec(instanceId, ['rm', '-rf', wt]);
      }
      cleaned++;
    }

    // Remove the run directory itself
    const rmDirResult = await containerExec(instanceId, ['rm', '-rf', runDir]);
    if (rmDirResult.exitCode !== 0) {
      console.warn(`[workspace] Failed to remove run dir ${runDir}: ${rmDirResult.output}`);
    }

    console.log(`[workspace] Cleaned ${cleaned} worktree(s) for run ${runPrefix}`);

    return {
      type: 'response',
      id: msg.id,
      status: 'ok',
      data: { cleaned },
    };
  } catch (err: any) {
    return {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: `Workspace cleanup failed: ${err.message}`,
      code: WsErrorCode.UNKNOWN,
    };
  }
}

export async function handleWorkspaceCommand(msg: CommandMessage): Promise<ResponseMessage> {
  switch (msg.action) {
    case 'workspace.clone':
      return handleWorkspaceClone(msg);
    case 'workspace.provision':
      return handleWorkspaceProvision(msg);
    case 'workspace.cleanup':
      return handleWorkspaceCleanup(msg);
    case 'workspace.discover':
      return handleWorkspaceDiscover(msg);
    case 'workspace.exec':
      return handleWorkspaceExec(msg);
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

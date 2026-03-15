import { execFile } from 'child_process';
import { promisify } from 'util';
import { rm, symlink, readlink, readFile, writeFile, mkdir, stat, readdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import type { CommandMessage, ResponseMessage } from '@coderage-labs/armada-shared';
import { WsErrorCode } from '@coderage-labs/armada-shared';
import { docker } from '../docker/client.js';

const execFileAsync = promisify(execFile);

/** Default shared plugins directory — mounted into all instances as extensions/ */
const DEFAULT_PLUGINS_DIR = process.env.ARMADA_PLUGINS_DIR || '/data/armada-plugins';

/** Default shared skills library directory */
const DEFAULT_SKILLS_LIBRARY_DIR = process.env.ARMADA_SKILLS_DIR || '/data/armada-library-skills';

/** Base directory where per-instance data volumes live */
const ARMADA_INSTANCES_DIR = process.env.ARMADA_INSTANCES_DIR || '/data/armada/instances';

function errorResponse(msg: CommandMessage, err: unknown): ResponseMessage {
  const e = err as Error;
  return {
    type: 'response',
    id: msg.id,
    status: 'error',
    error: e.message,
    code: WsErrorCode.UNKNOWN,
  };
}

function validateName(name: string): void {
  // Allow scoped npm packages (@scope/name) but reject path traversal
  if (!name || name.includes('..') || name.includes('/..') || (name.includes('/') && !name.startsWith('@'))) {
    throw new Error(`Invalid package name: ${name}`);
  }
}

/**
 * Ensure the plugins directory has a package.json and .npmrc for GitHub Packages.
 */
async function ensurePluginsDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });

  const pkgPath = join(directory, 'package.json');
  if (!existsSync(pkgPath)) {
    await writeFile(pkgPath, JSON.stringify({
      name: 'armada-plugins',
      private: true,
      dependencies: {},
    }, null, 2));
  }

  // Set up .npmrc for @coderage-labs scoped packages on GitHub Packages
  // Ensure .npmrc uses public npm registry (no auth needed)
  const npmrcPath = join(directory, '.npmrc');
  await writeFile(npmrcPath, 'registry=https://registry.npmjs.org\n');
}

/**
 * After npm install, find the plugin's manifest ID and create a top-level
 * symlink so OpenClaw can discover it in extensions/<plugin-id>/.
 *
 * OpenClaw scans extensions/ for directories containing openclaw.plugin.json.
 * npm puts scoped packages in node_modules/@scope/name/ which OpenClaw won't find.
 */
async function linkPlugin(directory: string, npmPkg: string): Promise<string | null> {
  const pkgDir = join(directory, 'node_modules', npmPkg);

  // Read the plugin manifest to get its ID
  const manifestPath = join(pkgDir, 'openclaw.plugin.json');
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
    const pluginId = manifest.id || manifest.name;
    if (!pluginId) return null;

    const linkPath = join(directory, pluginId);

    // Remove existing link/dir if it exists
    try {
      const existing = await stat(linkPath).catch(() => null);
      const existingLink = await readlink(linkPath).catch(() => null);
      if (existingLink || existing) {
        await rm(linkPath, { recursive: true, force: true });
      }
    } catch (err: any) { console.warn('[plugins] rm linkPath failed:', err.message); }

    // Create relative symlink so it resolves correctly when mounted inside containers
    // e.g. armada-agent → node_modules/@coderage-labs/armada-agent-plugin
    const relativePath = join('node_modules', npmPkg);
    await symlink(relativePath, linkPath);

    return pluginId;
  } catch (err: any) {
    console.warn('[plugins] Failed to install plugin symlink:', err.message);
    return null;
  }
}

async function handlePluginInstall(msg: CommandMessage): Promise<ResponseMessage> {
  const params = msg.params as { name: string; version?: string; directory?: string };
  const { name, version } = params;
  const directory = params.directory || DEFAULT_PLUGINS_DIR;

  if (!name) {
    return { type: 'response', id: msg.id, status: 'error', error: 'name is required', code: WsErrorCode.UNKNOWN };
  }
  validateName(name);

  await ensurePluginsDir(directory);

  // Always install latest unless a specific version is requested
  const pkg = version ? `${name}@${version}` : `${name}@latest`;
  const { stdout, stderr } = await execFileAsync('npm', ['install', pkg], {
    cwd: directory,
    timeout: 120_000,
  });

  // Link the plugin so OpenClaw can find it
  const pluginId = await linkPlugin(directory, name);

  return {
    type: 'response',
    id: msg.id,
    status: 'ok',
    data: {
      installed: pkg,
      pluginId,
      directory,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    },
  };
}

async function handlePluginRemove(msg: CommandMessage): Promise<ResponseMessage> {
  const params = msg.params as { name: string; directory?: string };
  const { name } = params;
  const directory = params.directory || DEFAULT_PLUGINS_DIR;

  if (!name) {
    return { type: 'response', id: msg.id, status: 'error', error: 'name is required', code: WsErrorCode.UNKNOWN };
  }
  validateName(name);

  // Remove the symlink if it exists (read manifest first)
  const pkgDir = join(directory, 'node_modules', name);
  try {
    const manifestPath = join(pkgDir, 'openclaw.plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8').catch(() => '{}'));
    const pluginId = manifest.id || manifest.name;
    if (pluginId) {
      await rm(join(directory, pluginId), { force: true });
    }
  } catch (err: any) { console.warn('[plugins] No manifest, skipping symlink cleanup:', err.message); }

  // npm uninstall
  try {
    await execFileAsync('npm', ['uninstall', name], {
      cwd: directory,
      timeout: 60_000,
    });
  } catch (err: any) {
    console.warn('[plugins] npm uninstall failed, removing directory directly:', err.message);
    await rm(pkgDir, { recursive: true, force: true });
  }

  return {
    type: 'response',
    id: msg.id,
    status: 'ok',
    data: { removed: name, directory },
  };
}

async function handlePluginList(msg: CommandMessage): Promise<ResponseMessage> {
  const params = msg.params as { directory?: string };
  const directory = params?.directory || DEFAULT_PLUGINS_DIR;

  const plugins: Array<{ name: string; id?: string; version?: string }> = [];

  try {
    const { readdir } = await import('fs/promises');
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'package.json' ||
          entry.name === 'package-lock.json' || entry.name === '.npmrc' ||
          entry.name.startsWith('.')) continue;

      const manifestPath = join(directory, entry.name, 'openclaw.plugin.json');
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
        plugins.push({
          name: manifest.name || entry.name,
          id: manifest.id,
          version: manifest.version,
        });
      } catch (err: any) {
        console.warn('[plugins] Failed to read plugin manifest:', err.message);
      }
    }
  } catch (err: any) { console.warn('[plugins] Failed to read plugins directory:', err.message); }

  return {
    type: 'response',
    id: msg.id,
    status: 'ok',
    data: plugins,
  };
}

// ── Plugin backup / restore / cleanup ────────────────────────────────────────

/**
 * Sanitise a plugin name into a safe backup directory name.
 * Turns "@scope/name" into "scope_name", strips other unsafe chars.
 */
function backupDirName(name: string): string {
  return name.replace(/^@/, '').replace(/\//g, '_');
}

async function handlePluginBackup(msg: CommandMessage): Promise<ResponseMessage> {
  const params = msg.params as { name: string; directory?: string };
  const { name } = params;
  const directory = params.directory || DEFAULT_PLUGINS_DIR;

  if (!name) {
    return { type: 'response', id: msg.id, status: 'error', error: 'name is required', code: WsErrorCode.UNKNOWN };
  }
  validateName(name);

  const pluginDir = join(directory, 'node_modules', name);
  const backupDir = join(directory, '.backup', backupDirName(name));

  if (!existsSync(pluginDir)) {
    return { type: 'response', id: msg.id, status: 'error', error: `Plugin directory not found: ${pluginDir}`, code: WsErrorCode.UNKNOWN };
  }

  // Remove stale backup first, then copy
  await rm(backupDir, { recursive: true, force: true });
  await mkdir(join(directory, '.backup'), { recursive: true });
  await execFileAsync('cp', ['-r', pluginDir, backupDir]);

  return {
    type: 'response',
    id: msg.id,
    status: 'ok',
    data: { backedUp: name, backupDir },
  };
}

async function handlePluginRestore(msg: CommandMessage): Promise<ResponseMessage> {
  const params = msg.params as { name: string; directory?: string };
  const { name } = params;
  const directory = params.directory || DEFAULT_PLUGINS_DIR;

  if (!name) {
    return { type: 'response', id: msg.id, status: 'error', error: 'name is required', code: WsErrorCode.UNKNOWN };
  }
  validateName(name);

  const backupDir = join(directory, '.backup', backupDirName(name));
  const pluginDir = join(directory, 'node_modules', name);

  if (!existsSync(backupDir)) {
    return { type: 'response', id: msg.id, status: 'error', error: `Backup not found: ${backupDir}`, code: WsErrorCode.UNKNOWN };
  }

  // Remove current install then restore from backup
  await rm(pluginDir, { recursive: true, force: true });
  await mkdir(join(directory, 'node_modules', ...(name.startsWith('@') ? [name.split('/')[0]] : [])), { recursive: true });
  await execFileAsync('cp', ['-r', backupDir, pluginDir]);

  return {
    type: 'response',
    id: msg.id,
    status: 'ok',
    data: { restored: name, from: backupDir },
  };
}

async function handlePluginDeleteBackup(msg: CommandMessage): Promise<ResponseMessage> {
  const params = msg.params as { name: string; directory?: string };
  const { name } = params;
  const directory = params.directory || DEFAULT_PLUGINS_DIR;

  if (!name) {
    return { type: 'response', id: msg.id, status: 'error', error: 'name is required', code: WsErrorCode.UNKNOWN };
  }
  validateName(name);

  const backupDir = join(directory, '.backup', backupDirName(name));
  await rm(backupDir, { recursive: true, force: true });

  return {
    type: 'response',
    id: msg.id,
    status: 'ok',
    data: { deleted: backupDir },
  };
}

async function handlePluginCleanup(msg: CommandMessage): Promise<ResponseMessage> {
  const params = msg.params as { keep: string[]; directory?: string };
  const { keep = [] } = params;
  const directory = params.directory || DEFAULT_PLUGINS_DIR;

  const keepSet = new Set(keep.map(backupDirName));
  const nodeModules = join(directory, 'node_modules');
  const removed: string[] = [];

  try {
    const entries = await readdir(nodeModules, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('@')) {
        // Scoped packages — check one level deeper
        const scopeDir = join(nodeModules, entry.name);
        try {
          const scoped = await readdir(scopeDir, { withFileTypes: true });
          for (const pkg of scoped) {
            const fullName = `${entry.name}/${pkg.name}`;
            if (!keepSet.has(backupDirName(fullName))) {
              await rm(join(scopeDir, pkg.name), { recursive: true, force: true });
              removed.push(fullName);
            }
          }
        } catch (err: any) { console.warn('[plugins] Failed to read scope directory entry:', err.message); }
      } else if (entry.name !== '.package-lock.json' && entry.name !== '.cache') {
        if (!keepSet.has(backupDirName(entry.name))) {
          await rm(join(nodeModules, entry.name), { recursive: true, force: true });
          removed.push(entry.name);
        }
      }
    }
  } catch (err: any) { console.warn('[plugins] node_modules may not exist:', err.message); }

  return {
    type: 'response',
    id: msg.id,
    status: 'ok',
    data: { removed, kept: keep },
  };
}

// ── skill.list ────────────────────────────────────────────────────────────────

/**
 * Resolve the skills directory for a container by inspecting its Docker bind mounts.
 * Skills live at ~/.openclaw/workspace/skills inside the container.
 */
async function resolveContainerSkillsDir(containerId: string): Promise<string> {
  const container = docker.getContainer(containerId);
  const info = await container.inspect();

  // Find the bind mount for /home/node/.openclaw
  const mount = info.Mounts?.find(
    (m: { Destination: string; Source: string }) =>
      m.Destination === '/home/node/.openclaw',
  );

  if (!mount?.Source) {
    // Fallback: try to derive from known volume convention
    // Container name is typically "armada-instance-{name}" and data is at
    // ARMADA_INSTANCES_DIR/{name}
    const instanceName = containerId.replace(/^armada-instance-/, '').replace(/^armada-/, '');
    return join(ARMADA_INSTANCES_DIR, instanceName, 'workspace', 'skills');
  }

  // mount.Source is the host path; from the node agent's perspective this
  // is already accessible (the agent's /data == HOST_DATA_DIR on the host).
  const hostDataDir = process.env.HOST_DATA_DIR || '/opt/armada-data';
  // Convert host path back to the agent container path (/data/...)
  const agentPath = mount.Source.startsWith(hostDataDir)
    ? mount.Source.replace(hostDataDir, '/data')
    : mount.Source;

  return join(agentPath, 'workspace', 'skills');
}

async function handleSkillList(msg: CommandMessage): Promise<ResponseMessage> {
  const params = msg.params as { containerId?: string; scope?: string; directory?: string };

  let skillsDir: string;

  if (params.containerId) {
    try {
      skillsDir = await resolveContainerSkillsDir(params.containerId);
    } catch (err) {
      return errorResponse(msg, err);
    }
  } else if (params.scope === 'library') {
    skillsDir = params.directory || DEFAULT_SKILLS_LIBRARY_DIR;
  } else {
    skillsDir = params.directory || DEFAULT_SKILLS_LIBRARY_DIR;
  }

  const skills: Array<{ name: string; version?: string; description?: string }> = [];

  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      // Read SKILL.md or package.json to get metadata
      let version: string | undefined;
      let description: string | undefined;

      try {
        const pkgJson = JSON.parse(
          await readFile(join(skillsDir, entry.name, 'package.json'), 'utf-8'),
        );
        version = pkgJson.version;
        description = pkgJson.description;
      } catch (err: any) { console.warn('[plugins] Failed to read skill package.json:', err.message); }

      skills.push({ name: entry.name, version, description });
    }
  } catch (err: any) { console.warn('[plugins] Skills directory does not exist:', err.message); }

  return {
    type: 'response',
    id: msg.id,
    status: 'ok',
    data: skills,
  };
}

async function handleSkillInstall(msg: CommandMessage): Promise<ResponseMessage> {
  const { name, version, directory } = msg.params as { name: string; version?: string; directory: string };
  if (!name || !directory) {
    return { type: 'response', id: msg.id, status: 'error', error: 'name and directory are required', code: WsErrorCode.UNKNOWN };
  }
  validateName(name);
  const pkg = version ? `${name}@${version}` : name;
  const { stdout, stderr } = await execFileAsync('npm', ['install', pkg], {
    cwd: directory,
    timeout: 120_000,
  });
  return {
    type: 'response',
    id: msg.id,
    status: 'ok',
    data: { installed: pkg, directory, stdout: stdout.trim(), stderr: stderr.trim() },
  };
}

async function handleSkillRemove(msg: CommandMessage): Promise<ResponseMessage> {
  const { name, directory } = msg.params as { name: string; directory: string };
  if (!name || !directory) {
    return { type: 'response', id: msg.id, status: 'error', error: 'name and directory are required', code: WsErrorCode.UNKNOWN };
  }
  validateName(name);
  const skillDir = join(directory, name);
  await rm(skillDir, { recursive: true, force: true });
  return {
    type: 'response',
    id: msg.id,
    status: 'ok',
    data: { removed: name, directory },
  };
}

export async function handlePluginCommand(msg: CommandMessage): Promise<ResponseMessage> {
  try {
    switch (msg.action) {
      case 'plugin.install':     return await handlePluginInstall(msg);
      case 'plugin.remove':      return await handlePluginRemove(msg);
      case 'plugin.list':        return await handlePluginList(msg);
      case 'plugin.backup':      return await handlePluginBackup(msg);
      case 'plugin.restore':     return await handlePluginRestore(msg);
      case 'plugin.deleteBackup': return await handlePluginDeleteBackup(msg);
      case 'plugin.cleanup':     return await handlePluginCleanup(msg);
      case 'skill.install':      return await handleSkillInstall(msg);
      case 'skill.remove':       return await handleSkillRemove(msg);
      case 'skill.list':         return await handleSkillList(msg);
      default:
        return {
          type: 'response',
          id: msg.id,
          status: 'error',
          error: `Unknown plugin/skill action: ${msg.action}`,
          code: WsErrorCode.UNKNOWN,
        };
    }
  } catch (err) {
    return errorResponse(msg, err);
  }
}

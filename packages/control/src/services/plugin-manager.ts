import { templatesRepo, agentsRepo, instancesRepo } from '../repositories/index.js';
import { pluginLibraryRepo } from '../repositories/index.js';
import { eventBus } from '../infrastructure/event-bus.js';
import { operationManager } from '../infrastructure/operations.js';
import { getNodeClient } from '../infrastructure/node-client.js';
import { instanceManager } from './instance-manager.js';
import { logActivity } from './activity-service.js';
import { dispatchWebhook } from './webhook-dispatcher.js';
import type { LibraryPlugin } from '@coderage-labs/armada-shared';

// ── Interface ───────────────────────────────────────────────────────

export interface PluginManager {
  // Library CRUD
  list(): LibraryPlugin[];
  get(id: string): LibraryPlugin | null;
  getByName(name: string): LibraryPlugin | null;
  create(opts: Partial<LibraryPlugin>): LibraryPlugin;
  update(id: string, patch: Partial<LibraryPlugin>): LibraryPlugin;
  delete(id: string): void;
  getUsage(id: string): { templates: string[]; instances?: string[]; system?: boolean };

  // Node operations
  install(opts: { name: string; npmPkg?: string | null; source?: string; url?: string | null; version?: string | null }): Promise<void>;
  cleanup(keep: string[]): Promise<any>;

  // Rollout
  batchRollout(pluginIds: string[]): string; // returns operationId

  // Seed
  seed(): void;
}

// ── Seed data ───────────────────────────────────────────────────────

const SYSTEM_PLUGINS = [
  { name: 'armada-agent', description: 'Armada agent communication plugin — heartbeats, task dispatch, credential injection', system: true },
];

const DEFAULT_PLUGINS = [
  { name: 'openclaw-wake-after', npmPkg: '@coderage-labs/openclaw-wake-after', source: 'npm' as const, description: 'Wake timer plugin for scheduled reminders', system: false },
];

// ── Implementation ──────────────────────────────────────────────────

class PluginManagerImpl implements PluginManager {
  // ── Library CRUD ────────────────────────────────────────────────

  list(): LibraryPlugin[] {
    return pluginLibraryRepo.getAll();
  }

  get(id: string): LibraryPlugin | null {
    return pluginLibraryRepo.get(id);
  }

  getByName(name: string): LibraryPlugin | null {
    return pluginLibraryRepo.getByName(name);
  }

  create(opts: Partial<LibraryPlugin>): LibraryPlugin {
    if (!opts.name) throw new Error('name is required');
    const existing = pluginLibraryRepo.getByName(opts.name);
    if (existing) throw Object.assign(new Error('Plugin already exists in library'), { status: 409, plugin: existing });

    const plugin = pluginLibraryRepo.create({
      name: opts.name,
      npmPkg: opts.npmPkg ?? undefined,
      source: opts.source,
      url: opts.url ?? undefined,
      version: opts.version ?? undefined,
      description: opts.description,
      system: opts.system,
    });

    logActivity({ eventType: 'plugin.library.add', detail: `Added plugin "${opts.name}" to library` });
    eventBus.emit('plugin.library.add', { plugin });
    return plugin;
  }

  update(id: string, patch: Partial<LibraryPlugin>): LibraryPlugin {
    const plugin = pluginLibraryRepo.update(id, patch);
    logActivity({ eventType: 'plugin.library.update', detail: `Updated plugin "${plugin.name}"` });
    eventBus.emit('plugin.library.update', { plugin });
    return plugin;
  }

  delete(id: string): void {
    const plugin = pluginLibraryRepo.get(id);
    if (!plugin) throw Object.assign(new Error('Plugin not found'), { status: 404 });
    if (plugin.system) throw Object.assign(new Error('Cannot delete system plugins'), { status: 403 });

    pluginLibraryRepo.delete(id);
    logActivity({ eventType: 'plugin.library.remove', detail: `Removed plugin "${plugin.name}" from library` });
    eventBus.emit('plugin.library.remove', { name: plugin.name });
  }

  getUsage(id: string): { templates: string[]; instances?: string[]; system?: boolean } {
    let plugin = pluginLibraryRepo.get(id);
    if (!plugin) plugin = pluginLibraryRepo.getByName(id);
    if (!plugin) throw Object.assign(new Error('Plugin not found'), { status: 404 });

    if (plugin.system) {
      const instances = instancesRepo.getAll();
      return { templates: [], instances: instances.map((i: any) => i.name), system: true };
    }

    const templates = pluginLibraryRepo.getUsage(plugin.id);
    return { templates };
  }

  // ── Node operations ─────────────────────────────────────────────

  async install(opts: { name: string; npmPkg?: string | null; source?: string; url?: string | null; version?: string | null }): Promise<void> {
    const node = getNodeClient();
    await node.installPlugin({
      name: opts.name,
      npmPkg: opts.npmPkg ?? undefined,
      source: opts.source || 'github',
      url: opts.url ?? undefined,
      version: opts.version ?? undefined,
    });
    logActivity({ eventType: 'plugin.installed', detail: `Installed plugin "${opts.name}"` });
    eventBus.emit('plugin.installed', { name: opts.name });
  }

  async cleanup(keep: string[]): Promise<any> {
    const node = getNodeClient();
    const result = await node.cleanupPlugins(keep);
    if ((result as any).removed?.length) {
      logActivity({
        eventType: 'plugin.cleanup',
        detail: `Removed ${(result as any).removedCount} unused plugins`,
      });
    }
    return result;
  }

  // ── Batch Rollout ───────────────────────────────────────────────

  batchRollout(pluginIds: string[]): string {
    const plugins = pluginIds
      .map((id) => pluginLibraryRepo.get(id))
      .filter((p): p is LibraryPlugin => p !== null);

    if (plugins.length === 0) throw Object.assign(new Error('No valid plugins found'), { status: 404 });

    // Determine affected instances
    const allInstances = instancesRepo.getAll();
    const affectedInstanceIds = new Set<string>();

    for (const plugin of plugins) {
      if (plugin.system) {
        for (const inst of allInstances) affectedInstanceIds.add((inst as any).id);
      } else {
        const allTemplates = templatesRepo.getAll();
        const affectedTemplates = allTemplates.filter((t) =>
          (t.pluginsList || []).some((p: { name: string }) => p.name === plugin.name),
        );
        const affectedTemplateIds = new Set(affectedTemplates.map((t) => t.id));
        const allAgents = agentsRepo.getAll();
        for (const a of allAgents) {
          if (a.templateId && affectedTemplateIds.has(a.templateId) && a.status !== 'stopped' && a.instanceId) {
            affectedInstanceIds.add(a.instanceId);
          }
        }
      }
    }

    const affectedInstances = allInstances.filter((i: any) => affectedInstanceIds.has(i.id));
    const pluginNames = plugins.map((p) => p.name);
    const instanceNames = affectedInstances.map((i: any) => i.name);

    const opId = operationManager.create('plugin.batch_rollout', {
      plugins: pluginNames,
      instances: instanceNames,
    });

    logActivity({
      eventType: 'plugin.batch_rollout.started',
      detail: `Batch rollout of ${pluginNames.length} plugin(s) — ${affectedInstances.length} instance(s) affected`,
    });
    dispatchWebhook('plugin.batch_rollout.started', { plugins: pluginNames, instances: instanceNames });

    // Fire and forget — tracked by operation
    this.runBatchRollout(opId, plugins, affectedInstances).catch(() => {});

    return opId;
  }

  private async runBatchRollout(opId: string, plugins: LibraryPlugin[], affectedInstances: any[]): Promise<void> {
    const node = getNodeClient();
    const pluginNames = plugins.map((p) => p.name);

    try {
      // Backup all
      for (const plugin of plugins) {
        operationManager.emit(opId, { step: 'backup', plugin: plugin.name, status: 'in_progress' });
        await node.backupPlugin(plugin.name);
        operationManager.emit(opId, { step: 'backup', plugin: plugin.name, status: 'done' });
      }

      // Install all
      for (const plugin of plugins) {
        operationManager.emit(opId, { step: 'install', plugin: plugin.name, status: 'in_progress' });
        await node.installPlugin({
          name: plugin.name,
          npmPkg: plugin.npmPkg ?? undefined,
          source: plugin.source || 'github',
          url: plugin.url ?? undefined,
          version: plugin.version ?? undefined,
        });
        operationManager.emit(opId, { step: 'install', plugin: plugin.name, status: 'done' });
      }

      // Restart each instance ONCE
      const restartedInstances: string[] = [];
      for (const instance of affectedInstances) {
        operationManager.emit(opId, { step: 'restart', instance: instance.name, status: 'restarting' });
        try {
          await instanceManager.restart(instance.id);
          const healthy = await instanceManager.waitForHealthy(instance.id, 60_000);
          if (!healthy) throw new Error(`Instance "${instance.name}" did not become healthy within 60s`);
          restartedInstances.push(instance.name);
          operationManager.emit(opId, { step: 'restart', instance: instance.name, status: 'healthy' });
        } catch (err: any) {
          // Rollback
          operationManager.emit(opId, { step: 'rollback', failedInstance: instance.name, reason: err.message });
          for (const plugin of plugins) {
            await node.restorePlugin(plugin.name).catch(() => {});
          }
          for (const name of restartedInstances) {
            const inst = affectedInstances.find((i: any) => i.name === name);
            if (inst) await instanceManager.restart(inst.id).catch(() => {});
          }
          throw err;
        }
      }

      // Cleanup backups
      for (const plugin of plugins) {
        await node.deletePluginBackup(plugin.name).catch(() => {});
      }

      logActivity({
        eventType: 'plugin.batch_rollout.completed',
        detail: `Rolled out ${pluginNames.join(', ')} to ${restartedInstances.join(', ')}`,
      });
      dispatchWebhook('plugin.batch_rollout.completed', { plugins: pluginNames, instances: restartedInstances });
      operationManager.complete(opId, { plugins: pluginNames, instances: restartedInstances });
    } catch (err: any) {
      logActivity({
        eventType: 'plugin.batch_rollout.failed',
        detail: `Batch rollout failed: ${err.message}`,
      });
      dispatchWebhook('plugin.batch_rollout.failed', { plugins: pluginNames, reason: err.message });
      operationManager.fail(opId, err.message);
    }
  }

  // ── Seed ────────────────────────────────────────────────────────

  seed(): void {
    const existing = pluginLibraryRepo.getAll();
    const existingNames = new Set(existing.map((p) => p.name));

    // One-time cleanup: armada-shared is a library, not a plugin
    const sharedEntry = existing.find((p) => p.name === 'armada-shared');
    if (sharedEntry) {
      pluginLibraryRepo.delete(sharedEntry.id);
      console.log('[plugin-seed] Removed armada-shared (library, not a plugin)');
    }

    for (const plugin of [...SYSTEM_PLUGINS, ...DEFAULT_PLUGINS]) {
      if (!existingNames.has(plugin.name)) {
        pluginLibraryRepo.create({
          name: plugin.name,
          npmPkg: (plugin as any).npmPkg,
          description: plugin.description,
          source: (plugin as any).source || 'workspace',
          system: plugin.system,
        });
        console.log(`[plugin-seed] Seeded ${plugin.system ? 'system' : 'default'} plugin: ${plugin.name}`);
      }
    }

    // Ensure wake-after has correct npmPkg and source
    const wakeAfter = pluginLibraryRepo.getByName('openclaw-wake-after');
    if (wakeAfter && !wakeAfter.npmPkg) {
      pluginLibraryRepo.update(wakeAfter.id, { npmPkg: '@coderage-labs/openclaw-wake-after', source: 'npm' });
      console.log('[plugin-seed] Set npmPkg for openclaw-wake-after');
    }

    // Ensure existing system plugins have the system flag set
    for (const sp of SYSTEM_PLUGINS) {
      const entry = pluginLibraryRepo.getByName(sp.name);
      if (entry && !entry.system) {
        pluginLibraryRepo.update(entry.id, { system: true });
        console.log(`[plugin-seed] Marked ${sp.name} as system plugin`);
      }
    }
  }
}

// ── Singleton export ────────────────────────────────────────────────

export const pluginManager = new PluginManagerImpl();

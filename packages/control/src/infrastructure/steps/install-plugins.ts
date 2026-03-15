import type { StepHandler } from '../step-registry.js';
import type { PluginEntry } from '@coderage-labs/armada-shared';
import { withRetry } from './retry.js';

export const installPluginsHandler: StepHandler = {
  name: 'install_plugins',
  async execute(ctx) {
    const { nodeId, containerName, pluginsDir, plugins = [] } = ctx.params as {
      nodeId: string;
      containerName: string;
      pluginsDir?: string;
      plugins: Array<PluginEntry & { name: string; npmPkg?: string; source?: string; url?: string; version?: string }>;
    };
    const node = ctx.services.nodeClient(nodeId);
    ctx.emit(`Installing ${plugins.length} plugin(s) in ${containerName}`, { containerName, count: plugins.length, pluginsDir });

    let installedPluginVersions = new Map<string, string>();
    try {
      const existing = await node.listPlugins(pluginsDir) as Array<{ name: string; version?: string }>;
      for (const p of existing) {
        installedPluginVersions.set(p.name, p.version ?? '0.0.0');
      }
    } catch (err: any) {
      console.warn('[install-plugins] listPlugins failed:', err.message);
    }

    const failures: string[] = [];

    for (const plugin of plugins) {
      const installedVersion = installedPluginVersions.get(plugin.name);
      if (installedVersion && (!plugin.version || installedVersion === plugin.version)) {
        ctx.emit(`Plugin already installed: ${plugin.name}@${installedVersion}`, { plugin: plugin.name });
        continue;
      }
      if (installedVersion && plugin.version) {
        ctx.emit(`Upgrading plugin: ${plugin.name} ${installedVersion} → ${plugin.version}`, { plugin: plugin.name });
      }
      try {
        ctx.emit(`Installing plugin: ${plugin.name}`, { plugin: plugin.name });
        await withRetry(
          () => node.installPlugin({
            name: plugin.name,
            npmPkg: plugin.npmPkg ?? undefined,
            source: plugin.source ?? 'github',
            url: plugin.url ?? undefined,
            version: plugin.version ?? undefined,
            directory: pluginsDir ?? undefined,
          }),
          {
            onRetry: (attempt, err) =>
              ctx.emit(`Plugin install retry ${attempt}: ${plugin.name} — ${err.message}`, {
                plugin: plugin.name,
                attempt,
                warning: err.message,
              }),
          },
        );
        ctx.emit(`Plugin installed: ${plugin.name}`, { plugin: plugin.name });
      } catch (err: any) {
        // Record failure but continue installing remaining plugins
        ctx.emit(`Plugin install FAILED: ${plugin.name} — ${err.message}`, { plugin: plugin.name, error: err.message });
        failures.push(`${plugin.name}: ${err.message}`);
      }
    }

    // Fail the step if any plugins couldn't be installed
    if (failures.length > 0) {
      throw new Error(`Failed to install ${failures.length} plugin(s): ${failures.join('; ')}`);
    }
  },
};

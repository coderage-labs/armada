import { eq, lt, sql } from 'drizzle-orm';
import { getDrizzle } from '../db/drizzle.js';
import {
  instances,
  modelProviders,
  providerApiKeys,
  modelRegistry,
  templates,
  plugins,
} from '../db/drizzle-schema.js';
import { settingsRepo } from '../repositories/settings-repo.js';

export interface StateChange {
  instanceId: string;
  type: 'config' | 'image' | 'plugin' | 'env' | 'model';
  field: string;
  current: any;
  desired: any;
  requiresRestart: boolean;
}

export interface ConfigSnapshot {
  version: number;
  providers: Array<{ id: string; type: string; keys: Array<{ name: string; isDefault: boolean }> }>;
  models: Array<{ id: string; name: string; modelId: string; providerId: string }>;
  plugins: Array<{ name: string; version?: string }>;
  templateModels: Record<string, string>; // templateId -> modelId
}

const SETTINGS_KEY = 'fleet_config_version';

export const configDiffService = {
  /** Get the current fleet config version */
  getCurrentVersion(): number {
    const raw = settingsRepo.get(SETTINGS_KEY);
    return raw ? parseInt(raw, 10) || 0 : 0;
  },

  /** Increment the fleet config version. Returns the new version number. */
  bumpVersion(): number {
    const current = this.getCurrentVersion();
    const next = current + 1;
    settingsRepo.set(SETTINGS_KEY, String(next));
    return next;
  },

  /** Take a snapshot of the current fleet config state */
  snapshot(): ConfigSnapshot {
    const db = getDrizzle();
    const version = this.getCurrentVersion();

    // Providers + their keys
    const providerRows = db.select().from(modelProviders).all();
    const keyRows = db.select().from(providerApiKeys).all();

    const keysByProvider: Record<string, Array<{ name: string; isDefault: boolean }>> = {};
    for (const key of keyRows) {
      if (!keysByProvider[key.providerId]) {
        keysByProvider[key.providerId] = [];
      }
      keysByProvider[key.providerId].push({
        name: key.name,
        isDefault: key.isDefault === 1,
      });
    }

    const providersSnapshot = providerRows.map(p => ({
      id: p.id,
      type: p.type,
      keys: keysByProvider[p.id] ?? [],
    }));

    // Models
    const modelRows = db.select().from(modelRegistry).all();
    const modelsSnapshot = modelRows.map(m => ({
      id: m.id,
      name: m.name,
      modelId: m.modelId,
      providerId: m.providerId ?? '',
    }));

    // Plugins
    const pluginRows = db.select().from(plugins).all();
    const pluginsSnapshot = pluginRows.map(p => ({
      name: p.name,
      version: p.version,
    }));

    // Template models
    const templateRows = db.select({ id: templates.id, model: templates.model }).from(templates).all();
    const templateModels: Record<string, string> = {};
    for (const t of templateRows) {
      if (t.model) {
        templateModels[t.id] = t.model;
      }
    }

    return { version, providers: providersSnapshot, models: modelsSnapshot, plugins: pluginsSnapshot, templateModels };
  },

  /** Compare two snapshots and return the differences */
  diff(current: ConfigSnapshot, desired: ConfigSnapshot): StateChange[] {
    const changes: StateChange[] = [];

    // ── Provider keys diff ──────────────────────────────────────────
    const currentProviders = new Map(current.providers.map(p => [p.id, p]));
    const desiredProviders = new Map(desired.providers.map(p => [p.id, p]));

    // Added providers
    for (const [id, dp] of desiredProviders) {
      if (!currentProviders.has(id)) {
        changes.push({
          instanceId: '',
          type: 'config',
          field: `provider.${id}`,
          current: null,
          desired: dp,
          requiresRestart: true,
        });
      }
    }

    // Removed providers
    for (const [id, cp] of currentProviders) {
      if (!desiredProviders.has(id)) {
        changes.push({
          instanceId: '',
          type: 'config',
          field: `provider.${id}`,
          current: cp,
          desired: null,
          requiresRestart: true,
        });
      }
    }

    // Changed keys within providers
    for (const [id, dp] of desiredProviders) {
      const cp = currentProviders.get(id);
      if (!cp) continue;
      const currentKeys = JSON.stringify(cp.keys.slice().sort((a, b) => a.name.localeCompare(b.name)));
      const desiredKeys = JSON.stringify(dp.keys.slice().sort((a, b) => a.name.localeCompare(b.name)));
      if (currentKeys !== desiredKeys) {
        changes.push({
          instanceId: '',
          type: 'config',
          field: `provider.${id}.keys`,
          current: cp.keys,
          desired: dp.keys,
          requiresRestart: true,
        });
      }
    }

    // ── Models diff ────────────────────────────────────────────────
    const currentModels = new Map(current.models.map(m => [m.id, m]));
    const desiredModels = new Map(desired.models.map(m => [m.id, m]));

    for (const [id, dm] of desiredModels) {
      const cm = currentModels.get(id);
      if (!cm) {
        changes.push({
          instanceId: '',
          type: 'model',
          field: `model.${id}`,
          current: null,
          desired: dm,
          requiresRestart: true,
        });
      } else if (cm.modelId !== dm.modelId || cm.name !== dm.name || cm.providerId !== dm.providerId) {
        changes.push({
          instanceId: '',
          type: 'model',
          field: `model.${id}`,
          current: cm,
          desired: dm,
          requiresRestart: true,
        });
      }
    }

    for (const [id, cm] of currentModels) {
      if (!desiredModels.has(id)) {
        changes.push({
          instanceId: '',
          type: 'model',
          field: `model.${id}`,
          current: cm,
          desired: null,
          requiresRestart: true,
        });
      }
    }

    // ── Plugins diff ───────────────────────────────────────────────
    const currentPlugins = new Map(current.plugins.map(p => [p.name, p]));
    const desiredPlugins = new Map(desired.plugins.map(p => [p.name, p]));

    for (const [name, dp] of desiredPlugins) {
      const cp = currentPlugins.get(name);
      if (!cp) {
        changes.push({
          instanceId: '',
          type: 'plugin',
          field: `plugin.${name}`,
          current: null,
          desired: dp,
          requiresRestart: true,
        });
      } else if (cp.version !== dp.version) {
        changes.push({
          instanceId: '',
          type: 'plugin',
          field: `plugin.${name}`,
          current: cp,
          desired: dp,
          requiresRestart: true,
        });
      }
    }

    for (const [name, cp] of currentPlugins) {
      if (!desiredPlugins.has(name)) {
        changes.push({
          instanceId: '',
          type: 'plugin',
          field: `plugin.${name}`,
          current: cp,
          desired: null,
          requiresRestart: true,
        });
      }
    }

    // ── Template models diff ───────────────────────────────────────
    const allTemplateIds = new Set([
      ...Object.keys(current.templateModels),
      ...Object.keys(desired.templateModels),
    ]);

    for (const templateId of allTemplateIds) {
      const cv = current.templateModels[templateId];
      const dv = desired.templateModels[templateId];
      if (cv !== dv) {
        changes.push({
          instanceId: '',
          type: 'config',
          field: `template.${templateId}.model`,
          current: cv ?? null,
          desired: dv ?? null,
          requiresRestart: true,
        });
      }
    }

    return changes;
  },

  /** Get all instances that are behind the current config version */
  getStaleInstances(): Array<{ instanceId: string; instanceName: string; appliedVersion: number; currentVersion: number }> {
    const currentVersion = this.getCurrentVersion();
    const db = getDrizzle();
    const rows = db.select({
      id: instances.id,
      name: instances.name,
      appliedConfigVersion: instances.appliedConfigVersion,
    }).from(instances).where(
      lt(instances.appliedConfigVersion, currentVersion),
    ).all();

    return rows.map(r => ({
      instanceId: r.id,
      instanceName: r.name,
      appliedVersion: r.appliedConfigVersion ?? 0,
      currentVersion,
    }));
  },

  /** Mark an instance as having applied the current config version */
  markApplied(instanceId: string, version: number): void {
    getDrizzle().update(instances)
      .set({ appliedConfigVersion: version })
      .where(eq(instances.id, instanceId))
      .run();
  },

};

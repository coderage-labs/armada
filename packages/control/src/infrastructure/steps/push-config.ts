// ── Push Config Step — generates and writes openclaw.json to instance ──
// params: { instanceId, configVersion, nodeId, containerName }

import type { StepHandler } from '../step-registry.js';
import { generateInstanceConfig } from '../../services/config-generator.js';
import { withRetry } from './retry.js';

export const pushConfigHandler: StepHandler = {
  name: 'push_config',
  async execute(ctx) {
    const { instanceId, configVersion, nodeId, containerName } = ctx.params;

    ctx.emit(`Generating config for instance ${instanceId} (version ${configVersion ?? 'current'})`, {
      instanceId,
      configVersion,
    });

    // Generate config from DB state
    const config = generateInstanceConfig(instanceId) as Record<string, any>;

    const instanceName = containerName.replace('armada-instance-', '');
    const configPath = `armada/instances/${instanceName}/openclaw.json`;
    const node = ctx.services.nodeClient(nodeId);

    // Preserve existing gateway auth token — OpenClaw generates one on first boot
    // and we don't want to wipe it on every config push
    try {
      const existingRaw = await node.readInstanceFile(instanceName, configPath);
      if (existingRaw) {
        const existing = JSON.parse(typeof existingRaw === 'string' ? existingRaw : (existingRaw as any).content ?? '{}');
        if (existing?.gateway?.auth?.token) {
          if (!config.gateway) config.gateway = {};
          if (!config.gateway.auth) config.gateway.auth = {};
          config.gateway.auth.token = existing.gateway.auth.token;
        }
      }
    } catch (err: any) {
      console.warn('[push-config] Failed to read existing config:', err.message);
    }

    ctx.emit(`Writing config to ${containerName}`, { instanceId, containerName });

    await withRetry(
      () => node.writeInstanceFile(instanceName, configPath, JSON.stringify(config, null, 2)),
      {
        onRetry: (attempt, err) =>
          ctx.emit(`Config write retry ${attempt}: ${err.message}`, { instanceId, containerName, attempt }),
      },
    );

    // Persist the auth token to the instance record so the control plane
    // can authenticate future API calls to this instance.
    const authToken = (config as any).gateway?.auth?.token as string | undefined;
    if (authToken) {
      ctx.services.instanceRepo.update(instanceId, { token: authToken });
    }

    ctx.emit(`Config pushed to ${containerName} (version ${configVersion ?? 'current'})`, {
      instanceId,
      containerName,
      configVersion,
    });
  },
};

// ── Step Handlers — register all built-in step handlers ──

import { stepRegistry } from '../step-registry.js';
import { pullImageHandler } from './pull-image.js';
import { createContainerHandler } from './create-container.js';
import { startContainerHandler } from './start-container.js';
import { stopContainerHandler } from './stop-container.js';
import { destroyContainerHandler } from './destroy-container.js';
import { healthCheckHandler } from './health-check.js';
import { restartGatewayHandler } from './restart-gateway.js';
import { installPluginsHandler } from './install-plugins.js';
import { pushConfigHandler } from './push-config.js';
import { drainNodeHandler } from './drain-node.js';
import { disconnectNodeHandler } from './disconnect-node.js';
import { cleanupNodeDbHandler } from './cleanup-node-db.js';
import { stopAgentsHandler } from './stop-agents.js';
import { cleanupInstanceDbHandler } from './cleanup-instance-db.js';
import { pushFilesHandler } from './push-files.js';
import { containerUpgradeHandler } from './container-upgrade.js';

export function registerBuiltInSteps(): void {
  stepRegistry.register(pullImageHandler);
  stepRegistry.register(createContainerHandler);
  stepRegistry.register(startContainerHandler);
  stepRegistry.register(stopContainerHandler);
  stepRegistry.register(destroyContainerHandler);
  stepRegistry.register(healthCheckHandler);
  stepRegistry.register(restartGatewayHandler);
  stepRegistry.register(installPluginsHandler);
  stepRegistry.register(pushConfigHandler);
  stepRegistry.register(pushFilesHandler);
  // Cascading removal steps
  stepRegistry.register(drainNodeHandler);
  stepRegistry.register(disconnectNodeHandler);
  stepRegistry.register(cleanupNodeDbHandler);
  stepRegistry.register(stopAgentsHandler);
  stepRegistry.register(cleanupInstanceDbHandler);
  stepRegistry.register(containerUpgradeHandler);
}

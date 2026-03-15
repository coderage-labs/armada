// ── Executor Singleton — wires up the operation executor with services ──

import { operationManager } from './operations.js';
import { stepRegistry } from './step-registry.js';
import { createOperationExecutor } from './operation-executor.js';
import { getNodeClient } from './node-client.js';
import { instancesRepo, agentsRepo, nodesRepo } from '../repositories/index.js';
import { eventBus } from './event-bus.js';
import { registerBuiltInSteps } from './steps/index.js';

// Register all built-in step handlers
registerBuiltInSteps();

export const operationExecutor = createOperationExecutor(
  operationManager,
  stepRegistry,
  {
    nodeClient: (nodeId?: string) => getNodeClient(nodeId),
    instanceRepo: instancesRepo,
    agentsRepo,
    nodesRepo,
    eventBus,
  },
);

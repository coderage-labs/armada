// ── Step Registry — maps step names to executable handlers ──

import type { WsNodeClient } from './ws-node-client.js';
import type { instancesRepo, agentsRepo, nodesRepo } from '../repositories/index.js';
import type { EventBus } from './event-bus.js';

// ── Types ────────────────────────────────────────────────────────────

export interface StepContext {
  operationId: string;
  stepId: string;
  params: Record<string, any>;
  emit: (message: string, data?: Record<string, any>) => void;
  services: {
    nodeClient: (nodeId?: string) => WsNodeClient;
    instanceRepo: typeof instancesRepo;
    agentsRepo: typeof agentsRepo;
    nodesRepo: typeof nodesRepo;
    eventBus: EventBus;
  };
}

export interface StepHandler {
  name: string;
  execute(ctx: StepContext): Promise<void>;
  rollback?(ctx: StepContext): Promise<void>;
}

export interface StepRegistry {
  register(handler: StepHandler): void;
  get(name: string): StepHandler | undefined;
  has(name: string): boolean;
}

// ── Implementation ───────────────────────────────────────────────────

export function createStepRegistry(): StepRegistry {
  const handlers = new Map<string, StepHandler>();

  function register(handler: StepHandler): void {
    handlers.set(handler.name, handler);
  }

  function get(name: string): StepHandler | undefined {
    return handlers.get(name);
  }

  function has(name: string): boolean {
    return handlers.has(name);
  }

  return { register, get, has };
}

/** Singleton step registry */
export const stepRegistry = createStepRegistry();

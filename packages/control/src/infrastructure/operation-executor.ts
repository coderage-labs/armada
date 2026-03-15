// ── Operation Executor — runs an operation's steps using p-graph DAG ──

import type { OperationStep } from '@coderage-labs/armada-shared';
import type { OperationManager } from './operations.js';
import type { StepRegistry, StepContext } from './step-registry.js';
import { lockManager } from './lock-manager.js';
import { PGraph } from 'p-graph';

// ── Types ────────────────────────────────────────────────────────────

export interface OperationExecutor {
  /**
   * Execute an operation's steps sequentially.
   * Call this after creating an operation with operationManager.create().
   */
  execute(operationId: string): Promise<void>;

  /**
   * Request cancellation of a running operation.
   * The current step will finish; remaining steps are skipped.
   */
  cancel(operationId: string): Promise<void>;
}

// ── Implementation ───────────────────────────────────────────────────

export function createOperationExecutor(
  manager: OperationManager,
  registry: StepRegistry,
  services: StepContext['services'],
): OperationExecutor {
  // Track cancellation requests
  const cancelRequests = new Set<string>();

  async function execute(operationId: string): Promise<void> {
    const op = manager.get(operationId);
    if (!op) throw new Error(`Operation "${operationId}" not found`);

    // ── Acquire lock if operation targets a specific resource ────────
    if (op.targetType && op.targetId) {
      const acquired = lockManager.acquire(op.targetType, op.targetId, operationId);
      if (!acquired) {
        manager.fail(operationId, `Target is locked by another operation`);
        return;
      }
    }
    // Acquire global lock if this is a fleet-level operation
    if (op.targetType === 'global') {
      const acquired = lockManager.acquire('global', 'fleet', operationId);
      if (!acquired) {
        manager.fail(operationId, `Target is locked by another operation`);
        return;
      }
    }

    try {
    // Mark as running
    manager.setRunning(operationId);
    manager.emit(operationId, { step: 'start', message: `Starting operation ${op.type}` });

    const steps: OperationStep[] = op.steps ?? [];
    
    // Read deps from DB — single source of truth (written at plan/approve time by step-planner)
    const deps: [string, string][] = op.stepDeps ?? [];

    const nodes: Record<string, { step: OperationStep }> = {};
    for (const step of steps) {
      nodes[step.id] = { step };
    }

    const dag = deps.length > 0 ? { nodes, deps } : null;

    // Track step status by ID
    const stepStatusById = new Map<string, OperationStep>();
    for (const step of steps) {
      stepStatusById.set(step.id, { ...step });
    }

    // Helper to update step status and sync to manager
    const updateStepStatus = (stepId: string, updates: Partial<OperationStep>) => {
      const current = stepStatusById.get(stepId);
      if (!current) return;
      const updated = { ...current, ...updates };
      stepStatusById.set(stepId, updated);
      manager.updateSteps(operationId, Array.from(stepStatusById.values()));
    };

    // If we have a DAG, execute with p-graph; otherwise fall back to sequential execution
    if (dag && dag.deps.length > 0) {
      // ── DAG execution with p-graph ──────────────────────────────
      const pgraphNodes: Record<string, { run: () => Promise<void> }> = {};

      for (const [stepId, node] of Object.entries(dag.nodes)) {
        const step = node.step;
        pgraphNodes[stepId] = {
          run: async () => {
            // Check for cancellation
            if (cancelRequests.has(operationId)) {
              updateStepStatus(stepId, { status: 'skipped' });
              throw new Error('[CANCELLED]');
            }

            const handler = registry.get(step.name);
            if (!handler) {
              const errMsg = `Unknown step handler: ${step.name}`;
              updateStepStatus(stepId, { 
                status: 'failed', 
                error: errMsg, 
                completedAt: new Date().toISOString() 
              });
              throw new Error(errMsg);
            }

            // Mark step as running
            updateStepStatus(stepId, { 
              status: 'running', 
              startedAt: new Date().toISOString() 
            });

            const ctx: StepContext = {
              operationId,
              stepId: step.id,
              params: step.metadata ?? {},
              emit: (message, data) => {
                manager.emit(operationId, { step: step.name, message, ...data });
              },
              services,
            };

            try {
              await handler.execute(ctx);
              updateStepStatus(stepId, { 
                status: 'completed', 
                completedAt: new Date().toISOString() 
              });
            } catch (err: any) {
              const errMsg = err?.message ?? String(err);
              updateStepStatus(stepId, { 
                status: 'failed', 
                completedAt: new Date().toISOString(), 
                error: errMsg 
              });

              // Cleanup: revert instance status on bootstrap failure
              const instId = step.metadata?.instanceId;
              if (instId) {
                try {
                  const inst = services.instanceRepo?.getById?.(instId);
                  if (inst && (inst.status === 'provisioning' || inst.status === 'pending')) {
                    services.instanceRepo.update(instId, {
                      status: 'error',
                      statusMessage: `Step "${step.name}" failed: ${errMsg}`,
                    });
                  }
                } catch (e: any) { 
                  console.warn('[operation-executor] best-effort status update failed:', e.message); 
                }
              }

              throw err;
            }
          },
        };
      }

      try {
        const graph = new PGraph(pgraphNodes, dag.deps);
        await graph.run({ concurrency: 3 });

        // All steps completed
        if (cancelRequests.has(operationId)) {
          manager.cancel(operationId);
          cancelRequests.delete(operationId);
          return;
        }

        manager.complete(operationId);
      } catch (err: any) {
        const errMsg = err?.message ?? String(err);
        
        // If cancelled, mark all pending steps as skipped
        if (errMsg.includes('[CANCELLED]') || cancelRequests.has(operationId)) {
          for (const [stepId, step] of stepStatusById) {
            if (step.status === 'pending') {
              updateStepStatus(stepId, { status: 'skipped' });
            }
          }
          manager.cancel(operationId);
          cancelRequests.delete(operationId);
          return;
        }

        // Mark all pending steps as skipped on failure
        for (const [stepId, step] of stepStatusById) {
          if (step.status === 'pending') {
            updateStepStatus(stepId, { status: 'skipped' });
          }
        }

        manager.fail(operationId, errMsg);
      }
    } else {
      // ── Fallback: sequential execution (for ops without DAG) ──────
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];

        // Check for cancellation before each step
        if (cancelRequests.has(operationId)) {
          // Mark this and all remaining steps as skipped
          const updated = steps.map((s, idx) => {
            if (idx >= i) {
              return { ...s, status: 'skipped' as const };
            }
            return s;
          });
          manager.updateSteps(operationId, updated);
          manager.cancel(operationId);
          cancelRequests.delete(operationId);
          return;
        }

        const handler = registry.get(step.name);
        if (!handler) {
          // Unknown step — fail the operation
          const now = new Date().toISOString();
          const updated = steps.map((s, idx) => {
            if (idx === i) return { ...s, status: 'failed' as const, error: `Unknown step handler: ${step.name}`, completedAt: now };
            if (idx > i) return { ...s, status: 'skipped' as const };
            return s;
          });
          manager.updateSteps(operationId, updated);
          manager.fail(operationId, `Unknown step handler: ${step.name}`);
          return;
        }

        // Mark step as running
        const startedAt = new Date().toISOString();
        steps[i] = { ...step, status: 'running', startedAt };
        manager.updateSteps(operationId, [...steps]);

        const params = step.metadata ?? {};

        const ctx: StepContext = {
          operationId,
          stepId: step.id,
          params,
          emit: (message, data) => {
            manager.emit(operationId, { step: step.name, message, ...data });
          },
          services,
        };

        try {
          await handler.execute(ctx);
          // Mark step as completed
          const completedAt = new Date().toISOString();
          steps[i] = { ...steps[i], status: 'completed', completedAt };
          manager.updateSteps(operationId, [...steps]);
        } catch (err: any) {
          const completedAt = new Date().toISOString();
          const errMsg = err?.message ?? String(err);
          // Mark step as failed
          steps[i] = { ...steps[i], status: 'failed', completedAt, error: errMsg };
          // Mark remaining steps as skipped
          for (let j = i + 1; j < steps.length; j++) {
            steps[j] = { ...steps[j], status: 'skipped' };
          }
          manager.updateSteps(operationId, [...steps]);
          manager.fail(operationId, `Step "${step.name}" failed: ${errMsg}`);

          // Cleanup: revert instance status on bootstrap failure
          const instId = step.metadata?.instanceId;
          if (instId) {
            try {
              const inst = services.instanceRepo?.getById?.(instId);
              if (inst && (inst.status === 'provisioning' || inst.status === 'pending')) {
                services.instanceRepo.update(instId, {
                  status: 'error',
                  statusMessage: `Step "${step.name}" failed: ${errMsg}`,
                });
              }
            } catch (err: any) { console.warn('[operation-executor] best-effort status update failed:', err.message); }
          }
          return;
        }
      }

      // All steps completed — check one final time for cancellation
      if (cancelRequests.has(operationId)) {
        manager.cancel(operationId);
        cancelRequests.delete(operationId);
        return;
      }

      manager.complete(operationId);
    }
    } finally {
      // Always release all locks held by this operation
      lockManager.releaseAll(operationId);
    }
  }

  async function cancel(operationId: string): Promise<void> {
    cancelRequests.add(operationId);
  }

  return { execute, cancel };
}

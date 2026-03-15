// ── Operations Manager — tracks long-running operations with SQLite persistence ──

import crypto from 'node:crypto';
import { eq, desc, inArray } from 'drizzle-orm';
import { getDrizzle } from '../db/drizzle.js';
import { operations } from '../db/drizzle-schema.js';
import { eventBus } from './event-bus.js';
import type { OperationStep, OperationEvent } from '@coderage-labs/armada-shared';

export type { OperationStep, OperationEvent };

export interface Operation {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  targetType?: string;
  targetId?: string;
  target: any;
  steps: OperationStep[];
  /** Step dependency edges: [prerequisiteStepId, dependentStepId][] */
  stepDeps: [string, string][];
  priority: string;
  createdBy?: string;
  error?: string;
  startedAt: string;
  completedAt: string | null;
  events: OperationEvent[];
  result: any | null;
}

export interface OperationCreateOpts {
  steps?: OperationStep[];
  /** Step dependency edges: [prerequisiteStepId, dependentStepId][] */
  stepDeps?: [string, string][];
  targetType?: string;
  targetId?: string;
  priority?: string;
  createdBy?: string;
}

export interface OperationManager {
  create(type: string, target: any, opts?: OperationCreateOpts): string;
  emit(opId: string, event: Omit<OperationEvent, 'timestamp'>): void;
  complete(opId: string, result?: any): void;
  fail(opId: string, error: string): void;
  get(opId: string): Operation | null;
  getActive(): Operation[];
  getRecent(limit?: number): Operation[];
  setRunning(opId: string): void;
  updateSteps(opId: string, steps: OperationStep[]): void;
  cancel(opId: string): void;
}

type OperationRow = typeof operations.$inferSelect;

function rowToOperation(row: OperationRow): Operation {
  return {
    id: row.id,
    type: row.type,
    status: row.status as Operation['status'],
    targetType: row.targetType ?? undefined,
    targetId: row.targetId ?? undefined,
    target: row.targetJson ? JSON.parse(row.targetJson) : null,
    steps: JSON.parse(row.stepsJson || '[]'),
    stepDeps: JSON.parse((row as any).stepDepsJson || '[]'),
    priority: row.priority ?? 'normal',
    createdBy: row.createdBy ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? null,
    events: JSON.parse(row.eventsJson || '[]'),
    result: row.resultJson ? JSON.parse(row.resultJson) : null,
  };
}

export function createOperationManager(): OperationManager {
  function create(type: string, target: any, opts?: OperationCreateOpts): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const steps = opts?.steps ?? [];
    const stepDeps = opts?.stepDeps ?? [];
    getDrizzle().insert(operations).values({
      id,
      type,
      status: 'pending',
      targetType: opts?.targetType ?? null,
      targetId: opts?.targetId ?? null,
      targetJson: JSON.stringify(target),
      stepsJson: JSON.stringify(steps),
      stepDepsJson: JSON.stringify(stepDeps),
      priority: opts?.priority ?? 'normal',
      createdBy: opts?.createdBy ?? null,
      startedAt: now,
      eventsJson: '[]',
    }).run();

    eventBus.emit('operation.created', { operationId: id, type, target });
    return id;
  }

  function emit(opId: string, event: Omit<OperationEvent, 'timestamp'>): void {
    const row = getDrizzle().select({ eventsJson: operations.eventsJson }).from(operations).where(eq(operations.id, opId)).get();
    if (!row) return;

    const events: OperationEvent[] = JSON.parse(row.eventsJson || '[]');
    const fullEvent = { ...event, timestamp: Date.now() } as OperationEvent;
    events.push(fullEvent);

    getDrizzle().update(operations).set({ eventsJson: JSON.stringify(events) }).where(eq(operations.id, opId)).run();
    eventBus.emit('operation.progress', { operationId: opId, ...fullEvent });
  }

  function complete(opId: string, result?: any): void {
    const now = new Date().toISOString();
    getDrizzle().update(operations).set({
      status: 'completed',
      completedAt: now,
      resultJson: result !== undefined ? JSON.stringify(result) : null,
    }).where(eq(operations.id, opId)).run();

    eventBus.emit('operation.completed', { operationId: opId, result: result ?? null });
  }

  function fail(opId: string, error: string): void {
    const now = new Date().toISOString();
    getDrizzle().update(operations).set({
      status: 'failed',
      completedAt: now,
      error,
      resultJson: JSON.stringify({ error }),
    }).where(eq(operations.id, opId)).run();

    eventBus.emit('operation.failed', { operationId: opId, error });
  }

  function get(opId: string): Operation | null {
    const row = getDrizzle().select().from(operations).where(eq(operations.id, opId)).get();
    return row ? rowToOperation(row) : null;
  }

  function getActive(): Operation[] {
    const rows = getDrizzle().select().from(operations)
      .where(inArray(operations.status, ['pending', 'running']))
      .orderBy(desc(operations.startedAt))
      .all();
    return rows.map(rowToOperation);
  }

  function getRecent(limit = 20): Operation[] {
    const rows = getDrizzle().select().from(operations)
      .orderBy(desc(operations.startedAt))
      .limit(limit)
      .all();
    return rows.map(rowToOperation);
  }

  function setRunning(opId: string): void {
    getDrizzle().update(operations)
      .set({ status: 'running' })
      .where(eq(operations.id, opId))
      .run();
    eventBus.emit('operation.running', { operationId: opId });
  }

  function updateSteps(opId: string, steps: OperationStep[]): void {
    getDrizzle().update(operations)
      .set({ stepsJson: JSON.stringify(steps) })
      .where(eq(operations.id, opId))
      .run();
    eventBus.emit('operation.steps_updated', { operationId: opId, steps });
  }

  function cancel(opId: string): void {
    const now = new Date().toISOString();
    getDrizzle().update(operations).set({
      status: 'cancelled',
      completedAt: now,
    }).where(eq(operations.id, opId)).run();
    eventBus.emit('operation.cancelled', { operationId: opId });
  }

  return { create, emit, complete, fail, get, getActive, getRecent, setRunning, updateSteps, cancel };
}

/** Singleton operation manager */
export const operationManager = createOperationManager();

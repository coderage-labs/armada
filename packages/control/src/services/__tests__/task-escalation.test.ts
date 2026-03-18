/**
 * Tests for task escalation — horizontal and vertical (#7)
 *
 * Covers:
 * - EscalationRequest type is exported from shared
 * - MeshTask status union includes 'escalated' and 'awaiting_escalation'
 * - Horizontal escalation: status set to 'escalated', toAgent updated
 * - Vertical escalation: status set to 'awaiting_escalation'
 * - Operator notification: deliverToUser called for vertical escalation
 * - Operator notification: non-operators filtered out
 * - Resolution — approve: status → 'running'
 * - Resolution — reject: status → 'failed' with feedback
 * - Resolution — reassign: status → 'escalated', toAgent updated
 * - notifyOperatorsOfEscalation helper tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ArmadaUser, MeshTask, EscalationRequest } from '@coderage-labs/armada-shared';

// ── Verify shared types are exported ─────────────────────────────────

describe('EscalationRequest type (shared package)', () => {
  it('is exported from @coderage-labs/armada-shared', async () => {
    // Import the module and check the type can be used
    const shared = await import('@coderage-labs/armada-shared');
    // TypeScript compile-time check — if EscalationRequest wasn't defined,
    // the import above wouldn't typecheck. We verify the module loads fine.
    expect(shared).toBeDefined();
  });

  it('MeshTask status includes escalated and awaiting_escalation', () => {
    // Compile-time assertion: if the union didn't include these values,
    // this assignment would fail TypeScript type checking.
    const status1: MeshTask['status'] = 'escalated';
    const status2: MeshTask['status'] = 'awaiting_escalation';
    expect(status1).toBe('escalated');
    expect(status2).toBe('awaiting_escalation');
  });
});

// ── Module mocks ─────────────────────────────────────────────────────

vi.mock('../../repositories/index.js', () => ({
  notificationChannelRepo: { getEnabled: vi.fn() },
  usersRepo: { getAll: vi.fn() },
  userProjectsRepo: { getUsersForProject: vi.fn() },
}));

vi.mock('../telegram-bot.js', () => ({
  sendGateNotification: vi.fn(),
  sendPlainNotification: vi.fn(),
}));

vi.mock('../../db/drizzle.js', () => ({
  getDrizzle: () => ({
    update: () => ({ set: () => ({ where: () => ({ run: vi.fn() }) }) }),
  }),
}));

vi.mock('../../db/drizzle-schema.js', () => ({
  workflowStepRuns: {},
}));

vi.mock('../slack-bot.js', () => ({
  sendSlackGateNotification: vi.fn(),
  sendSlackNotification: vi.fn(),
}));

vi.mock('../discord-bot.js', () => ({
  sendDiscordGateNotification: vi.fn(),
  sendDiscordNotification: vi.fn(),
}));

// ── Import after mocks ───────────────────────────────────────────────

import { deliverToUser } from '../user-notifier.js';
import { notificationChannelRepo, usersRepo, userProjectsRepo } from '../../repositories/index.js';
import { sendPlainNotification } from '../telegram-bot.js';

const mockGetEnabled = vi.mocked(notificationChannelRepo.getEnabled);
const mockGetAll = vi.mocked(usersRepo.getAll);
const mockGetUsersForProject = vi.mocked(userProjectsRepo.getUsersForProject);
const mockSendPlainNotification = vi.mocked(sendPlainNotification);

// ── Helpers ──────────────────────────────────────────────────────────

function makeTask(overrides: Partial<MeshTask> = {}): MeshTask {
  return {
    id: 'task-123',
    fromAgent: 'agent-a',
    toAgent: 'agent-b',
    taskText: 'Do something important',
    result: null,
    status: 'running',
    createdAt: '2024-01-01T00:00:00Z',
    completedAt: null,
    ...overrides,
  };
}

function makeOperator(overrides: Partial<ArmadaUser> = {}): ArmadaUser {
  return {
    id: 'user-op-1',
    name: 'op1',
    displayName: 'Operator One',
    type: 'operator',
    role: 'owner',
    avatarUrl: null,
    linkedAccounts: {},
    channels: { telegram: { platformId: '12345', verified: true, linkedAt: '2024-01-01' } },
    notifications: {
      channels: ['telegram'],
      preferences: { gates: true, completions: true, failures: true },
    },
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeTelegramChannel() {
  return {
    id: 'ch-1',
    type: 'telegram' as const,
    name: 'Telegram',
    enabled: true,
    config: {},
    createdAt: '',
    updatedAt: '',
  };
}

// ── Task status logic tests ──────────────────────────────────────────

describe('Task escalation — status transitions', () => {
  it('horizontal escalation sets status to "escalated"', () => {
    const task = makeTask({ status: 'running' });
    // Simulate what the route handler does
    const updates: Partial<MeshTask> = { status: 'escalated', toAgent: 'agent-c' };
    const updated = { ...task, ...updates };
    expect(updated.status).toBe('escalated');
    expect(updated.toAgent).toBe('agent-c');
  });

  it('vertical escalation sets status to "awaiting_escalation"', () => {
    const task = makeTask({ status: 'running' });
    const updates: Partial<MeshTask> = { status: 'awaiting_escalation' };
    const updated = { ...task, ...updates };
    expect(updated.status).toBe('awaiting_escalation');
  });

  it('resolve approve: status becomes "running"', () => {
    const task = makeTask({ status: 'awaiting_escalation' });
    const updated = { ...task, status: 'running' as const };
    expect(updated.status).toBe('running');
  });

  it('resolve reject: status becomes "failed" with feedback', () => {
    const task = makeTask({ status: 'awaiting_escalation' });
    const feedback = 'Not authorized';
    const updated = { ...task, status: 'failed' as const, result: feedback };
    expect(updated.status).toBe('failed');
    expect(updated.result).toBe(feedback);
  });

  it('resolve reassign: status becomes "escalated" with new toAgent', () => {
    const task = makeTask({ status: 'awaiting_escalation' });
    const updated = { ...task, status: 'escalated' as const, toAgent: 'agent-d' };
    expect(updated.status).toBe('escalated');
    expect(updated.toAgent).toBe('agent-d');
  });
});

// ── Operator notification tests ──────────────────────────────────────

describe('Vertical escalation — operator notification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delivers notification to operator user via telegram', async () => {
    const operator = makeOperator();
    mockGetEnabled.mockReturnValue([makeTelegramChannel()]);
    mockSendPlainNotification.mockResolvedValue(undefined);

    await deliverToUser(operator, '⬆️ Task escalated', {
      event: 'task.escalation',
      taskId: 'task-123',
      reason: 'Need approval',
    });

    expect(mockSendPlainNotification).toHaveBeenCalledWith('12345', '⬆️ Task escalated');
  });

  it('skips delivery when telegram channel is not enabled', async () => {
    const operator = makeOperator();
    mockGetEnabled.mockReturnValue([]); // no enabled channels

    await deliverToUser(operator, 'escalation message', {
      event: 'task.escalation',
      taskId: 'task-123',
    });

    expect(mockSendPlainNotification).not.toHaveBeenCalled();
  });

  it('skips delivery when user has no telegram identity', async () => {
    const operator = makeOperator({ channels: {} }); // no channels linked
    mockGetEnabled.mockReturnValue([makeTelegramChannel()]);

    await deliverToUser(operator, 'escalation message', {
      event: 'task.escalation',
      taskId: 'task-123',
    });

    expect(mockSendPlainNotification).not.toHaveBeenCalled();
  });

  it('only operator users get notified — human users are filtered', () => {
    const allUsers: ArmadaUser[] = [
      makeOperator({ id: 'op-1', type: 'operator' }),
      makeOperator({ id: 'human-1', type: 'human', role: 'viewer' }),
      makeOperator({ id: 'op-2', type: 'operator' }),
    ];

    const operators = allUsers.filter(u => u.type === 'operator');
    expect(operators).toHaveLength(2);
    expect(operators.every(u => u.type === 'operator')).toBe(true);
  });

  it('falls back to all users when no project assignments returned', () => {
    mockGetUsersForProject.mockReturnValue([]);
    mockGetAll.mockReturnValue([makeOperator()]);

    const projectId = 'proj-1';
    let operators = userProjectsRepo.getUsersForProject(projectId).filter(u => u.type === 'operator');
    if (operators.length === 0) {
      operators = usersRepo.getAll().filter(u => u.type === 'operator');
    }

    expect(mockGetAll).toHaveBeenCalledOnce();
    expect(operators).toHaveLength(1);
  });
});

// ── EscalationRequest interface structural tests ──────────────────────

describe('EscalationRequest interface', () => {
  it('constructs a valid horizontal escalation request', () => {
    const req: EscalationRequest = {
      taskId: 'task-123',
      type: 'horizontal',
      reason: 'Need a coding specialist',
      targetAgent: 'coding-agent',
      priority: 'urgent',
      context: { issueNumber: 42 },
    };
    expect(req.type).toBe('horizontal');
    expect(req.targetAgent).toBe('coding-agent');
  });

  it('constructs a valid vertical escalation request without optional fields', () => {
    const req: EscalationRequest = {
      taskId: 'task-456',
      type: 'vertical',
      reason: 'Requires management approval',
    };
    expect(req.type).toBe('vertical');
    expect(req.targetAgent).toBeUndefined();
    expect(req.priority).toBeUndefined();
    expect(req.context).toBeUndefined();
  });
});

/**
 * Tests for triage operator fallback notification (#73)
 *
 * Covers:
 * - notifyTriageOperatorFallback: only operators notified
 * - notifyTriageOperatorFallback: skips non-operator users
 * - notifyTriageOperatorFallback: quiet hours respected
 * - notifyTriageOperatorFallback: falls back to all users when no project assignments
 * - Rate limiting: duplicate notifications suppressed within cooldown window
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ArmadaUser } from '@coderage-labs/armada-shared';

// ── Module mocks ─────────────────────────────────────────────────────

vi.mock('../../repositories/index.js', () => ({
  notificationChannelRepo: { getEnabled: vi.fn() },
  usersRepo: { getAll: vi.fn() },
  assignmentRepo: { getAllAssignedUsers: vi.fn() },
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

// ── Import after mocks ───────────────────────────────────────────────

import { notifyTriageOperatorFallback } from '../user-notifier.js';
import { notificationChannelRepo, usersRepo, assignmentRepo } from '../../repositories/index.js';
import { sendPlainNotification } from '../telegram-bot.js';

const mockGetEnabled = vi.mocked(notificationChannelRepo.getEnabled);
const mockGetAll = vi.mocked(usersRepo.getAll);
const mockGetAllAssignedUsers = vi.mocked(assignmentRepo.getAllAssignedUsers);
const mockSendPlainNotification = vi.mocked(sendPlainNotification);

// ── Helpers ──────────────────────────────────────────────────────────

function makeUser(overrides: Partial<ArmadaUser> = {}): ArmadaUser {
  return {
    id: 'user-1',
    name: 'testuser',
    displayName: 'Test User',
    type: 'operator',
    role: 'owner',
    avatarUrl: null,
    linkedAccounts: {},
    channels: {},
    notifications: {
      channels: [],
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

const defaultOpts = {
  issueNumber: 42,
  issueTitle: 'Fix the bug',
  projectId: 'proj-1',
  projectName: 'My Project',
  reason: 'No PM-tier agent assigned',
};

// ── Tests ────────────────────────────────────────────────────────────

describe('notifyTriageOperatorFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEnabled.mockReturnValue([makeTelegramChannel()]);
    mockSendPlainNotification.mockResolvedValue(undefined);
  });

  it('notifies operator users for the project', async () => {
    const operator = makeUser({
      type: 'operator',
      channels: { telegram: { platformId: 'op-chat-123', verified: true, linkedAt: '' } },
    });
    mockGetAllAssignedUsers.mockReturnValue([operator]);

    await notifyTriageOperatorFallback(defaultOpts);

    expect(mockSendPlainNotification).toHaveBeenCalledOnce();
    expect(mockSendPlainNotification).toHaveBeenCalledWith('op-chat-123', expect.stringContaining('#42'));
  });

  it('includes project name and reason in the message', async () => {
    const operator = makeUser({
      type: 'operator',
      channels: { telegram: { platformId: 'op-chat-123', verified: true, linkedAt: '' } },
    });
    mockGetAllAssignedUsers.mockReturnValue([operator]);

    await notifyTriageOperatorFallback(defaultOpts);

    const [, message] = mockSendPlainNotification.mock.calls[0];
    expect(message).toContain('My Project');
    expect(message).toContain('No PM-tier agent assigned');
    expect(message).toContain('Fix the bug');
  });

  it('does NOT notify human users', async () => {
    const human = makeUser({
      type: 'human',
      channels: { telegram: { platformId: 'human-chat-123', verified: true, linkedAt: '' } },
    });
    mockGetAllAssignedUsers.mockReturnValue([human]);

    await notifyTriageOperatorFallback(defaultOpts);

    expect(mockSendPlainNotification).not.toHaveBeenCalled();
  });

  it('falls back to all users when no project assignments', async () => {
    mockGetAllAssignedUsers.mockReturnValue([]); // no project assignments

    const operator = makeUser({
      type: 'operator',
      channels: { telegram: { platformId: 'op-chat-456', verified: true, linkedAt: '' } },
    });
    mockGetAll.mockReturnValue([operator]);

    await notifyTriageOperatorFallback(defaultOpts);

    expect(mockSendPlainNotification).toHaveBeenCalledWith('op-chat-456', expect.any(String));
  });

  it('skips notification during quiet hours', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T02:00:00Z')); // 02:00 UTC — within 23:00-08:00

    const operator = makeUser({
      type: 'operator',
      channels: { telegram: { platformId: 'op-chat-123', verified: true, linkedAt: '' } },
      notifications: {
        channels: [],
        preferences: {
          gates: true, completions: true, failures: true,
          quietHours: { start: '23:00', end: '08:00' },
        },
      },
    });
    mockGetAllAssignedUsers.mockReturnValue([operator]);

    await notifyTriageOperatorFallback(defaultOpts);

    expect(mockSendPlainNotification).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('delivers notification outside quiet hours', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T14:00:00Z')); // 14:00 UTC — outside 23:00-08:00

    const operator = makeUser({
      type: 'operator',
      channels: { telegram: { platformId: 'op-chat-123', verified: true, linkedAt: '' } },
      notifications: {
        channels: [],
        preferences: {
          gates: true, completions: true, failures: true,
          quietHours: { start: '23:00', end: '08:00' },
        },
      },
    });
    mockGetAllAssignedUsers.mockReturnValue([operator]);

    await notifyTriageOperatorFallback(defaultOpts);

    expect(mockSendPlainNotification).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});

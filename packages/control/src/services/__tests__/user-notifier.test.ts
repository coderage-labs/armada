/**
 * Tests for user-notifier delivery hardening (#63)
 *
 * Covers:
 * - System channel checks: delivery skipped when channel not enabled
 * - User identity checks: delivery skipped when user has no linked identity
 * - Quiet hours: completion/failure skipped during quiet hours
 * - Quiet hours: gate always delivered (requires action)
 * - Overnight quiet hours range (23:00-08:00)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ArmadaUser } from '@coderage-labs/armada-shared';

// ── Module mocking ───────────────────────────────────────────────────
// NOTE: vi.mock factories are hoisted — do NOT reference outer variables inside them.
// Use vi.fn() directly; retrieve references via the mocked module after import.

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
    update: () => ({
      set: () => ({ where: () => ({ run: vi.fn() }) }),
    }),
  }),
}));

vi.mock('../../db/drizzle-schema.js', () => ({
  workflowStepRuns: {},
}));

// ── Import after mocks ───────────────────────────────────────────────

import { notifyGate, notifyCompletion, isInQuietHours } from '../user-notifier.js';
import { notificationChannelRepo, usersRepo, userProjectsRepo } from '../../repositories/index.js';
import { sendGateNotification, sendPlainNotification } from '../telegram-bot.js';

// Typed mock helpers
const mockGetEnabled = vi.mocked(notificationChannelRepo.getEnabled);
const mockGetAll = vi.mocked(usersRepo.getAll);
const mockGetUsersForProject = vi.mocked(userProjectsRepo.getUsersForProject);
const mockSendGateNotification = vi.mocked(sendGateNotification);
const mockSendPlainNotification = vi.mocked(sendPlainNotification);

// ── Helpers ──────────────────────────────────────────────────────────

function makeUser(overrides: Partial<ArmadaUser> = {}): ArmadaUser {
  return {
    id: 'user-1',
    name: 'testuser',
    displayName: 'Test User',
    type: 'human',
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

// ── isInQuietHours unit tests ────────────────────────────────────────

describe('isInQuietHours', () => {
  it('returns false when no quiet hours configured', () => {
    const user = makeUser();
    expect(isInQuietHours(user)).toBe(false);
  });

  it('returns false when quiet hours start/end are empty strings', () => {
    const user = makeUser({
      notifications: {
        channels: [],
        preferences: {
          gates: true, completions: true, failures: true,
          quietHours: { start: '', end: '' },
        },
      },
    });
    expect(isInQuietHours(user)).toBe(false);
  });

  it('returns true during daytime quiet hours (within range)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T14:30:00Z')); // 14:30 UTC

    const user = makeUser({
      notifications: {
        channels: [],
        preferences: {
          gates: true, completions: true, failures: true,
          quietHours: { start: '13:00', end: '17:00' },
        },
      },
    });
    expect(isInQuietHours(user)).toBe(true);
    vi.useRealTimers();
  });

  it('returns false outside daytime quiet hours', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T10:00:00Z')); // 10:00 UTC

    const user = makeUser({
      notifications: {
        channels: [],
        preferences: {
          gates: true, completions: true, failures: true,
          quietHours: { start: '13:00', end: '17:00' },
        },
      },
    });
    expect(isInQuietHours(user)).toBe(false);
    vi.useRealTimers();
  });

  it('returns true during overnight quiet hours (23:00-08:00) — past midnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T02:00:00Z')); // 02:00 UTC

    const user = makeUser({
      notifications: {
        channels: [],
        preferences: {
          gates: true, completions: true, failures: true,
          quietHours: { start: '23:00', end: '08:00' },
        },
      },
    });
    expect(isInQuietHours(user)).toBe(true);
    vi.useRealTimers();
  });

  it('returns true during overnight quiet hours (23:00-08:00) — before midnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T23:30:00Z')); // 23:30 UTC

    const user = makeUser({
      notifications: {
        channels: [],
        preferences: {
          gates: true, completions: true, failures: true,
          quietHours: { start: '23:00', end: '08:00' },
        },
      },
    });
    expect(isInQuietHours(user)).toBe(true);
    vi.useRealTimers();
  });

  it('returns false outside overnight quiet hours', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z')); // 12:00 UTC

    const user = makeUser({
      notifications: {
        channels: [],
        preferences: {
          gates: true, completions: true, failures: true,
          quietHours: { start: '23:00', end: '08:00' },
        },
      },
    });
    expect(isInQuietHours(user)).toBe(false);
    vi.useRealTimers();
  });
});

// ── Delivery: system channel checks ─────────────────────────────────

describe('deliverToUser — system channel checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUsersForProject.mockReturnValue([]);
  });

  it('skips Telegram delivery when system channel is not enabled', async () => {
    mockGetEnabled.mockReturnValue([]); // No enabled system channels

    const user = makeUser({
      channels: { telegram: { platformId: '12345', verified: true, linkedAt: '' } },
    });
    mockGetAll.mockReturnValue([user]);

    await notifyCompletion({
      workflowName: 'test-workflow',
      runId: 'run-1',
      status: 'completed',
      projectId: 'proj-1',
    });

    expect(mockSendPlainNotification).not.toHaveBeenCalled();
  });

  it('delivers Telegram when system channel is enabled and user is linked', async () => {
    mockGetEnabled.mockReturnValue([makeTelegramChannel()]);
    mockSendPlainNotification.mockResolvedValue(undefined);

    const user = makeUser({
      channels: { telegram: { platformId: '12345', verified: true, linkedAt: '' } },
    });
    mockGetAll.mockReturnValue([user]);

    await notifyCompletion({
      workflowName: 'test-workflow',
      runId: 'run-1',
      status: 'completed',
      projectId: 'proj-1',
    });

    expect(mockSendPlainNotification).toHaveBeenCalledWith('12345', expect.any(String));
  });

  it('skips Telegram delivery when user has no linked identity', async () => {
    mockGetEnabled.mockReturnValue([makeTelegramChannel()]); // System channel enabled...

    const user = makeUser({
      channels: {}, // ...but user has no linked telegram
      notifications: {
        channels: [],
        preferences: { gates: true, completions: true, failures: true },
        // No legacy telegram.chatId either
      },
    });
    mockGetAll.mockReturnValue([user]);

    await notifyCompletion({
      workflowName: 'test-workflow',
      runId: 'run-1',
      status: 'completed',
      projectId: 'proj-1',
    });

    expect(mockSendPlainNotification).not.toHaveBeenCalled();
  });

  it('falls back to legacy telegram.chatId when user.channels.telegram is absent', async () => {
    mockGetEnabled.mockReturnValue([makeTelegramChannel()]);
    mockSendPlainNotification.mockResolvedValue(undefined);

    const user = makeUser({
      channels: {},
      notifications: {
        channels: [],
        telegram: { chatId: 'legacy-chat-id' },
        preferences: { gates: true, completions: true, failures: true },
      },
    });
    mockGetAll.mockReturnValue([user]);

    await notifyCompletion({
      workflowName: 'test-workflow',
      runId: 'run-1',
      status: 'completed',
      projectId: 'proj-1',
    });

    expect(mockSendPlainNotification).toHaveBeenCalledWith('legacy-chat-id', expect.any(String));
  });
});

// ── Quiet hours: notifyCompletion ────────────────────────────────────

describe('notifyCompletion — quiet hours', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUsersForProject.mockReturnValue([]);
    mockGetEnabled.mockReturnValue([makeTelegramChannel()]);
    mockSendPlainNotification.mockResolvedValue(undefined);
  });

  it('skips completion notification during quiet hours', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T02:00:00Z')); // 02:00 UTC — within 23:00-08:00

    const user = makeUser({
      channels: { telegram: { platformId: '12345', verified: true, linkedAt: '' } },
      notifications: {
        channels: [],
        preferences: {
          gates: true, completions: true, failures: true,
          quietHours: { start: '23:00', end: '08:00' },
        },
      },
    });
    mockGetAll.mockReturnValue([user]);

    await notifyCompletion({
      workflowName: 'test-workflow',
      runId: 'run-1',
      status: 'completed',
      projectId: 'proj-1',
    });

    expect(mockSendPlainNotification).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('delivers completion notification outside quiet hours', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z')); // 12:00 UTC — outside 23:00-08:00

    const user = makeUser({
      channels: { telegram: { platformId: '12345', verified: true, linkedAt: '' } },
      notifications: {
        channels: [],
        preferences: {
          gates: true, completions: true, failures: true,
          quietHours: { start: '23:00', end: '08:00' },
        },
      },
    });
    mockGetAll.mockReturnValue([user]);

    await notifyCompletion({
      workflowName: 'test-workflow',
      runId: 'run-1',
      status: 'completed',
      projectId: 'proj-1',
    });

    expect(mockSendPlainNotification).toHaveBeenCalledWith('12345', expect.any(String));
    vi.useRealTimers();
  });
});

// ── Quiet hours: notifyGate ──────────────────────────────────────────

describe('notifyGate — quiet hours', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUsersForProject.mockReturnValue([]);
    mockGetEnabled.mockReturnValue([makeTelegramChannel()]);
    mockSendGateNotification.mockResolvedValue(42);
  });

  it('delivers gate notification even during quiet hours (gates require action)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T02:00:00Z')); // 02:00 UTC — within 23:00-08:00

    const user = makeUser({
      channels: { telegram: { platformId: '12345', verified: true, linkedAt: '' } },
      notifications: {
        channels: [],
        preferences: {
          gates: true, completions: true, failures: true,
          quietHours: { start: '23:00', end: '08:00' },
        },
      },
    });
    mockGetAll.mockReturnValue([user]);

    await notifyGate({
      workflowName: 'test-workflow',
      stepId: 'approval-gate',
      runId: 'run-1',
      previousOutput: null,
      projectId: 'proj-1',
    });

    // Gate should still be delivered despite quiet hours
    expect(mockSendGateNotification).toHaveBeenCalledWith(
      '12345',
      expect.any(String),
      'run-1',
      'approval-gate',
    );
    vi.useRealTimers();
  });
});

// ── Callback URL delivery ────────────────────────────────────────────

describe('deliverToUser — callback URL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUsersForProject.mockReturnValue([]);
    mockGetEnabled.mockReturnValue([]); // No system channels
  });

  it('delivers via callback URL for operator users regardless of system channels', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const user = makeUser({
      type: 'operator',
      linkedAccounts: { callbackUrl: 'https://example.com', hooksToken: 'tok-123' },
    });
    mockGetAll.mockReturnValue([user]);

    await notifyCompletion({
      workflowName: 'test-workflow',
      runId: 'run-1',
      status: 'completed',
      projectId: 'proj-1',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/armada/notify',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer tok-123' }),
      }),
    );

    vi.unstubAllGlobals();
  });
});
